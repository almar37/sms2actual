import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../src/db.js';
import { merchantKey, merchantReviewReason } from '../src/merchant-identity.js';
import { recheckMerchants } from '../src/merchant-recheck.js';
import { MerchantResolver } from '../src/merchant-resolver.js';
import { parseSms } from '../src/parser.js';
import { stableId } from '../src/transaction-id.js';
import type { ActualAdapter, HistoricalTransaction, ResolvedConfig } from '../src/types.js';
import { banks, parsing } from './fixtures/banks.js';

const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const receivedAt = '2026-11-08T10:00:00+03:00';
const config: ResolvedConfig = {
  banks,
  parsing,
  accounts: [
    {
      key: 'card',
      id: 'card-id',
      name: 'Al Rajhi card',
      match: { bank: 'alrajhi', accountSuffixes: ['8077'] },
    },
  ],
  bankFeesCategoryId: 'fees',
  eligibleCategories: [
    { id: 'food', name: 'Food Delivery' },
    { id: 'eating', name: 'Eating Out' },
  ],
};
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  const transactions: HistoricalTransaction[] = [];
  const actual: ActualAdapter = {
    initialize: async () => {},
    shutdown: async () => {},
    serverVersion: async () => '26.9.0',
    accounts: async () => [],
    categories: async () => config.eligibleCategories,
    sync: vi.fn(async () => {}),
    transactions: async () => transactions,
    transferPayee: async () => '',
    importTransactions: vi.fn(async () => ({ added: [], updated: [], errors: [] })),
    updateTransactions: vi.fn(async () => {}),
  };
  function add(
    id: string,
    merchant: string,
    originalMerchant: string,
    categoryId = 'food',
    source: 'ai' | 'local' = 'ai',
    amount = '77.5',
  ) {
    const message = `شراء عبر نقاط البيع\nبطاقة:8077 ;فيزا\nلدى:${merchant}\nمبلغ:${amount} SAR\nرصيد:20020.88 SAR\n7/11/26 22:09`;
    const parsed = parseSms(message, receivedAt, banks, 'AlRajhiBank', parsing);
    if (parsed.type !== 'transaction') throw new Error('Expected fixture transaction');
    const original = {
      ...parsed.transaction,
      payee: originalMerchant,
      importCategoryId: categoryId,
    };
    store.enqueue({ eventId: id, sender: 'AlRajhiBank', message, receivedAt });
    store.update(id, 'imported', {
      parsed: original,
      parserRevision: 15,
      actualTransactionId: `actual-${id}`,
    });
    store.putLocalMapping({
      account_id: 'card-id',
      merchant_key: merchantKey(originalMerchant),
      payee: merchant,
      category_id: categoryId,
      source,
      source_ref: source === 'local' ? `console-review:${id}` : id,
      decision_at: '2026-11-01T00:00:00.000Z',
    });
    const importedId = stableId(original, 'card');
    store.recordMerchantImport(importedId, merchant, categoryId);
    transactions.push({
      id: `actual-${id}`,
      accountId: 'card-id',
      importedId,
      importedPayee: originalMerchant,
      payeeName: merchant,
      categoryId,
      date: '2026-11-07',
    });
    return { original, importedId };
  }
  return {
    store,
    actual,
    transactions,
    add,
    resolver: new MerchantResolver(store, actual, config),
  };
}

describe('rechecking retained Al Rajhi merchants', () => {
  it('repairs screenshot-style keys, groups duplicates, and preserves SMS and Actual links', async () => {
    const f = fixture();
    f.add('amazon', 'Amazon sa', 'Amazon sa 8/11/26 00:31');
    f.add('jahe-77', 'MYSR*Jahe', 'MYSR*Jahe 77 مبلغ 5', 'food');
    f.add('jahe-160', 'MYSR*Jahe', 'MYSR*Jahe 160 مبلغ', 'eating', 'ai', '160');
    const before = ['amazon', 'jahe-77', 'jahe-160'].map((id) => f.store.get(id));
    const ids = f.transactions.map((transaction) => [transaction.id, transaction.importedId]);
    const result = recheckMerchants(f.store, config);
    expect(result).toEqual({ checked: 3, repaired: 3, needsReview: 1, unavailable: 0 });
    expect(f.store.mapping('card-id', 'amazon sa 8 11 26 00 31')).toBeUndefined();
    expect(f.store.mapping('card-id', 'amazon sa')).toMatchObject({
      payee: 'Amazon sa',
      source: 'ai',
    });
    expect(f.store.mapping('card-id', 'mysr jahe')).toMatchObject({
      source: 'ai',
      review_reason: expect.stringContaining('Conflicting'),
    });
    expect(f.resolver.lookup('card-id', 'MYSR*Jahe')).toBeUndefined();
    expect(['amazon', 'jahe-77', 'jahe-160'].map((id) => f.store.get(id))).toEqual(before);
    const auditCount = f.store.eventHistory('amazon').length;
    await f.resolver.refresh();
    expect(f.store.mapping('card-id', 'mysr jahe')?.review_reason).toContain('Conflicting');
    expect(f.store.eventHistory('amazon')).toHaveLength(auditCount);
    expect(f.transactions.map((transaction) => [transaction.id, transaction.importedId])).toEqual(
      ids,
    );
    expect(f.actual.importTransactions).not.toHaveBeenCalled();
    expect(f.actual.updateTransactions).not.toHaveBeenCalled();
    const saved = JSON.parse(f.store.get('amazon')!.parsed!);
    expect(stableId(saved, 'card')).toBe(f.transactions[0]!.importedId);
  });

  it('keeps confirmed aliases and sends future review edits to the repaired key', async () => {
    const f = fixture();
    f.add('amazon', 'Amazon SA', 'Amazon sa 8/11/26 00:31', 'food', 'local');
    await f.resolver.refresh();
    expect(f.resolver.lookup('card-id', 'Amazon sa')).toMatchObject({
      payee: 'Amazon SA',
      source: 'local',
    });
    f.store.putLocalMapping({
      account_id: 'card-id',
      merchant_key: 'amazon sa 8 11 26 00 31',
      payee: 'Amazon Saudi',
      category_id: 'eating',
      source_ref: 'console-review:amazon',
      decision_at: new Date(Date.now() + 1000).toISOString(),
    });
    await f.resolver.refresh();
    expect(f.resolver.lookup('card-id', 'Amazon sa')).toMatchObject({
      payee: 'Amazon Saudi',
      category_id: 'eating',
    });
    expect(f.store.mapping('card-id', 'amazon sa 8 11 26 00 31')).toBeUndefined();
  });

  it('recovers names that the old parser truncated at a field word', () => {
    const f = fixture();
    f.add('truncated', 'SHOP COUNTRY MARKET', 'SHOP', 'food', 'local');
    expect(recheckMerchants(f.store, config)).toMatchObject({ repaired: 1 });
    expect(f.store.mapping('card-id', 'shop')).toBeUndefined();
    expect(f.resolver.lookup('card-id', 'SHOP COUNTRY MARKET')).toMatchObject({
      payee: 'SHOP COUNTRY MARKET',
      source: 'local',
    });
  });

  it('requires confirmation when repaired confirmed rules have conflicting categories', () => {
    const f = fixture();
    f.add('one', 'MYSR*Jahe', 'MYSR*Jahe مبلغ:77.5 SAR', 'food', 'local');
    f.add('two', 'MYSR*Jahe', 'MYSR*Jahe مبلغ:160 SAR', 'eating', 'local', '160');
    recheckMerchants(f.store, config);
    expect(f.resolver.lookup('card-id', 'MYSR*Jahe')).toBeUndefined();
    f.store.putLocalMapping({
      account_id: 'card-id',
      merchant_key: 'mysr jahe',
      payee: 'Jahez',
      category_id: 'food',
      source_ref: 'console:card-id:mysr jahe',
      decision_at: new Date().toISOString(),
    });
    recheckMerchants(f.store, config);
    expect(f.resolver.lookup('card-id', 'MYSR*Jahe')).toMatchObject({
      payee: 'Jahez',
      category_id: 'food',
      source: 'local',
      review_reason: null,
    });
  });

  it('does not guess when one old key represents different merchants', () => {
    const f = fixture();
    f.add('amazon', 'Amazon sa', 'Unknown merchant');
    f.add('salla', 'Salla', 'Unknown merchant');
    expect(recheckMerchants(f.store, config)).toMatchObject({ repaired: 0, needsReview: 1 });
    expect(f.store.merchantRepair('card-id', 'unknown merchant')).toMatchObject({
      merchant_key: null,
      reason: 'Original description matches multiple merchants',
    });
    expect(f.resolver.lookup('card-id', 'Unknown merchant')).toBeUndefined();
  });

  it('does not redirect a legitimate unchanged name when an old truncated key collides with it', () => {
    const f = fixture();
    f.add('truncated', 'SHOP COUNTRY MARKET', 'SHOP', 'food', 'local');
    f.add('unchanged', 'SHOP', 'SHOP', 'food', 'local');
    expect(recheckMerchants(f.store, config)).toMatchObject({ repaired: 0, needsReview: 1 });
    expect(f.store.merchantRepair('card-id', 'shop')?.merchant_key).toBeNull();
    expect(f.resolver.lookup('card-id', 'SHOP')).toBeUndefined();
    expect(f.store.mapping('card-id', 'shop')?.review_reason).toContain('multiple');
  });

  it('retains incomplete cases for review without stripping legitimate merchant numbers', () => {
    const f = fixture();
    f.add('missing', 'MILA EST', 'mila est 141 مبلغ 15');
    f.store.db.prepare('UPDATE events SET payload=NULL WHERE id=?').run('missing');
    f.add('valid', 'Studio 54', 'Studio 54', 'food', 'local');
    const before = f.store.get('valid');
    expect(recheckMerchants(f.store, config)).toMatchObject({ repaired: 0, unavailable: 1 });
    expect(f.store.mapping('card-id', 'mila est 141 مبلغ 15')).toBeDefined();
    expect(merchantReviewReason('mila est 141 مبلغ 15')).toContain('amount');
    expect(f.store.mapping('card-id', 'studio 54')?.source).toBe('local');
    expect(f.store.get('valid')).toEqual(before);
  });

  it('retains a suggestion when unconfirmed dirty Actual history is removed on refresh', async () => {
    const f = fixture();
    const { original } = f.add('amazon', 'Amazon SA', 'Amazon sa 8/11/26 00:31');
    f.store.db.prepare('DELETE FROM local_mapping_observations').run();
    f.store.replaceActualMappings(
      [
        {
          actualTransactionId: 'actual-amazon',
          accountId: 'card-id',
          merchantKey: merchantKey(original.payee),
          payee: 'Amazon SA',
          categoryId: 'food',
          transactionDate: '2026-11-07',
        },
      ],
      receivedAt,
    );
    await f.resolver.refresh();
    expect(f.store.mapping('card-id', 'amazon sa')).toMatchObject({
      payee: 'Amazon SA',
      source: 'ai',
    });
    expect(f.resolver.lookup('card-id', 'Amazon sa')).toBeUndefined();
  });

  it('uses remembered repairs when Actual history refreshes after SMS logs are cleared', async () => {
    const f = fixture();
    f.add('amazon', 'Amazon SA', 'Amazon sa 8/11/26 00:31', 'food', 'local');
    await f.resolver.refresh();
    f.store.resetSmsData();
    f.transactions[0]!.categoryId = 'eating';
    await f.resolver.refresh();
    expect(f.store.mapping('card-id', 'amazon sa 8 11 26 00 31')).toBeUndefined();
    expect(f.resolver.lookup('card-id', 'Amazon sa')).toMatchObject({
      payee: 'Amazon SA',
      source: 'local',
    });
  });
});
