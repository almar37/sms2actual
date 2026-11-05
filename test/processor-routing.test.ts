import { banks, parsing } from './fixtures/banks.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../src/db.js';
import { PARSER_REVISION } from '../src/parser.js';
import { Processor } from '../src/processor.js';
import type { ActualAdapter, Enricher, ResolvedConfig } from '../src/types.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

const config: ResolvedConfig = {
  banks,
  parsing,
  accounts: [
    {
      key: 'sab-checking',
      id: 'sab-checking-id',
      name: 'SAB - Checking',
      match: { bank: 'sab', accountSuffixes: ['4101', '101', '4187', '4947'] },
    },
    {
      key: 'payroll',
      id: 'payroll-id',
      name: 'Payroll',
      match: { bank: 'sab', accountSuffixes: ['5202', '202'] },
    },
    {
      key: 'sab-credit-card',
      id: 'sab-credit-card-id',
      name: 'SAB Credit card',
      match: { bank: 'sab', accountSuffixes: ['8501'] },
    },
    {
      key: 'd360',
      id: 'd360-id',
      name: 'D360',
      match: { bank: 'd360', accountSuffixes: ['5892'] },
    },
    {
      key: 'alrajhi-checking',
      id: 'alrajhi-checking-id',
      name: 'Alrajhi Checking',
      match: { bank: 'alrajhi', hasBalance: false, transferIdentifiers: ['7404'] },
    },
    {
      key: 'credit-card',
      id: 'credit-card-id',
      name: 'Credit Card',
      match: { bank: 'alrajhi', hasBalance: true, billPaymentIdentifiers: ['404'] },
    },
  ],
  bankFeesCategoryId: 'fees',
  eligibleCategories: [],
};

function setup(overrides: Partial<ResolvedConfig> = {}, importErrors: string[] = []) {
  const store = new EventStore(':memory:');
  stores.push(store);
  const imported: {
    account: string;
    transactions: Parameters<ActualAdapter['importTransactions']>[1];
  }[] = [];
  const transferPayees: string[] = [];
  const actual: ActualAdapter = {
    initialize: async () => {},
    serverVersion: async () => '26.9.0',
    shutdown: async () => {},
    sync: async () => {},
    accounts: async () => [],
    categories: async () => [],
    transactions: async () => [],
    transferPayee: async (accountId) => {
      transferPayees.push(accountId);
      return `transfer:${accountId}`;
    },
    importTransactions: async (account, transactions) => {
      imported.push({ account, transactions });
      return {
        added: ['actual-id'],
        updated: [],
        errors: importErrors.map((message) => ({ message })),
      };
    },
  };
  const ai: Enricher = { enrich: async () => ({ status: 'disabled', durationMs: 0 }) };
  return {
    store,
    imported,
    transferPayees,
    processor: new Processor(store, actual, ai, { ...config, ...overrides }),
  };
}

const outgoing = 'SAB SARIE transfer accepted From: 5202 To: SA0000000000007404 Amount: SAR 100.00';
const incoming = 'Al Rajhi SARIE transfer credited From: 5202 To: 7404 Amount: SAR 100.00';
const outgoingWithAccountAliases =
  'SAB outgoing transfer Account **5202 Beneficiary Account **7404 Amount: SAR 100.00';
const outgoingToBillerCode = 'SAB SARIE transfer accepted From: 5202 To: 404 Amount: SAR 100.00';
const outgoingIbanEndingInBillerCode =
  'SAB SARIE transfer accepted From: 5202 IBAN: SA0000000000000404 Amount: SAR 100.00';
const cardPaymentToBillerCode = 'SAB card payment From: 5202 To: 404 Amount: SAR 100.00';
const cardPaymentIbanEndingInBillerCode =
  'SAB card payment From: 5202 IBAN: SA0000000000000404 Amount: SAR 100.00';
const receivedAt = '2026-08-22T10:10:30+03:00';

describe('credit-card repayment funding defaults', () => {
  const receipt = {
    eventId: 'card-receipt',
    sender: 'AlRajhiBank',
    message: 'بطاقة فيزا:سداد بـSR 80.50 \\nعبر2393;فيزا\\nرصيد:1200.1 SR \\n؜5/11/26 21:56',
    receivedAt: '2026-11-05T18:56:40.094Z',
  };
  const funding = () => ({ id: 'alrajhi-checking-id', name: 'Alrajhi Checking' });

  it.each([funding(), { id: 'other-existing-account-id', name: 'Account without SMS routing' }])(
    'links a received card payment to the configured $name account',
    async (creditCardPaymentFundingAccount) => {
      const { store, imported, transferPayees, processor } = setup({
        creditCardPaymentFundingAccount,
      });
      store.enqueue(receipt);
      await processor.tick();
      expect(transferPayees).toEqual([creditCardPaymentFundingAccount.id]);
      expect(imported).toEqual([
        {
          account: 'credit-card-id',
          transactions: [
            expect.objectContaining({
              amount: 8050,
              payee: `transfer:${creditCardPaymentFundingAccount.id}`,
            }),
          ],
        },
      ]);
      expect(imported[0]?.transactions[0]).not.toHaveProperty('category');
      expect(store.get(receipt.eventId)).toMatchObject({
        status: 'imported',
        actual_transaction_id: 'actual-id',
      });
      expect(JSON.parse(store.get(receipt.eventId)!.parsed!)).toMatchObject({
        cardPaymentReceived: true,
        assumedFundingAccountId: creditCardPaymentFundingAccount.id,
      });
    },
  );

  it('prefers the funding account explicitly named in the SMS', async () => {
    const { store, transferPayees, processor } = setup({
      creditCardPaymentFundingAccount: funding(),
    });
    store.enqueue({
      ...receipt,
      message: 'Credit Card:Payment From: 5202 To: 2393 Amount: SAR 80.50 Balance: SAR 1200.10',
    });
    await processor.tick();
    expect(transferPayees).toEqual(['payroll-id']);
    expect(JSON.parse(store.get(receipt.eventId)!.parsed!).assumedFundingAccountId).toBeUndefined();
  });

  it('does not replace an unknown explicit funding account with the default', async () => {
    const { store, imported, transferPayees, processor } = setup({
      creditCardPaymentFundingAccount: funding(),
    });
    store.enqueue({
      ...receipt,
      message: 'Credit Card:Payment From: 9999 To: 2393 Amount: SAR 80.50 Balance: SAR 1200.10',
    });
    await processor.tick();
    expect(transferPayees).toEqual([]);
    expect(imported[0]?.transactions[0]).toMatchObject({
      amount: 8050,
      payee_name: 'Bank transfer',
    });
  });

  it.each([
    'Incoming transfer To: 2393 Amount: SAR 80.50 Balance: SAR 1200.10',
    'Refund Card:2393 Amount: SAR 80.50 Balance: SAR 1200.10',
    'Purchase Card:2393 Amount: SAR 80.50 at Example Balance: SAR 1200.10',
  ])('leaves unrelated transactions independent of the funding default: %s', async (message) => {
    const { store, transferPayees, processor } = setup({
      creditCardPaymentFundingAccount: funding(),
    });
    store.enqueue({ ...receipt, message });
    await processor.tick();
    expect(store.get(receipt.eventId)?.status).toBe('imported');
    expect(transferPayees).toEqual([]);
    expect(JSON.parse(store.get(receipt.eventId)!.parsed!).assumedFundingAccountId).toBeUndefined();
  });

  it('rejects a funding default that points back to the receiving card', async () => {
    const { store, imported, processor } = setup({
      creditCardPaymentFundingAccount: { id: 'credit-card-id', name: 'Credit Card' },
    });
    store.enqueue(receipt);
    await processor.tick();
    expect(imported).toEqual([]);
    expect(store.get(receipt.eventId)).toMatchObject({
      status: 'queued',
      error: 'Credit-card payment funding account must differ from the card account',
    });
  });

  it('keeps the assumed funding account across retries and checks Actual import errors', async () => {
    const defaultAccount = funding();
    const errors = ['Actual rejected transfer'];
    const { store, imported, processor } = setup(
      { creditCardPaymentFundingAccount: defaultAccount },
      errors,
    );
    store.enqueue(receipt);
    await processor.tick();
    expect(store.get(receipt.eventId)).toMatchObject({
      status: 'queued',
      error: 'Actual rejected transfer',
    });
    expect(store.db.prepare('SELECT count(*) count FROM transfers').get()).toEqual({ count: 0 });
    defaultAccount.id = 'payroll-id';
    errors.length = 0;
    store.update(receipt.eventId, 'queued', { nextAttemptAt: new Date().toISOString() });
    await processor.tick();
    expect(store.get(receipt.eventId)?.status).toBe('imported');
    expect(imported[1]?.transactions[0]?.payee).toBe('transfer:alrajhi-checking-id');
  });

  it.each(['debit-first', 'receipt-first'])(
    'does not duplicate a linked repayment when both SMS sides arrive (%s)',
    async (order) => {
      const defaultAccount = funding();
      const { store, imported, processor } = setup({
        creditCardPaymentFundingAccount: defaultAccount,
        accounts: config.accounts.map((account) =>
          account.key === 'credit-card'
            ? { ...account, match: { ...account.match, transferIdentifiers: ['2393'] } }
            : account,
        ),
      });
      const debit = {
        ...receipt,
        eventId: 'checking-debit',
        message: 'Outgoing transfer From: 7404 To: 2393 Amount: SAR 80.50 On: 2026-11-05 21:56:00',
      };
      const rows = order === 'debit-first' ? [debit, receipt] : [receipt, debit];
      for (const row of rows) {
        store.enqueue(row);
        await processor.tick();
        // A later settings change must not reinterpret an already imported receipt.
        if (row.eventId === receipt.eventId) defaultAccount.id = 'payroll-id';
      }
      expect(store.get(debit.eventId)?.status).toBe('imported');
      expect(store.get(receipt.eventId)?.status).toBe('imported');
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject(
        order === 'debit-first'
          ? {
              account: 'alrajhi-checking-id',
              transactions: [{ amount: -8050, payee: 'transfer:credit-card-id' }],
            }
          : {
              account: 'credit-card-id',
              transactions: [{ amount: 8050, payee: 'transfer:alrajhi-checking-id' }],
            },
      );
    },
  );
});

describe('processor transfer routing', () => {
  it('imports a salary transfer into the account named by its To field', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'salary-to-payroll',
      sender: 'SAB',
      message: 'حوالة راتب\nإلى: **202\nمبلغ: 25,559.77 SAR\nفي: 2026-08-26 08:02:50',
      receivedAt: '2026-08-26T05:04:03.897Z',
    }).id;

    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toEqual([
      {
        account: 'payroll-id',
        transactions: [expect.objectContaining({ amount: 2555977, payee_name: 'Bank transfer' })],
      },
    ]);
  });

  it('imports a statement-style credit-card payment as money received by the card', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'credit-card-payment-received',
      sender: 'AlRajhiBank',
      message:
        'Credit Card:Payment\nCard:Visa 2393\nAmount:SR 779.98\nBalance:27105.03 SR\n5/9/26 8:44',
      receivedAt: '2026-09-05T05:44:00.000Z',
    }).id;

    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toEqual([
      {
        account: 'credit-card-id',
        transactions: [expect.objectContaining({ amount: 77998, payee_name: 'Bank transfer' })],
      },
    ]);
  });

  it('imports an Arabic credit-card payment receipt as a card credit without an expense category', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'arabic-credit-card-payment-received',
      sender: 'AlRajhiBank',
      message: 'بطاقة فيزا:سداد بـSR 80.50 \\nعبر2393;فيزا\\nرصيد:1200.1 SR \\n؜5/11/26 21:56',
      receivedAt: '2026-11-05T18:56:40.094Z',
    }).id;

    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.account).toBe('credit-card-id');
    expect(imported[0]?.transactions).toEqual([
      expect.objectContaining({ amount: 8050, payee_name: 'Bank transfer' }),
    ]);
    expect(imported[0]?.transactions[0]).not.toHaveProperty('category');
    expect(store.enrichmentAttempts(id).at(-1)).toMatchObject({ status: 'not_applicable' });
  });

  it('routes SAB Arabic POS purchases using the Mada Atheer card suffix', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'sab-arabic-pos-purchase',
      sender: 'SAB',
      message:
        'شراء عبر نقاط البيع\nباستخدام بطاقة الأول مدى-أثير (4947) بمبلغ (001) SAR 7.00 لدى TAMIMI GLOBAL CO. L في: 2026-09-08 08:30:43.',
      receivedAt: '2026-09-08T05:31:14.290Z',
    }).id;

    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toEqual([
      {
        account: 'sab-checking-id',
        transactions: [
          expect.objectContaining({ amount: -700, payee_name: 'TAMIMI GLOBAL CO. L' }),
        ],
      },
    ]);
  });

  it.each(['payment-first', 'credit-first'])(
    'imports each side of a SAB card top-up once (%s)',
    async (order) => {
      const { store, imported, processor } = setup();
      const payment = {
        eventId: 'sab-card-top-up-payment',
        sender: 'SAB',
        message:
          'بطاقة إئتمانية: تسديد\nبطاقة: ***8501;VISA\nمبلغ: 237.70 SAR\nمن: ***202\nفي: 2026-09-30 10:30:30',
        receivedAt: '2026-09-30T07:30:30.000Z',
      };
      const credit = {
        eventId: 'sab-card-top-up-credit',
        sender: 'SAB',
        message:
          'Credit Card: Credited\nSAB Visa Cashback Credit Card (***8501) was credited with SAR 237.70 on: 2026-09-30 10:30:34\nBalance: SAR 49900.00',
        receivedAt: '2026-09-30T07:30:34.000Z',
      };
      const rows = order === 'payment-first' ? [payment, credit] : [credit, payment];
      for (const row of rows) {
        store.enqueue(row);
        await processor.tick();
      }
      expect(store.get(payment.eventId)?.status).toBe('imported');
      expect(store.get(credit.eventId)?.status).toBe('imported');
      if (order === 'payment-first') {
        expect(imported).toEqual([
          {
            account: 'payroll-id',
            transactions: [
              expect.objectContaining({ amount: -23770, payee: 'transfer:sab-credit-card-id' }),
            ],
          },
        ]);
      } else {
        expect(imported).toHaveLength(2);
        expect(imported[1]).toMatchObject({
          account: 'payroll-id',
          transactions: [expect.objectContaining({ amount: -23770, payee_name: 'Bank transfer' })],
        });
        expect(imported[1]?.transactions[0]?.payee).toBeUndefined();
        expect(imported[0]).toMatchObject({
          account: 'sab-credit-card-id',
          transactions: [expect.objectContaining({ amount: 23770 })],
        });
      }
    },
  );

  it('imports a D360 yen purchase using its explicit SAR equivalent', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'd360-yen-pos',
      sender: 'D360 Bank',
      message:
        'International POS Purchase\nAmount: JPY 878.00 (SAR 20.91)\nCard: *5892 - VISA (Card)\nFee: SAR 0.00\nAt: FAMILYMART\nCountry: Japan\nOn: 2026-10-11 15:45',
      receivedAt: '2026-10-11T12:45:00.000Z',
    }).id;
    await processor.tick();
    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toEqual([
      {
        account: 'd360-id',
        transactions: [
          expect.objectContaining({
            amount: -2091,
            payee_name: 'FAMILYMART',
            notes: 'Parsed d360 purchase | 878 JPY',
          }),
        ],
      },
    ]);
  });

  it('routes a SAB Visa Cashback online purchase to its card account for the total charged', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'sab-visa-cashback-online-purchase',
      sender: 'SAB',
      message:
        'Online Purchase\nSAB Visa Cashback Credit Card (8501) was used at Google Telegram for SAR 5.39 in UNITED STATES\nExchange rate: 1.000000\nAmount in SAR: 5.39\nInternational Fees in SAR: 0.12\nTotal amount in SAR: 5.51\nDate: 2026-09-14 21:09:05\nBalance: SAR 49862.42',
      receivedAt: '2026-09-14T18:09:12.824Z',
    }).id;

    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toEqual([
      {
        account: 'sab-credit-card-id',
        transactions: [expect.objectContaining({ amount: -551, payee_name: 'Google Telegram' })],
      },
    ]);
  });

  it('routes an outgoing transfer using its beneficiary account suffix', async () => {
    const { store, imported, processor, transferPayees } = setup();
    store.enqueue({
      eventId: 'beneficiary-account-suffix',
      sender: 'SAB',
      message: outgoingWithAccountAliases,
      receivedAt,
    });

    await processor.tick();

    expect(transferPayees).toEqual(['alrajhi-checking-id']);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      account: 'payroll-id',
      transactions: [{ payee: 'transfer:alrajhi-checking-id', amount: -10000 }],
    });
  });

  it('imports an Al Rajhi card bill from Payroll to the Credit Card account', async () => {
    const { store, imported, processor, transferPayees } = setup();
    store.enqueue({
      eventId: 'alrajhi-card-bill',
      sender: 'SAB',
      message:
        'سداد فاتورة\nمن: ***202\nمفوتر: 404 بنك الراجحي البطاقة اﻻئتمانيه \nلخدمة: POSTPAID\nرقم الفاتورة: 111817823 \nمبلغ: 9,145.00 SAR\nفي: 2026-08-26 08:43:27',
      receivedAt: '2026-08-26T05:44:04.596Z',
    });

    await processor.tick();

    expect(transferPayees).toEqual(['credit-card-id']);
    expect(imported).toEqual([
      {
        account: 'payroll-id',
        transactions: [
          expect.objectContaining({ amount: -914500, payee: 'transfer:credit-card-id' }),
        ],
      },
    ]);
  });

  it.each([
    ['transfer To field', outgoingToBillerCode],
    ['transfer IBAN', outgoingIbanEndingInBillerCode],
    ['card-payment To field', cardPaymentToBillerCode],
    ['card-payment IBAN', cardPaymentIbanEndingInBillerCode],
  ])(
    'keeps an ordinary transaction with biller code 404 in %s external',
    async (field, message) => {
      const { store, imported, processor, transferPayees } = setup();
      store.enqueue({ eventId: `ordinary-404-${field}`, sender: 'SAB', message, receivedAt });

      await processor.tick();

      expect(transferPayees).toEqual([]);
      expect(imported).toEqual([
        {
          account: 'payroll-id',
          transactions: [expect.objectContaining({ amount: -10000, payee_name: 'Bank transfer' })],
        },
      ]);
    },
  );

  it('replays a previously ignored SARIE transfer once and imports it once', async () => {
    const { store, imported, processor } = setup();
    const id = store.enqueue({
      eventId: 'previously-ignored',
      sender: 'SAB',
      message: outgoing,
      receivedAt,
    }).id;
    store.update(id, 'ignored', {
      parserReason: 'unrecognized_template',
      parserRevision: 1,
    });

    expect(store.replayParserRevision(PARSER_REVISION)).toBe(1);
    await processor.tick();

    expect(store.get(id)?.status).toBe('imported');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.transactions).toHaveLength(1);
    expect(store.replayParserRevision(PARSER_REVISION)).toBe(0);
    await processor.tick();
    expect(imported).toHaveLength(1);
  });

  it.each([
    [outgoing, incoming, 'alrajhi-checking-id'],
    [incoming, outgoing, 'payroll-id'],
  ])(
    'pairs cross-bank transfers in either message order',
    async (first, second, targetAccountId) => {
      const { store, imported, processor, transferPayees } = setup();
      const firstEvent = store.enqueue({
        eventId: 'first',
        sender: first.includes('SAB') ? 'SAB' : 'AlrajhiBank',
        message: first,
        receivedAt,
      }).id;
      const secondEvent = store.enqueue({
        eventId: 'second',
        sender: second.includes('SAB') ? 'SAB' : 'AlrajhiBank',
        message: second,
        receivedAt,
      }).id;

      await processor.tick();
      await processor.tick();

      expect(transferPayees).toEqual([targetAccountId]);
      expect(imported).toHaveLength(1);
      expect(imported[0]?.transactions[0]).toMatchObject({ payee: `transfer:${targetAccountId}` });
      expect(store.get(firstEvent)?.status).toBe('imported');
      expect(store.get(secondEvent)?.status).toBe('imported');
    },
  );

  it('keeps the historical imported ID suffix and distinguishes source identifiers', async () => {
    const { store, imported, processor } = setup();
    const message =
      'SAB purchase Card **4101 Amount SAR 25.00 at Example Store on 2026-08-22 10:05';
    const alternate = message.replace('4101', '4187');
    store.enqueue({ eventId: 'one', sender: 'SAB', message, receivedAt });
    store.enqueue({ eventId: 'two', sender: 'SAB', message: alternate, receivedAt });

    await processor.tick();
    await processor.tick();

    const expected =
      'sms:' +
      createHash('sha256')
        .update(
          [
            'sab',
            '4101',
            'purchase',
            '2026-08-22T10:05:00.000+03:00',
            -2500,
            'Example Store',
            'main',
          ].join('|'),
        )
        .digest('hex');
    const ids = imported.flatMap((entry) =>
      entry.transactions.map((transaction) => transaction.imported_id),
    );
    expect(ids).toContain(expected);
    expect(new Set(ids)).toHaveLength(2);
  });
});

it('does not let an unrelated credit suppress a configured transfer', async () => {
  const { store, processor, transferPayees } = setup();
  store.enqueue({
    eventId: 'external',
    sender: 'SAB',
    message: 'Transfer received To: 4101 Amount: SAR 100',
    receivedAt,
  });
  await processor.tick();
  store.enqueue({ eventId: 'outgoing', sender: 'SAB', message: outgoing, receivedAt });
  await processor.tick();
  expect(transferPayees).toEqual(['alrajhi-checking-id']);
});

it('skips an unrelated nearest transfer candidate to find the real counterpart', async () => {
  const { store, processor, imported, transferPayees } = setup();
  store.enqueue({
    eventId: 'real-credit',
    sender: 'AlRajhiBank',
    message: incoming + ' on 2026-08-22 10:05',
    receivedAt,
  });
  await processor.tick();
  store.enqueue({
    eventId: 'unrelated-credit',
    sender: 'SAB',
    message: 'Transfer received To: 4101 Amount: SAR 100',
    receivedAt,
  });
  await processor.tick();
  const count = imported.length;
  store.enqueue({ eventId: 'debit', sender: 'SAB', message: outgoing, receivedAt });
  await processor.tick();
  expect(store.get('debit')?.status).toBe('imported');
  expect(imported).toHaveLength(count);
  expect(transferPayees).toEqual(['payroll-id']);
});
