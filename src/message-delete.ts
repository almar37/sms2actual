import { createHash } from 'node:crypto';
import type { EventStore, StoredEvent } from './db.js';
import type {
  ActualAdapter,
  HistoricalTransaction,
  ParsedTransaction,
  ResolvedConfig,
} from './types.js';
import { stableId } from './transaction-id.js';

export const messageRevision = (event: StoredEvent) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        event.id,
        event.updated_at,
        event.status,
        event.parsed,
        event.actual_transaction_id,
      ]),
    )
    .digest('hex');

export function messageImportIds(config: ResolvedConfig, event: StoredEvent): string[] {
  if (!event.parsed) return [];
  const tx = JSON.parse(event.parsed) as ParsedTransaction;
  return [
    ...new Set(
      config.accounts
        .flatMap((a) => [a.key, a.id])
        .flatMap((key) => [
          stableId(tx, key),
          stableId(tx, key, 'principal'),
          stableId(tx, key, 'fee'),
        ]),
    ),
    `sms-edit:${event.id}:fee`,
  ];
}

export interface MessageDeletionPlan {
  eventRevision: string;
  revision: string;
  transactionIds: string[];
  transactions: {
    id: string;
    accountName?: string;
    payee?: string;
    amount?: number;
    date?: string;
  }[];
  linkedTransfer: boolean;
  includesSplits: boolean;
}

/** Use only service import IDs, stored links and Actual's own transfer links. */
export async function planMessageDeletion(
  actual: ActualAdapter,
  store: EventStore,
  config: ResolvedConfig,
  event: StoredEvent,
): Promise<MessageDeletionPlan> {
  const ids = new Set(store.pendingDeletion(event.id) ?? []);
  let rows: HistoricalTransaction[] = [];
  let accounts: { id: string; name: string }[] = [];
  if (event.parsed || event.actual_transaction_id || ids.size) {
    await actual.sync();
    accounts = await actual.accounts();
    rows = (
      await Promise.all(accounts.map((a) => actual.transactions(a.id, '1900-01-01', '9999-12-31')))
    ).flat();
  }
  const keys = [...new Set([...config.accounts.map((a) => a.key), ...accounts.map((a) => a.id)])];
  const find = (importIds: string[]) =>
    rows.filter((r) => r.importedId && importIds.includes(r.importedId));
  let principal: HistoricalTransaction | undefined;
  if (event.actual_transaction_id) {
    ids.add(event.actual_transaction_id);
    principal = rows.find((r) => r.id === event.actual_transaction_id);
  } else if (event.parsed) {
    const tx = JSON.parse(event.parsed) as ParsedTransaction;
    const candidates = find(
      keys.flatMap((key) => [stableId(tx, key), stableId(tx, key, 'principal')]),
    );
    if (candidates.length > 1)
      throw new Error(
        'Multiple Actual transactions match this SMS. Delete them in Actual or keep them.',
      );
    principal = candidates[0];
    if (principal) ids.add(principal.id);
  }
  const pair = store.db
    .prepare('SELECT matched_event_id FROM transfers WHERE event_id=?')
    .get(event.id) as { matched_event_id: string | null } | undefined;
  const other = pair?.matched_event_id ? store.get(pair.matched_event_id) : undefined;
  const archivedImports = pair?.matched_event_id
    ? store.deletedImportIds(pair.matched_event_id)
    : [];
  const otherImports = other ? messageImportIds(config, other) : archivedImports;
  const otherCandidates = find(otherImports).filter((row) => row.transferId);
  if (otherCandidates.length > 1)
    throw new Error(
      'Multiple linked transfer entries match the other SMS. Delete them in Actual or keep them.',
    );
  const otherId =
    other?.actual_transaction_id ??
    (pair?.matched_event_id ? store.deletedLink(pair.matched_event_id) : undefined) ??
    otherCandidates[0]?.id;
  let pairedActual = Boolean(principal?.transferId && principal.transferId === otherId);
  if (!principal && otherId) {
    const opposite = rows.find((r) => r.id === otherId);
    if (opposite?.transferId) {
      ids.add(otherId);
      ids.add(opposite.transferId);
      principal = rows.find((r) => r.id === opposite.transferId);
      pairedActual = true;
    }
  }
  if (pairedActual && pair?.matched_event_id) {
    for (const id of store.deletedTransactionIds(pair.matched_event_id)) ids.add(id);
    for (const row of find(archivedImports)) ids.add(row.id);
  }
  for (const linkedEvent of [event, ...(pairedActual ? [other] : [])]) {
    if (!linkedEvent?.parsed) continue;
    const tx = JSON.parse(linkedEvent.parsed) as ParsedTransaction;
    if (tx.importedFeeId) {
      ids.add(tx.importedFeeId);
      continue;
    }
    const feeIds = [
      ...keys.map((key) => stableId(tx, key, 'fee')),
      `sms-edit:${linkedEvent.id}:fee`,
    ];
    const fees = find(feeIds);
    if (fees.length > 1)
      throw new Error('Multiple fee entries match this SMS. Delete them in Actual or keep them.');
    for (const fee of fees) ids.add(fee.id);
  }
  let linkedTransfer = false;
  for (const row of rows)
    if (ids.has(row.id) && row.transferId) {
      ids.add(row.transferId);
      linkedTransfer = true;
    }
  const transactionIds = [...ids].sort();
  const eventRevision = messageRevision(event);
  const revision = createHash('sha256')
    .update(
      JSON.stringify([
        eventRevision,
        transactionIds.map((id) => [id, rows.find((r) => r.id === id) ?? null]),
      ]),
    )
    .digest('hex');
  return {
    eventRevision,
    revision,
    transactionIds,
    linkedTransfer,
    includesSplits: rows.some((r) => ids.has(r.id) && r.isSplit),
    transactions: transactionIds.map((id) => {
      const row = rows.find((r) => r.id === id);
      return {
        id,
        payee: row?.payeeName,
        amount: row?.amount,
        date: row?.date,
        accountName: accounts.find((a) => a.id === row?.accountId)?.name,
      };
    }),
  };
}

export async function deleteMessageActual(
  actual: ActualAdapter,
  store: EventStore,
  config: ResolvedConfig,
  event: StoredEvent,
  expectedRevision: string,
) {
  if (!actual.deleteTransactions) throw new Error('Actual transaction deletion is unavailable');
  const plan = await planMessageDeletion(actual, store, config, event);
  if (plan.revision !== expectedRevision)
    throw new Error(
      'The linked Actual entries changed. Refresh the deletion confirmation before continuing.',
    );
  // Hold this SMS out of the queue until deletion is completed, even after a restart or partial SDK failure.
  const current = store.get(event.id);
  if (!current || messageRevision(current) !== messageRevision(event))
    throw new Error('The message changed. Refresh the deletion confirmation.');
  store.beginDeletion(event.id, plan.transactionIds);
  await actual.deleteTransactions(plan.transactionIds);
  await actual.sync();
  const remaining = (
    await Promise.all(
      (await actual.accounts()).map((a) => actual.transactions(a.id, '1900-01-01', '9999-12-31')),
    )
  ).flat();
  if (remaining.some((r) => plan.transactionIds.includes(r.id)))
    throw new Error(
      'Actual still contains linked entries. The SMS was kept; refresh and retry deletion.',
    );
  store.deleteMessage(event.id, undefined, plan.transactionIds, messageImportIds(config, event));
  return plan.transactionIds.length;
}
