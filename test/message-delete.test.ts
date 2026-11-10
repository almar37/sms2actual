import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../src/db.js';
import { ConsoleConfig } from '../src/console-config.js';
import {
  deleteMessageActual,
  messageImportIds,
  planMessageDeletion,
} from '../src/message-delete.js';
import { readMessageActual } from '../src/message-sync.js';
import { stableId } from '../src/transaction-id.js';
import type {
  ActualAdapter,
  HistoricalTransaction,
  ParsedTransaction,
  ResolvedConfig,
} from '../src/types.js';
import { banks, parsing } from './fixtures/banks.js';
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});
const now = '2026-11-10T10:00:00+03:00';
function fixture(fee = 0) {
  const store = new EventStore(':memory:');
  stores.push(store);
  const settings = new ConsoleConfig(store, 'deletion-test-secret');
  const config: ResolvedConfig = {
    banks,
    parsing,
    accounts: [
      {
        id: 'checking',
        key: 'checking',
        name: 'Checking',
        match: { bank: 'sab', accountSuffixes: ['1234'] },
      },
      {
        id: 'credit',
        key: 'credit',
        name: 'Credit',
        match: { bank: 'sab', accountSuffixes: ['5678'] },
      },
    ],
    bankFeesCategoryId: 'fees',
    eligibleCategories: [],
  };
  const tx: ParsedTransaction = {
    bank: 'sab',
    kind: fee ? 'transfer_out' : 'purchase',
    accountAlias: '1234',
    amountCents: -2500 - fee,
    principalCents: fee ? -2500 : undefined,
    feeCents: fee,
    payee: 'Shop',
    occurredAt: now,
    note: 'Original',
  };
  const input = { eventId: 'delete-me', sender: 'SAB', message: 'Original SMS', receivedAt: now };
  const { id } = store.enqueue(input);
  store.update(id, 'imported', { parsed: tx, actualTransactionId: 'principal' });
  const rows: HistoricalTransaction[] = [
    {
      id: 'principal',
      accountId: 'checking',
      date: '2026-11-10',
      amount: -2500,
      payeeName: 'Shop',
    },
  ];
  if (fee)
    rows.push({
      id: 'fee',
      accountId: 'checking',
      date: '2026-11-10',
      amount: -fee,
      importedId: stableId(tx, 'checking', 'fee'),
    });
  const actual: ActualAdapter = {
    initialize: async () => {},
    shutdown: async () => {},
    serverVersion: async () => '26.9.0',
    sync: vi.fn(async () => {}),
    accounts: async () => config.accounts.map((a) => ({ id: a.id, name: a.name })),
    categories: async () => [],
    transactions: async (accountId) => rows.filter((row) => row.accountId === accountId),
    transferPayee: async () => '',
    importTransactions: vi.fn(async () => ({ added: [], updated: [], errors: [] })),
    deleteTransactions: vi.fn(async (ids) => {
      for (let i = rows.length - 1; i >= 0; i--) if (ids.includes(rows[i]!.id)) rows.splice(i, 1);
    }),
  };
  return {
    store,
    settings,
    config,
    tx,
    input,
    id,
    rows,
    actual,
    plan: () => planMessageDeletion(actual, store, config, store.get(id)!),
  };
}
describe('SMS deletion', () => {
  it('removes one SMS and its logs without touching Actual, preserves rules and allows restoration by resubmitting the SMS', async () => {
    const f = fixture();
    f.store.addBalance('checking', now, 5000, f.id);
    f.store.recordEnrichment(f.id, 'history_hit', { payee: 'Shop' });
    f.settings.set('limit:checking', { eventId: f.id, cents: 5000 });
    f.store.db.prepare('INSERT INTO console_overrides VALUES(?,?)').run(f.id, '{}');
    f.store.merchants.save(undefined, 'Shop', ['Shop'], 'food');
    const checkpoint = f.store.startInboxSync();
    f.store.deleteMessage(f.id);
    expect(f.store.get(f.id)).toBeUndefined();
    expect(f.store.eventHistory(f.id)).toEqual([]);
    expect(f.store.enrichmentAttempts(f.id)).toEqual([]);
    expect(f.store.db.prepare('SELECT COUNT(*) n FROM balances').get()).toEqual({ n: 0 });
    expect(f.settings.get('limit:checking')).toBeUndefined();
    expect(f.store.merchants.find('Shop')?.category_id).toBe('food');
    expect(f.store.enqueue(f.input)).toEqual({ id: f.id, duplicate: false });
    expect(f.store.get(f.id)?.status).toBe('queued');
    expect(f.store.enqueue(f.input)).toEqual({ id: f.id, duplicate: true });
    f.store.deleteMessage(f.id);
    expect(f.store.get(f.id)).toBeUndefined();
    expect(f.store.inboxCheckpoint()).toEqual(checkpoint);
    expect(f.actual.deleteTransactions).not.toHaveBeenCalled();
    expect(f.rows).toHaveLength(1);
    f.store.resetSmsData();
    expect(f.store.enqueue(f.input).duplicate).toBe(false);
  });
  it('deletes only exact linked IDs including the fee, without matching unrelated amounts or names', async () => {
    const f = fixture(29);
    f.rows.push({ ...f.rows[0]!, id: 'unrelated' });
    const plan = await f.plan();
    expect(plan.transactionIds).toEqual(['fee', 'principal']);
    await deleteMessageActual(f.actual, f.store, f.config, f.store.get(f.id)!, plan.revision);
    expect(f.rows.map((r) => r.id)).toEqual(['unrelated']);
    expect(f.store.get(f.id)).toBeUndefined();
    expect(f.store.enqueue(f.input).duplicate).toBe(false);
  });
  it('blocks stale confirmation before mutation and allows missing entries to be cleaned up idempotently', async () => {
    const f = fixture(29);
    const before = await f.plan();
    f.rows[0]!.amount = -4000;
    await expect(
      deleteMessageActual(f.actual, f.store, f.config, f.store.get(f.id)!, before.revision),
    ).rejects.toThrow(/changed/);
    expect(f.actual.deleteTransactions).not.toHaveBeenCalled();
    expect(f.store.pendingDeletion(f.id)).toBeUndefined();
    f.rows.shift();
    const refreshed = await f.plan();
    await deleteMessageActual(f.actual, f.store, f.config, f.store.get(f.id)!, refreshed.revision);
    expect(f.rows).toEqual([]);
    expect(f.store.get(f.id)).toBeUndefined();
  });
  it('retains the SMS and blocks queue/replay after partial Actual failure until a retry completes', async () => {
    const f = fixture(29);
    f.store.update(f.id, 'queued', { parserRevision: 1 });
    const before = await f.plan();
    vi.mocked(f.actual.deleteTransactions!).mockImplementationOnce(async () => {
      f.rows.splice(0, 1);
      throw new Error('Actual write failed');
    });
    await expect(
      deleteMessageActual(f.actual, f.store, f.config, f.store.get(f.id)!, before.revision),
    ).rejects.toThrow(/write failed/);
    expect(f.store.get(f.id)).toBeDefined();
    expect(f.store.pendingDeletion(f.id)).toEqual(['fee', 'principal']);
    expect(f.store.claim()).toBeUndefined();
    expect(f.store.replayParserRevision(999)).toBe(0);
    const retry = await f.plan();
    await deleteMessageActual(f.actual, f.store, f.config, f.store.get(f.id)!, retry.revision);
    expect(f.rows).toEqual([]);
    expect(f.store.get(f.id)).toBeUndefined();
    expect(f.store.pendingDeletion(f.id)).toBeUndefined();
  });
  it('keeps the message if Actual reports success without removing the entries', async () => {
    const f = fixture();
    vi.mocked(f.actual.deleteTransactions!).mockResolvedValueOnce(undefined);
    await expect(
      deleteMessageActual(
        f.actual,
        f.store,
        f.config,
        f.store.get(f.id)!,
        (await f.plan()).revision,
      ),
    ).rejects.toThrow(/still contains/);
    expect(f.store.get(f.id)).toBeDefined();
  });
  it('preserves counterpart links when only one transfer SMS is deleted, then can delete the pair and its fee', async () => {
    const f = fixture(29);
    f.tx.importedFeeId = 'fee';
    f.store.update(f.id, 'imported', { parsed: f.tx });
    f.rows[0]!.transferId = 'opposite';
    f.rows[0]!.transferAccountId = 'credit';
    f.rows.push({
      id: 'opposite',
      accountId: 'credit',
      date: '2026-11-10',
      amount: 2500,
      transferId: 'principal',
      transferAccountId: 'checking',
    });
    const other = f.store.enqueue({
      sender: 'SAB',
      message: 'Incoming transfer SMS',
      receivedAt: now,
    });
    f.store.update(other.id, 'imported', {
      parsed: {
        ...f.tx,
        accountAlias: '5678',
        amountCents: 2500,
        principalCents: 2500,
        kind: 'transfer_in',
        feeCents: 0,
        importedFeeId: undefined,
      },
    });
    f.store.recordTransfer(f.id, 'checking', '5678', -2500, now, other.id);
    f.store.recordTransfer(other.id, 'credit', '1234', 2500, now, f.id);
    f.store.deleteMessage(f.id);
    expect(
      (await readMessageActual(f.actual, f.store, f.config, f.store.get(other.id)!)).principal.id,
    ).toBe('opposite');
    const plan = await planMessageDeletion(f.actual, f.store, f.config, f.store.get(other.id)!);
    expect(plan.linkedTransfer).toBe(true);
    expect(plan.transactionIds).toEqual(['fee', 'opposite', 'principal']);
    await deleteMessageActual(f.actual, f.store, f.config, f.store.get(other.id)!, plan.revision);
    expect(f.rows).toEqual([]);
  });
  it('does not include the other fee when transfer SMS messages correspond to independent Actual entries', async () => {
    const f = fixture(29);
    const other = f.store.enqueue({ message: 'Other SMS', receivedAt: now });
    f.store.update(other.id, 'imported', {
      parsed: { ...f.tx, importedFeeId: 'other-fee' },
      actualTransactionId: 'other-principal',
    });
    f.store.recordTransfer(f.id, 'checking', '5678', -2500, now, other.id);
    const plan = await f.plan();
    expect(plan.transactionIds).toEqual(['fee', 'principal']);
  });
  it('identifies split transactions in the confirmation and deletes the associated transaction', async () => {
    const f = fixture();
    f.rows[0]!.isSplit = true;
    const plan = await f.plan();
    expect(plan.includesSplits).toBe(true);
    await deleteMessageActual(f.actual, f.store, f.config, f.store.get(f.id)!, plan.revision);
    expect(f.rows).toEqual([]);
  });
});

it('retains opaque import links for legacy transfers when the original SMS has no recorded Actual ID', async () => {
  const f = fixture(29);
  f.store.db.prepare('UPDATE events SET actual_transaction_id=NULL WHERE id=?').run(f.id);
  f.rows[0]!.importedId = stableId(f.tx, 'checking', 'principal');
  f.rows[0]!.transferId = 'opposite';
  f.rows[0]!.transferAccountId = 'credit';
  f.rows.push({
    id: 'opposite',
    accountId: 'credit',
    date: '2026-11-10',
    amount: 2500,
    transferId: 'principal',
    transferAccountId: 'checking',
  });
  const other = f.store.enqueue({ message: 'Legacy incoming SMS', receivedAt: now });
  f.store.update(other.id, 'imported', {
    parsed: {
      ...f.tx,
      accountAlias: '5678',
      amountCents: 2500,
      principalCents: 2500,
      kind: 'transfer_in',
      feeCents: 0,
    },
  });
  f.store.recordTransfer(f.id, 'checking', '5678', -2500, now, other.id);
  f.store.recordTransfer(other.id, 'credit', '1234', 2500, now, f.id);
  const imports = messageImportIds(f.config, f.store.get(f.id)!);
  f.store.deleteMessage(f.id, undefined, [], imports);
  expect(
    (await readMessageActual(f.actual, f.store, f.config, f.store.get(other.id)!)).principal.id,
  ).toBe('opposite');
  const plan = await planMessageDeletion(f.actual, f.store, f.config, f.store.get(other.id)!);
  expect(plan.transactionIds).toEqual(['fee', 'opposite', 'principal']);
  await deleteMessageActual(f.actual, f.store, f.config, f.store.get(other.id)!, plan.revision);
  expect(f.rows).toEqual([]);
});
