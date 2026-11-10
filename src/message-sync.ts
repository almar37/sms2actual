import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { EventStore, StoredEvent } from './db.js';
import type {
  ActualAdapter,
  HistoricalTransaction,
  ParsedTransaction,
  ResolvedConfig,
  TxKind,
} from './types.js';
import { stableId } from './transaction-id.js';
import { merchantKey } from './merchant-resolver.js';
import { resolveAccount } from './routing.js';

export interface MessageEdit {
  kind: TxKind;
  accountId: string;
  amountCents: number;
  feeCents: number;
  payee: string;
  categoryId?: string;
  targetAccountId?: string;
  occurredAt: string;
  notes?: string;
}
export interface MessageActualState {
  revision: string;
  principal: HistoricalTransaction;
  fee?: HistoricalTransaction;
  combinedFee: boolean;
  form: MessageEdit;
}
const isTransfer = (kind: TxKind) => ['transfer_in', 'transfer_out', 'card_payment'].includes(kind);
const revision = (principal: HistoricalTransaction, fee?: HistoricalTransaction) =>
  createHash('sha256')
    .update(JSON.stringify([principal, fee ?? null]))
    .digest('hex');

/** Match only recorded transaction IDs or deterministic import IDs, never merchant/amount guesses. */
export async function readMessageActual(
  actual: ActualAdapter,
  store: EventStore,
  config: ResolvedConfig,
  event: StoredEvent,
): Promise<MessageActualState> {
  if (!event.parsed) throw new Error('This message has no transaction details to link');
  const tx = JSON.parse(event.parsed) as ParsedTransaction;
  await actual.sync();
  const accounts = await actual.accounts();
  const rows = (
    await Promise.all(
      accounts.map((account) => actual.transactions(account.id, '1900-01-01', '9999-12-31')),
    )
  ).flat();
  const override = store.db
    .prepare('SELECT value FROM console_overrides WHERE event_id=?')
    .get(event.id) as { value: string } | undefined;
  const account = override
    ? config.accounts.find((a) => a.id === JSON.parse(override.value).accountId)
    : resolveAccount(config.accounts, tx);
  const importIds = account
    ? [stableId(tx, account.key), stableId(tx, account.key, 'principal')]
    : [];
  let principal = event.actual_transaction_id
    ? rows.find((row) => row.id === event.actual_transaction_id)
    : undefined;
  if (event.actual_transaction_id && !principal)
    throw new Error('The linked transaction was deleted or its account is closed in Actual');
  if (!principal) {
    const matches = rows.filter((row) => row.importedId && importIds.includes(row.importedId));
    if (matches.length > 1) throw new Error('Multiple Actual transactions match this message');
    principal = matches[0];
  }
  // A second SMS for a linked transfer can refer to the opposite Actual entry.
  if (!principal) {
    const pair = store.db
      .prepare('SELECT matched_event_id FROM transfers WHERE event_id=?')
      .get(event.id) as { matched_event_id: string | null } | undefined;
    const other = pair?.matched_event_id ? store.get(pair.matched_event_id) : undefined;
    const deletedImports = pair?.matched_event_id
      ? store.deletedImportIds(pair.matched_event_id)
      : [];
    const archivedTransfers = rows.filter(
      (row) => row.transferId && row.importedId && deletedImports.includes(row.importedId),
    );
    if (archivedTransfers.length > 1)
      throw new Error('Multiple Actual transfer entries match the deleted SMS');
    const opposite =
      rows.find(
        (row) =>
          row.id ===
          (other?.actual_transaction_id ??
            (pair?.matched_event_id ? store.deletedLink(pair.matched_event_id) : undefined)),
      ) ?? archivedTransfers[0];
    principal = rows.find(
      (row) => row.id === opposite?.transferId && (!account || row.accountId === account.id),
    );
  }
  if (!principal)
    throw new Error('No corresponding Actual transaction was found. Nothing will be reimported');
  const feeImportIds = [
    account ? stableId(tx, account.key, 'fee') : '',
    `sms-edit:${event.id}:fee`,
  ];
  const fees = rows.filter((row) =>
    tx.importedFeeId
      ? row.id === tx.importedFeeId
      : row.importedId && feeImportIds.includes(row.importedId),
  );
  if (fees.length > 1) throw new Error('Multiple fee transactions match this message');
  const fee = fees[0];
  const combinedFee = Boolean(
    !fee &&
    tx.feeCents &&
    principal.amount === tx.amountCents &&
    principal.amount !== tx.principalCents,
  );
  if ((tx.importedFeeId || tx.feeCents) && !fee && !combinedFee)
    throw new Error('The linked fee transaction is missing in Actual');
  if (principal.isSplit || fee?.isSplit)
    throw new Error('Edit split transactions in Actual to preserve their individual splits');
  if (principal.amount === undefined || (fee && fee.amount === undefined))
    throw new Error('Actual did not return the transaction amount');
  const amount = principal.amount + (combinedFee && principal.amount < 0 ? tx.feeCents : 0);
  const kind: TxKind = principal.transferAccountId
    ? amount > 0
      ? 'transfer_in'
      : tx.kind === 'card_payment'
        ? 'card_payment'
        : 'transfer_out'
    : isTransfer(tx.kind)
      ? amount > 0
        ? 'transfer_in'
        : 'transfer_out'
      : amount > 0
        ? ['refund', 'deposit'].includes(tx.kind)
          ? tx.kind
          : 'refund'
        : ['purchase', 'fee', 'withdrawal'].includes(tx.kind)
          ? tx.kind
          : 'purchase';
  const oldTime = DateTime.fromISO(tx.occurredAt).setZone('Asia/Riyadh').toFormat('HH:mm:ss');
  return {
    revision: revision(principal, fee),
    principal,
    fee,
    combinedFee,
    form: {
      kind,
      accountId: principal.accountId,
      amountCents: Math.abs(amount),
      feeCents: fee ? Math.abs(fee.amount!) : combinedFee ? tx.feeCents : 0,
      payee: principal.payeeName ?? tx.payee,
      categoryId: principal.categoryId,
      targetAccountId: principal.transferAccountId,
      occurredAt: DateTime.fromISO(`${principal.date}T${oldTime}`, {
        zone: 'Asia/Riyadh',
      }).toISO()!,
      notes: principal.notes ?? '',
    },
  };
}

export async function saveMessageActual(
  actual: ActualAdapter,
  store: EventStore,
  config: ResolvedConfig,
  event: StoredEvent,
  edit: MessageEdit,
  expectedRevision: string,
) {
  if (store.pendingDeletion(event.id))
    throw new Error('Finish deleting this message before editing it');
  if (!actual.updateTransactions) throw new Error('Actual transaction editing is unavailable');
  const state = await readMessageActual(actual, store, config, event);
  if (state.revision !== expectedRevision)
    throw new Error('The transaction changed in Actual. Reopen this message before saving');
  const linked = isTransfer(edit.kind) && Boolean(edit.targetAccountId);
  const positive = ['deposit', 'refund', 'transfer_in'].includes(edit.kind);
  const principalAmount = (positive ? 1 : -1) * edit.amountCents;
  const tx = JSON.parse(event.parsed!) as ParsedTransaction;
  let feeId = state.fee?.id;
  if (edit.feeCents && !feeId && (!state.combinedFee || linked)) {
    const imported = await actual.importTransactions(edit.accountId, [
      {
        date: edit.occurredAt.slice(0, 10),
        amount: -edit.feeCents,
        payee_name: 'Bank Fees',
        category: linked ? config.bankFeesCategoryId : edit.categoryId,
        notes: edit.notes ?? '',
        imported_id: `sms-edit:${event.id}:fee`,
      },
    ]);
    if (imported.errors.length)
      throw new Error(imported.errors.map((error) => error.message).join('; '));
    feeId = imported.added[0] ?? imported.updated[0];
    if (!feeId)
      throw new Error('Could not confirm the fee transaction in Actual. Reopen the message');
    // Keep the link even if a later update or sync fails, so retries cannot add another fee.
    tx.importedFeeId = feeId;
    store.update(event.id, event.status, { parsed: tx });
  }
  const categoryId = linked ? null : edit.categoryId || null;
  const updates = [
    {
      id: state.principal.id,
      accountId: edit.accountId,
      date: edit.occurredAt.slice(0, 10),
      amount: state.combinedFee && !linked ? principalAmount - edit.feeCents : principalAmount,
      payeeName: edit.payee,
      transferAccountId: linked ? edit.targetAccountId : undefined,
      categoryId,
      notes: edit.notes ?? '',
    },
  ];
  if (feeId)
    updates.push({
      id: feeId,
      accountId: edit.accountId,
      date: edit.occurredAt.slice(0, 10),
      amount: -edit.feeCents,
      payeeName: 'Bank Fees',
      transferAccountId: undefined,
      categoryId: linked ? config.bankFeesCategoryId : categoryId,
      notes: edit.notes ?? '',
    });
  await actual.updateTransactions(updates);
  await actual.sync();
  const transaction: ParsedTransaction = {
    ...tx,
    bank: config.accounts.find((a) => a.id === edit.accountId)!.match.bank,
    kind: edit.kind,
    amountCents: principalAmount - edit.feeCents,
    principalCents: isTransfer(edit.kind) ? principalAmount : undefined,
    feeCents: edit.feeCents,
    payee: edit.payee,
    occurredAt: edit.occurredAt,
    note: edit.notes ?? '',
    foreign: undefined,
    balanceCents: undefined,
    explicitTransferAccountId: isTransfer(edit.kind) ? edit.targetAccountId || null : undefined,
    transferCounterpartyAlias: undefined,
    billPaymentIdentifier: undefined,
    cardPaymentReceived: undefined,
    assumedFundingAccountId: undefined,
    importCategoryId: categoryId,
    importedFeeId: feeId,
  };
  store.db.transaction(() => {
    store.db
      .prepare(
        'INSERT INTO console_overrides(event_id,value) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET value=excluded.value',
      )
      .run(
        event.id,
        JSON.stringify({
          transaction,
          accountId: edit.accountId,
          categoryId: edit.categoryId,
          merchant: tx.payee,
        }),
      );
    store.update(event.id, 'imported', {
      parsed: transaction,
      actualTransactionId: state.principal.id,
    });
    store.recordEnrichment(event.id, 'user_actual_update', {
      categoryId,
      transactionId: state.principal.id,
      feeTransactionId: feeId,
    });
    if (edit.categoryId && !linked)
      store.putLocalMapping({
        account_id: edit.accountId,
        merchant_key: merchantKey(tx.payee),
        payee: edit.payee,
        category_id: edit.categoryId,
        source_ref: `console-review:${event.id}`,
        decision_at: new Date().toISOString(),
      });
  })();
}
