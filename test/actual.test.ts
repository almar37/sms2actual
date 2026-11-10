import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActualApiAdapter } from '../src/actual.js';

const sdk = vi.hoisted(() => ({
  getPayees: vi.fn(async () => [
    { id: 'existing-payee', name: 'Air Arabia', transfer_acct: undefined as string | undefined },
    { id: 'transfer-credit', name: 'Transfer', transfer_acct: 'credit' },
  ]),
  createPayee: vi.fn(async (_payee: { name: string }) => 'new-payee'),
  deleteTransaction: vi.fn(async (_id: string) => []),
  updateTransaction: vi.fn(async (_id: string, _fields: unknown) => []),
  batchBudgetUpdates: vi.fn(async (work: () => Promise<void>) => work()),
  getAccountBalance: vi.fn<(id: string, cutoff?: Date) => Promise<number>>(),
}));
vi.mock('../src/actual-sdk.js', () => ({ loadActualApi: async () => sdk }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const adapter = new ActualApiAdapter({
  serverURL: 'http://unused',
  password: 'unused',
  syncId: 'unused',
  dataDir: '/unused',
});
describe('Actual balance cutoff', () => {
  it.each([
    ['2026-11-05T20:59:00Z', 5],
    ['2026-11-05T21:01:00Z', 6],
  ])('includes the current Riyadh calendar day at %s', async (instant, day) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
    sdk.getAccountBalance.mockResolvedValue(12345);
    expect(await adapter.accountBalance('checking')).toBe(12345);
    const cutoff = sdk.getAccountBalance.mock.calls[0]?.[1];
    expect(cutoff).toBeInstanceOf(Date);
    // The SDK's cutoff reads host-local date fields, not the Date's UTC day.
    expect([cutoff?.getFullYear(), cutoff?.getMonth(), cutoff?.getDate()]).toEqual([2026, 10, day]);
  });
  it('uses the overview snapshot date even if the clock advances before the balance is read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T21:01:00Z'));
    sdk.getAccountBalance.mockResolvedValue(12345);
    await adapter.accountBalance('checking', '2026-11-06');
    const cutoff = sdk.getAccountBalance.mock.calls[0]?.[1];
    expect([cutoff?.getFullYear(), cutoff?.getMonth(), cutoff?.getDate()]).toEqual([2026, 10, 6]);
  });
});

describe('Actual transaction updates', () => {
  it('updates existing IDs with resolved payees, explicit category clearing, and notes', async () => {
    await adapter.updateTransactions([
      {
        id: 'tx-1',
        accountId: 'checking',
        date: '2026-11-07',
        amount: -94570,
        payeeName: 'Air Arabia',
        categoryId: null,
        notes: 'Flight',
      },
      {
        id: 'tx-2',
        accountId: 'checking',
        date: '2026-11-07',
        amount: -29,
        payeeName: 'Bank Fees',
        categoryId: 'bills',
        notes: 'Fee',
      },
    ]);
    expect(sdk.updateTransaction).toHaveBeenNthCalledWith(
      1,
      'tx-1',
      expect.objectContaining({ category: null, payee: 'existing-payee', notes: 'Flight' }),
    );
    expect(sdk.updateTransaction).toHaveBeenNthCalledWith(
      2,
      'tx-2',
      expect.objectContaining({ category: 'bills', payee: 'new-payee' }),
    );
    expect(sdk.createPayee).toHaveBeenCalledWith({ name: 'Bank Fees' });
    expect(sdk.batchBudgetUpdates).toHaveBeenCalledTimes(1);
  });
  it('uses the SDK transfer payee so Actual maintains the linked entry', async () => {
    await adapter.updateTransactions([
      {
        id: 'tx',
        accountId: 'checking',
        date: '2026-11-07',
        amount: -20000,
        payeeName: 'Ignored transfer label',
        transferAccountId: 'credit',
        categoryId: null,
        notes: '',
      },
    ]);
    expect(sdk.updateTransaction).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({ payee: 'transfer-credit', category: null }),
    );
    expect(sdk.createPayee).not.toHaveBeenCalled();
  });
});

it('changes only payee IDs during a merchant rename, preserving transaction details', async () => {
  await adapter.updatePayees(['sms-one', 'sms-two'], 'Air Arabia');
  expect(sdk.updateTransaction.mock.calls).toEqual([
    ['sms-one', { payee: 'existing-payee' }],
    ['sms-two', { payee: 'existing-payee' }],
  ]);
  expect(sdk.createPayee).not.toHaveBeenCalled();
});

it('deletes each linked transaction ID once through the SDK batch', async () => {
  await adapter.deleteTransactions(['principal', 'fee', 'principal']);
  expect(sdk.deleteTransaction.mock.calls).toEqual([['principal'], ['fee']]);
  expect(sdk.batchBudgetUpdates).toHaveBeenCalledTimes(1);
});
