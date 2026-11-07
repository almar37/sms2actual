import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../src/db.js';
import { ConsoleConfig } from '../src/console-config.js';
import { readMessageActual, saveMessageActual } from '../src/message-sync.js';
import { stableId } from '../src/transaction-id.js';
import type {
  ActualAdapter,
  ActualTransactionUpdate,
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
const now = '2026-11-07T22:09:00+03:00';
function fixture(fee = 0) {
  const store = new EventStore(':memory:');
  stores.push(store);
  new ConsoleConfig(store, 'test-secret-for-message-sync');
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
    amountCents: -(20000 + fee),
    principalCents: fee ? -20000 : undefined,
    feeCents: fee,
    payee: 'SMS merchant',
    occurredAt: now,
    note: 'Parsed sab purchase',
  };
  const { id } = store.enqueue({
    sender: 'SAB',
    message: 'Original SMS is immutable',
    receivedAt: now,
  });
  store.update(id, 'imported', { parsed: tx, actualTransactionId: 'principal-id' });
  const rows: HistoricalTransaction[] = [
    {
      id: 'principal-id',
      accountId: 'checking',
      amount: -20000,
      date: '2026-11-07',
      payeeName: 'Merchant edited in Actual',
      categoryId: 'bills',
      notes: 'Actual notes',
    },
  ];
  if (fee)
    rows.push({
      id: 'fee-id',
      accountId: 'checking',
      amount: -fee,
      date: '2026-11-07',
      payeeName: 'Bank Fees',
      importedId: stableId(tx, 'checking', 'fee'),
      categoryId: 'bills',
      notes: 'Actual notes',
    });
  const updateTransactions = vi.fn(async (updates: ActualTransactionUpdate[]) => {
    for (const update of updates)
      Object.assign(
        rows.find((row) => row.id === update.id)!,
        {
          accountId: update.accountId,
          date: update.date,
          amount: update.amount,
          payeeName: update.payeeName,
          categoryId: update.categoryId ?? undefined,
          notes: update.notes,
          transferAccountId: update.transferAccountId,
        },
      );
  });
  const importTransactions = vi.fn<ActualAdapter['importTransactions']>(
    async (accountId, transactions) => {
      rows.push(
        ...transactions.map((transaction) => ({
          id: 'new-fee-id',
          accountId,
          amount: transaction.amount,
          date: transaction.date,
          importedId: transaction.imported_id,
          categoryId: transaction.category,
          notes: transaction.notes,
          payeeName: transaction.payee_name,
        })),
      );
      return { added: ['new-fee-id'], updated: [], errors: [] };
    },
  );
  const actual: ActualAdapter = {
    initialize: async () => {},
    shutdown: async () => {},
    serverVersion: async () => '26.9.0',
    sync: vi.fn(async () => {}),
    accounts: async () => config.accounts.map(({ id, name }) => ({ id, name })),
    categories: async () => [],
    transactions: async (accountId) => rows.filter((row) => row.accountId === accountId),
    transferPayee: async () => 'transfer-payee',
    importTransactions,
    updateTransactions,
  };
  return {
    store,
    config,
    actual,
    rows,
    id,
    tx,
    importTransactions,
    updateTransactions,
    read: () => readMessageActual(actual, store, config, store.get(id)!),
    save: (edit: Parameters<typeof saveMessageActual>[4], revision: string) =>
      saveMessageActual(actual, store, config, store.get(id)!, edit, revision),
  };
}
describe('message to Actual synchronization', () => {
  it('loads current Actual fields and updates the same transaction without reimporting', async () => {
    const f = fixture();
    const before = await f.read();
    expect(before.form).toMatchObject({
      categoryId: 'bills',
      payee: 'Merchant edited in Actual',
      notes: 'Actual notes',
      amountCents: 20000,
    });
    const raw = f.store.get(f.id)!.payload;
    await f.save(
      {
        ...before.form,
        accountId: 'credit',
        categoryId: 'travel',
        payee: 'Air Arabia',
        amountCents: 94570,
        occurredAt: '2026-11-08T10:00:00+03:00',
        notes: 'Flight\nFamily visit',
      },
      before.revision,
    );
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({
      id: 'principal-id',
      accountId: 'credit',
      amount: -94570,
      categoryId: 'travel',
      payeeName: 'Air Arabia',
      date: '2026-11-08',
      notes: 'Flight\nFamily visit',
    });
    expect(f.importTransactions).not.toHaveBeenCalled();
    expect(f.store.get(f.id)?.payload).toBe(raw);
    expect(JSON.parse(f.store.get(f.id)!.parsed!).importCategoryId).toBe('travel');
    const reopened = await f.read();
    expect(reopened.form).toMatchObject({
      accountId: 'credit',
      categoryId: 'travel',
      payee: 'Air Arabia',
    });
    await f.save({ ...reopened.form, categoryId: undefined, notes: '' }, reopened.revision);
    expect(f.rows[0]).toMatchObject({ categoryId: undefined, notes: '' });
    expect(f.rows).toHaveLength(1);
  });
  it('rejects stale forms before any mutation', async () => {
    const f = fixture();
    const before = await f.read();
    f.rows[0]!.notes = 'Changed by another Actual client';
    await expect(f.save({ ...before.form, categoryId: 'travel' }, before.revision)).rejects.toThrow(
      'changed in Actual',
    );
    expect(f.updateTransactions).not.toHaveBeenCalled();
    expect(f.importTransactions).not.toHaveBeenCalled();
  });
  it('never recreates a deleted linked transaction', async () => {
    const f = fixture();
    const before = await f.read();
    f.rows.length = 0;
    await expect(f.save(before.form, before.revision)).rejects.toThrow('deleted');
    expect(f.importTransactions).not.toHaveBeenCalled();
    expect(f.updateTransactions).not.toHaveBeenCalled();
  });
  it('updates both external transfer entries in the same category', async () => {
    const f = fixture(29);
    const before = await f.read();
    await f.save(
      {
        ...before.form,
        categoryId: 'water',
        amountCents: 30000,
        feeCents: 57,
        notes: 'Water bill',
      },
      before.revision,
    );
    expect(f.rows).toHaveLength(2);
    expect(f.rows[0]).toMatchObject({ amount: -30000, categoryId: 'water', notes: 'Water bill' });
    expect(f.rows[1]).toMatchObject({ amount: -57, categoryId: 'water', notes: 'Water bill' });
    expect(f.importTransactions).not.toHaveBeenCalled();
  });
  it('preserves a combined legacy debit without creating a second fee', async () => {
    const f = fixture(29);
    f.rows.pop();
    f.rows[0]!.amount = -20029;
    const before = await f.read();
    expect(before.combinedFee).toBe(true);
    await f.save({ ...before.form, categoryId: 'water', feeCents: 57 }, before.revision);
    expect(f.rows[0]).toMatchObject({ amount: -20057, categoryId: 'water' });
    expect(f.importTransactions).not.toHaveBeenCalled();
  });
  it('keeps a linked transfer uncategorized and uses Bank Fees for its fee', async () => {
    const f = fixture(29);
    const before = await f.read();
    await f.save(
      { ...before.form, targetAccountId: 'credit', categoryId: undefined },
      before.revision,
    );
    expect(f.updateTransactions.mock.calls[0]![0][0]).toMatchObject({
      id: 'principal-id',
      transferAccountId: 'credit',
      categoryId: null,
    });
    expect(f.rows[1]?.categoryId).toBe('fees');
  });
  it('finds an older fee by import ID and stops if that fee is missing', async () => {
    const f = fixture(29);
    expect((await f.read()).fee?.id).toBe('fee-id');
    f.rows.pop();
    await expect(f.read()).rejects.toThrow('fee transaction is missing');
  });
  it('retains a new fee link if a later write fails, so retrying cannot duplicate it', async () => {
    const f = fixture();
    const before = await f.read();
    f.updateTransactions.mockRejectedValueOnce(new Error('Write failed'));
    const edit = { ...before.form, kind: 'transfer_out' as const, feeCents: 29 };
    await expect(f.save(edit, before.revision)).rejects.toThrow('Write failed');
    expect(JSON.parse(f.store.get(f.id)!.parsed!).importedFeeId).toBe('new-fee-id');
    const reopened = await f.read();
    await f.save(edit, reopened.revision);
    expect(f.importTransactions).toHaveBeenCalledTimes(1);
    expect(f.rows).toHaveLength(2);
  });
  it('does not overwrite split transactions', async () => {
    const f = fixture();
    f.rows[0]!.isSplit = true;
    await expect(f.read()).rejects.toThrow('split transactions');
    expect(f.updateTransactions).not.toHaveBeenCalled();
  });
  it('links a counterpart SMS to the opposite side of the Actual transfer', async () => {
    const f = fixture();
    f.store.db.prepare('UPDATE events SET actual_transaction_id=NULL WHERE id=?').run(f.id);
    const other = f.store.enqueue({ sender: 'SAB', message: 'Other side', receivedAt: now });
    f.store.update(other.id, 'imported', { actualTransactionId: 'opposite-id' });
    f.store.recordTransfer(f.id, 'checking', '5678', -20000, now, other.id);
    f.rows.push({
      id: 'opposite-id',
      accountId: 'credit',
      transferId: 'principal-id',
      date: '2026-11-07',
      amount: 20000,
    });
    expect((await f.read()).principal.id).toBe('principal-id');
  });
});
