import { banks, parsing } from './fixtures/banks.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../src/db.js';
import { merchantKey, MerchantResolver } from '../src/merchant-resolver.js';
import type { ActualAdapter, HistoricalTransaction, ResolvedConfig } from '../src/types.js';
import { parseSms } from '../src/parser.js';
import { stableId } from '../src/transaction-id.js';

const stores: EventStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});

const config: ResolvedConfig = {
  banks,
  parsing,
  accounts: [
    {
      key: 'checking',
      id: 'checking-id',
      name: 'Checking',
      match: { bank: 'sab', transactionKinds: ['purchase', 'refund'] },
    },
  ],
  bankFeesCategoryId: 'fees',
  eligibleCategories: [{ id: 'ai-only', name: 'AI only' }],
};

function setup(history: HistoricalTransaction[]) {
  const store = new EventStore(':memory:');
  stores.push(store);
  const actual: ActualAdapter = {
    initialize: async () => {},
    serverVersion: async () => '26.9.0',
    shutdown: async () => {},
    sync: vi.fn(async () => {}),
    accounts: async () => [],
    categories: async () => [
      { id: 'food', name: 'Food' },
      { id: 'shopping', name: 'Shopping' },
      { id: 'hidden', name: 'Hidden', hidden: true },
    ],
    transactions: async () => history,
    transferPayee: async () => '',
    importTransactions: async () => ({ added: [], updated: [], errors: [] }),
  };
  return { store, actual, resolver: new MerchantResolver(store, actual, config) };
}

describe('merchant history resolver', () => {
  it('normalizes exact descriptions and accepts active categories outside the AI list', async () => {
    const { resolver } = setup([
      {
        id: 'transaction-1',
        accountId: 'checking-id',
        date: '2026-08-20',
        importedPayee: '  SAMPLE—Books  ',
        payeeName: 'Sample Books',
        categoryId: 'shopping',
      },
    ]);
    await resolver.refresh();

    expect(merchantKey('sample books')).toBe('sample books');
    expect(resolver.lookup('checking-id', 'sample books')).toMatchObject({
      payee: 'Sample Books',
      category_id: 'shopping',
      source: 'actual',
    });
    expect(resolver.lookup('another-account', 'sample books')).toBeUndefined();
  });

  it('makes a newly observed Actual category correction authoritative', async () => {
    const history = [
      {
        id: 'transaction-1',
        accountId: 'checking-id',
        date: '2020-01-01',
        importedPayee: 'Cafe',
        payeeName: 'Cafe',
        categoryId: 'food',
      },
    ];
    const { resolver } = setup(history);
    await resolver.refresh();
    resolver.learnSuggestion(
      'checking-id',
      'Cafe',
      { payee: 'Cafe', categoryId: 'shopping', confidence: 0.9, reason: 'test' },
      'event-1',
      '2026-01-01T00:00:00.000Z',
    );
    history[0]!.categoryId = 'shopping';
    await resolver.refresh();

    expect(resolver.lookup('checking-id', 'Cafe')?.category_id).toBe('shopping');
    expect(resolver.lookup('checking-id', 'Cafe')?.source).toBe('actual');
  });

  it('ignores hidden categories', async () => {
    const { resolver } = setup([
      {
        id: 'transaction-1',
        accountId: 'checking-id',
        date: '2026-08-20',
        payeeName: 'Hidden merchant',
        categoryId: 'hidden',
      },
    ]);
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'Hidden merchant')).toBeUndefined();
  });

  it('retains AI suggestions for confirmation without reusing them', async () => {
    const { store, resolver } = setup([]);
    resolver.learnSuggestion(
      'checking-id',
      'MYSR*Jahe',
      { payee: 'Jahez', categoryId: 'food', confidence: 0.99, reason: 'guess' },
      'sms-1',
    );
    expect(store.mapping('checking-id', merchantKey('MYSR*Jahe'))?.source).toBe('ai');
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toBeUndefined();
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toBeUndefined();
  });

  it('keeps manual aliases ahead of newer AI and Actual observations', async () => {
    const history: HistoricalTransaction[] = [
      {
        id: 'actual-1',
        accountId: 'checking-id',
        date: '2026-10-01',
        importedPayee: 'MYSR*Jahe',
        payeeName: 'Wrong merchant',
        categoryId: 'shopping',
      },
    ];
    const { store, resolver } = setup(history);
    store.putLocalMapping({
      account_id: 'checking-id',
      merchant_key: merchantKey('MYSR*Jahe'),
      payee: 'Jahez',
      category_id: 'food',
      source_ref: 'console:alias',
      decision_at: '2020-01-01T00:00:00.000Z',
    });
    resolver.learnSuggestion(
      'checking-id',
      'MYSR*Jahe',
      { payee: 'Guess', categoryId: 'shopping', confidence: 0.99, reason: 'guess' },
      'sms-1',
    );
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toMatchObject({
      payee: 'Jahez',
      category_id: 'food',
      source: 'local',
    });
    history[0]!.categoryId = 'food';
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')?.payee).toBe('Jahez');
  });

  it('learns only corrections to service imports, including payee-only corrections', async () => {
    const history: HistoricalTransaction[] = [
      {
        id: 'sms-actual',
        importedId: 'sms:example',
        accountId: 'checking-id',
        date: '2026-10-01',
        importedPayee: 'MYSR*Jahe',
        payeeName: 'MYSR*Jahe',
        categoryId: 'food',
      },
    ];
    const { store, resolver } = setup(history);
    store.recordMerchantImport('sms:example', 'MYSR*Jahe', 'food');
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toBeUndefined();
    history[0]!.payeeName = 'Jahez';
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toMatchObject({
      payee: 'Jahez',
      source: 'actual',
      category_id: 'food',
    });
    history[0]!.categoryId = 'shopping';
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')?.category_id).toBe('shopping');
    history[0]!.payeeName = 'MYSR*Jahe';
    history[0]!.categoryId = 'food';
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toBeUndefined();
  });

  it('does not treat legacy imports without a baseline as confirmed history', async () => {
    const { resolver } = setup([
      {
        id: 'old-sms',
        importedId: 'sms:old',
        accountId: 'checking-id',
        date: '2026-10-01',
        importedPayee: 'MYSR*Jahe',
        payeeName: 'Wrong guess',
        categoryId: 'food',
      },
    ]);
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toBeUndefined();
  });

  it('reconstructs legacy import output without promoting its AI guess, then learns a correction', async () => {
    const history: HistoricalTransaction[] = [];
    const { store, resolver } = setup(history);
    const input = {
      eventId: 'legacy',
      sender: 'SAB',
      message: 'Purchase Card **1234 Amount SAR 20 at MYSR*Jahe',
      receivedAt: '2026-08-22T10:00:00Z',
    };
    const parsed = parseSms(input.message, input.receivedAt, banks, input.sender, parsing);
    if (parsed.type !== 'transaction') throw new Error('Expected legacy purchase');
    const { id } = store.enqueue(input);
    const suggestion = {
      payee: 'Wrong guess',
      categoryId: 'food',
      confidence: 0.9,
      reason: 'guess',
    };
    store.update(id, 'imported', {
      parsed: parsed.transaction,
      suggestion,
      actualTransactionId: 'legacy-actual',
    });
    store.recordEnrichment(id, 'llm_success', { payeeApplied: true, categoryApplied: true });
    resolver.learnSuggestion('checking-id', parsed.transaction.payee, suggestion, id);
    history.push({
      id: 'legacy-actual',
      importedId: stableId(parsed.transaction, 'checking'),
      accountId: 'checking-id',
      date: '2020-01-01',
      importedPayee: 'MYSR*Jahe',
      payeeName: 'Wrong guess',
      categoryId: 'food',
    });
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toBeUndefined();
    history[0]!.payeeName = 'Jahez';
    history.push({
      id: 'recent-history',
      accountId: 'checking-id',
      date: '2026-10-01',
      importedPayee: 'MYSR*Jahe',
      payeeName: 'Unrelated older choice',
      categoryId: 'shopping',
    });
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toMatchObject({
      payee: 'Jahez',
      category_id: 'food',
      source: 'actual',
    });
  });

  it.each(['legacy_success', 'llm_success'])(
    'does not infer a correction from incomplete %s audit data',
    async (status) => {
      const history: HistoricalTransaction[] = [];
      const { store, resolver } = setup(history);
      const parsed = parseSms(
        'Purchase Card **1234 Amount SAR 20 at MYSR*Jahe',
        '2026-08-22T10:00:00Z',
        banks,
        'SAB',
        parsing,
      );
      if (parsed.type !== 'transaction') throw new Error('Expected legacy purchase');
      const { id } = store.enqueue({
        message: 'Legacy purchase',
        receivedAt: '2026-08-22T10:00:00Z',
      });
      store.update(id, 'imported', {
        parsed: parsed.transaction,
        suggestion: { payee: 'Wrong guess', categoryId: 'food', confidence: 0.9, reason: 'guess' },
      });
      store.recordEnrichment(id, status, { legacy: true });
      history.push({
        id: 'legacy-actual',
        importedId: stableId(parsed.transaction, 'checking'),
        accountId: 'checking-id',
        date: '2026-08-22',
        importedPayee: 'MYSR*Jahe',
        payeeName: 'Wrong guess',
        categoryId: 'food',
      });
      await resolver.refresh();
      expect(resolver.lookup('checking-id', 'MYSR*Jahe')).toBeUndefined();
    },
  );

  it('recognizes a payee-only correction on an older Actual transaction', async () => {
    const history: HistoricalTransaction[] = [
      {
        id: 'older',
        accountId: 'checking-id',
        date: '2020-01-01',
        importedPayee: 'Cafe',
        payeeName: 'Cafe',
        categoryId: 'food',
      },
      {
        id: 'newer',
        accountId: 'checking-id',
        date: '2021-01-01',
        importedPayee: 'Cafe',
        payeeName: 'Wrong cafe',
        categoryId: 'food',
      },
    ];
    const { resolver } = setup(history);
    await resolver.refresh();
    history[0]!.payeeName = 'Correct cafe';
    await resolver.refresh();
    expect(resolver.lookup('checking-id', 'Cafe')?.payee).toBe('Correct cafe');
  });

  it.each(['Unknown merchant', 'Amazon sa 5/11/26 21:34', '   '])(
    'never reuses or learns %j',
    async (merchant) => {
      const { store, resolver } = setup([
        {
          id: 'bad',
          accountId: 'checking-id',
          date: '2026-10-01',
          importedPayee: merchant,
          payeeName: 'Wrong',
          categoryId: 'food',
        },
      ]);
      store.putMapping({
        account_id: 'checking-id',
        merchant_key: merchantKey(merchant),
        payee: 'Wrong',
        category_id: 'food',
        source: 'local',
        source_ref: 'console:bad',
        decision_at: new Date().toISOString(),
      });
      expect(resolver.lookup('checking-id', merchant)).toBeUndefined();
      await resolver.refresh();
      expect(resolver.lookup('checking-id', merchant)).toBeUndefined();
    },
  );
});
