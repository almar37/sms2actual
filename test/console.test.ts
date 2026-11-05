import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../src/db.js';
import {
  ConsoleConfig,
  compileMessageTemplate,
  matchMessageTemplate,
  type ConsoleSettings,
} from '../src/console-config.js';
import { createConsoleAuth } from '../src/console-auth.js';
import { buildServer } from '../src/server.js';
import { Processor } from '../src/processor.js';
import { NoopEnricher } from '../src/enricher.js';
import { ConfigurableEnricher } from '../src/provider-enricher.js';
import { generateTaskerProject } from '../src/tasker-export.js';
import type { ActualAdapter, ResolvedConfig } from '../src/types.js';
import { banks, parsing } from './fixtures/banks.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});
const origin = 'http://localhost:3000';
const apiKey = 'test-bootstrap-key-with-enough-entropy';
const now = '2026-11-05T10:00:00+03:00';
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  const settings = new ConsoleConfig(store, 'test-console-encryption-key-with-32-bytes');
  const imports = vi
    .fn<ActualAdapter['importTransactions']>()
    .mockResolvedValue({ added: ['actual-id'], updated: [], errors: [] });
  const actual: ActualAdapter = {
    initialize: async () => {},
    serverVersion: async () => '26.9.0',
    shutdown: async () => {},
    sync: async () => {},
    accounts: async () => [
      { id: 'checking', name: 'Current' },
      { id: 'credit', name: 'Credit' },
    ],
    accountBalance: async (id) => (id === 'checking' ? 50000 : -10000),
    categories: async () => [
      { id: 'fees', name: 'Bank Fees' },
      { id: 'food', name: 'Food' },
    ],
    transactions: async (id) => [
      {
        id: `tx-${id}`,
        accountId: id,
        date: '2026-11-05',
        payeeName: 'Example',
        categoryId: 'food',
        amount: -2500,
      },
    ],
    transferPayee: async (id) => `payee-${id}`,
    importTransactions: imports,
  };
  const config: ResolvedConfig = {
    banks,
    parsing,
    accounts: [
      {
        id: 'checking',
        key: 'checking',
        name: 'Current',
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
    eligibleCategories: [{ id: 'food', name: 'Food' }],
  };
  const ai = new NoopEnricher();
  const processor = new Processor(store, actual, ai, config, 5, 0.7, undefined, settings);
  return { store, settings, actual, config, processor, ai, imports };
}
async function server(signedIn = true, trustedOrigins: string[] = []) {
  const f = fixture();
  const auth = await createConsoleAuth(
    f.store,
    origin,
    'test-auth-secret-with-more-than-32-characters',
    trustedOrigins,
  );
  const app = buildServer({
    apiKey,
    banks,
    store: f.store,
    processor: { tick: async () => {}, setMinConfidence: () => {} } as unknown as Processor,
    ready: () => true,
    console: {
      auth,
      settings: f.settings,
      actual: f.actual,
      config: f.config,
      publicUrl: origin,
      trustedOrigins,
      enricher: f.ai,
    },
  });
  let cookie = '';
  if (signedIn) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/console/setup',
      headers: { origin },
      payload: {
        username: 'owner',
        password: 'testpass',
        apiKey,
      },
    });
    expect(setup.statusCode, setup.body).toBe(200);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin },
      payload: { username: 'owner', password: 'testpass' },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    expect(cookie).toContain('session_token');
  }
  const headers = { origin, cookie };
  return { ...f, app, headers };
}

describe('console access and APIs', () => {
  it('requires browser sessions and forbids public signup and cross-origin owner setup', async () => {
    const { app } = await server(false);
    expect((await app.inject('/api/console/setup')).json()).toEqual({ needsSetup: true });
    expect((await app.inject('/api/console/settings')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/console/settings', headers: { 'x-api-key': apiKey } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/sign-up/email',
          headers: { origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/setup',
          headers: { origin: 'https://evil.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/setup',
          headers: { origin },
          payload: {
            username: 'owner',
            password: 'testpass',
            apiKey: 'wrong',
          },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
  it('creates only one owner, maintains sessions, rejects CSRF, and revokes logout sessions', async () => {
    const { app, headers } = await server();
    expect((await app.inject('/api/console/setup')).json()).toEqual({ needsSetup: false });
    expect(
      (await app.inject({ method: 'POST', url: '/api/console/setup', headers, payload: {} }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ url: '/api/console/settings', headers })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/console/settings',
          headers: { cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers, payload: {} }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/api/console/settings', headers })).statusCode).toBe(401);
    await app.close();
  });
  it('scopes Tasker tokens to ingestion, validates /api/v1 requests and records sync contact', async () => {
    const { app, headers, settings, store } = await server();
    await app.inject({ method: 'POST', url: '/api/console/tasker/rotate', headers, payload: {} });
    const token = settings.decrypt(settings.get<string>('taskerKey')!);
    const taskerHeaders = { 'x-api-key': token };
    expect((await app.inject({ url: '/api/v1/events', headers: taskerHeaders })).statusCode).toBe(
      403,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/sms',
          headers: taskerHeaders,
          payload: { message: 'A test message', sender: 'SAB', receivedAt: now },
        })
      ).statusCode,
    ).toBe(202);
    expect(store.list({ limit: 10 })).toHaveLength(1);
    expect(settings.get('lastTaskerSync')).toEqual(expect.any(String));
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/sms',
          headers: taskerHeaders,
          payload: { message: 'bad' },
        })
      ).statusCode,
    ).toBe(400);
    await app.inject({ method: 'POST', url: '/api/console/tasker/rotate', headers, payload: {} });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/inbox-sync/start',
          headers: taskerHeaders,
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
  it('validates configuration atomically, groups cards and restores persisted routing', async () => {
    const { app, headers, settings, config, actual } = await server();
    const body: ConsoleSettings = {
      ...settings.seed(config),
      accounts: [
        {
          id: 'credit',
          name: 'Credit',
          type: 'credit',
          match: { bank: 'sab', accountSuffixes: ['5678'] },
          cards: [
            { suffix: '8888', name: 'Travel Visa', type: 'credit' },
            { suffix: '9999', name: 'Family Visa', type: 'credit' },
          ],
          creditLimitCents: 2000000,
          fundingAccountId: 'checking',
        },
      ],
    };
    expect(
      (await app.inject({ method: 'PUT', url: '/api/console/settings', headers, payload: body }))
        .statusCode,
    ).toBe(200);
    expect(config.accounts[0]).toMatchObject({
      id: 'credit',
      fundingAccountId: 'checking',
      match: { accountSuffixes: ['5678', '8888', '9999'] },
    });
    const bad = { ...body, bankFeesCategoryId: 'unknown' };
    expect(
      (await app.inject({ method: 'PUT', url: '/api/console/settings', headers, payload: bad }))
        .statusCode,
    ).toBe(400);
    expect(config.bankFeesCategoryId).toBe('fees');
    const reloaded = new ConsoleConfig(settings.store, 'test-console-encryption-key-with-32-bytes');
    reloaded.apply(reloaded.seed(config), config, await actual.categories());
    expect(config.accounts[0]?.match.accountSuffixes).toContain('9999');
    await app.close();
  });
  it('paginates and sorts messages and summarizes all Actual accounts', async () => {
    const { app, headers, store } = await server();
    for (let i = 0; i < 56; i++)
      store.enqueue({
        eventId: `event-${i}`,
        sender: i % 2 ? 'SAB' : 'AlRajhi',
        message: `merchant-${i}`,
        receivedAt: now,
      });
    const log = await app.inject({
      url: '/api/console/events?sort=sender&direction=asc&page=1',
      headers,
    });
    expect(log.json().total).toBe(56);
    expect(log.json().events).toHaveLength(50);
    expect(log.json().events[0].input.sender).toBe('AlRajhi');
    expect(
      (await app.inject({ url: '/api/console/events?page=2', headers })).json().events,
    ).toHaveLength(6);
    expect(
      (await app.inject({ url: '/api/console/events?search=merchant-55', headers })).json().total,
    ).toBe(1);
    expect(
      (await app.inject({ url: '/api/console/events?sort=payload;DROP', headers })).statusCode,
    ).toBe(400);
    const summary = (await app.inject({ url: '/api/console/summary', headers })).json();
    expect(summary.accounts).toHaveLength(2);
    expect(summary.accounts[0].balanceCents).toBe(50000);
    expect(summary.transactions).toHaveLength(2);
    await app.close();
  });
  it('uses a reviewed deposit category during processing and blocks reimport of imported messages', async () => {
    const { app, headers, store, processor, imports } = await server();
    const { id } = store.enqueue({ sender: 'SAB', message: 'Unknown bank text', receivedAt: now });
    store.update(id, 'needs_review');
    const body = {
      kind: 'deposit',
      accountId: 'checking',
      amountCents: 5500,
      payee: 'Salary',
      categoryId: 'food',
      occurredAt: '2026-11-05T00:15:00+03:00',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/console/events/${id}/action`,
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    await processor.tick();
    expect(imports).toHaveBeenCalledWith('checking', [
      expect.objectContaining({
        date: '2026-11-05',
        amount: 5500,
        category: 'food',
        payee_name: 'Salary',
      }),
    ]);
    expect(store.get(id)?.status).toBe('imported');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/console/events/${id}/action`,
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    await app.close();
  });
  it('stores explicit merchant edits and returns encrypted keys only as presence flags', async () => {
    const { app, headers, settings, store } = await server();
    const edit = await app.inject({
      method: 'PUT',
      url: '/api/console/merchants',
      headers,
      payload: {
        accountId: 'checking',
        merchant: 'COFFEE SHOP',
        payee: 'Coffee Shop',
        categoryId: 'food',
      },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(store.mapping('checking', 'coffee shop')).toMatchObject({
      payee: 'Coffee Shop',
      category_id: 'food',
      source: 'local',
    });
    const save = await app.inject({
      method: 'PUT',
      url: '/api/console/ai',
      headers,
      payload: {
        provider: 'openai',
        model: 'test-model',
        apiKey: 'sensitive-test-key',
        minConfidence: 0.8,
      },
    });
    expect(save.statusCode).toBe(200);
    const output = await app.inject({ url: '/api/console/ai', headers });
    expect(output.json()).toMatchObject({ provider: 'openai', hasKey: true });
    expect(output.body).not.toContain('sensitive-test-key');
    expect(JSON.stringify(settings.get('ai'))).not.toContain('sensitive-test-key');
    expect(settings.ai().apiKey).toBe('sensitive-test-key');
    await app.close();
  });
});

describe('reference templates and providers', () => {
  it('escapes literal patterns, validates placeholders, and parses Arabic digits', () => {
    const template = {
      id: 'sample',
      name: 'Card purchase',
      bank: 'sab',
      kind: 'purchase' as const,
      pattern: 'شراء {amount} SAR لدى {merchant} بطاقة {suffix}',
      enabled: true,
    };
    expect(
      matchMessageTemplate(template, 'شراء ١٢.٥٠ SAR لدى Coffee بطاقة ١٢٣٤', now, 'sab'),
    ).toMatchObject({ amountCents: -1250, payee: 'Coffee', accountAlias: '1234' });
    expect(() => compileMessageTemplate('SAR {amount} plus {amount}')).toThrow('repeated');
    expect(() => compileMessageTemplate('SAR {unknown}')).toThrow('Unknown');
    expect(() => compileMessageTemplate('fixed notification')).toThrow('{amount}');
    expect(compileMessageTemplate('Purchase (SAR) {amount}').test('Purchase xSARx 12')).toBe(false);
  });
  it('applies a saved custom template and its category without contacting AI', async () => {
    const { settings, store, processor, imports } = fixture();
    settings.set('templates', [
      {
        id: 'custom',
        name: 'Coffee',
        bank: 'sab',
        kind: 'purchase',
        pattern: 'New bank wording {amount} merchant {merchant} card {suffix}',
        categoryId: 'food',
        enabled: true,
      },
    ]);
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'New bank wording 25.00 merchant Coffee card 1234',
      receivedAt: now,
    });
    await processor.tick();
    expect(store.get(id)?.status).toBe('imported');
    expect(imports).toHaveBeenCalledWith('checking', [
      expect.objectContaining({ amount: -2500, category: 'food', payee_name: 'Coffee' }),
    ]);
  });
  it('generates the existing checkpoint-based Tasker project with credentials and /api/v1 routes', async () => {
    const output = await generateTaskerProject('https://sms.example.test', 'a&<b');
    expect(output).toContain('/api/v1/inbox-sync/batch');
    expect(output).toContain('<exportval>a&amp;&lt;b</exportval>');
    expect(output).toContain('<exportval>https://sms.example.test</exportval>');
    expect(output).toContain('sms2actual');
    await expect(generateTaskerProject('http://sms.example.test', 'secret')).rejects.toThrow(
      'HTTPS',
    );
    await expect(
      generateTaskerProject('https://sms.example.test/api/v1', 'secret'),
    ).rejects.toThrow('without a path');
  });
  it.each(['openai', 'anthropic'] as const)(
    'uses the %s API and validates the selected category',
    async (provider) => {
      const { settings } = fixture();
      settings.saveAi({ provider, model: 'test-model', apiKey: 'test-key', minConfidence: 0.7 });
      const suggestion = { payee: 'Coffee', categoryId: 'food', confidence: 0.9, reason: 'A cafe' };
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify(
            provider === 'openai'
              ? {
                  output: [
                    { content: [{ type: 'output_text', text: JSON.stringify(suggestion) }] },
                  ],
                }
              : { content: [{ type: 'text', text: JSON.stringify(suggestion) }] },
          ),
          { status: 200 },
        ),
      );
      const helper = new ConfigurableEnricher(settings, undefined, fetchImpl);
      const result = await helper.enrich({
        merchant: 'COFFEE',
        occurredAt: now,
        categories: [{ id: 'food', name: 'Food' }],
      });
      expect(result.status).toBe('success');
      expect(fetchImpl.mock.calls[0]?.[0]).toContain(
        provider === 'openai' ? '/v1/responses' : '/v1/messages',
      );
      expect(JSON.stringify(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain('test-key');
      fetchImpl.mockResolvedValue(
        new Response(
          JSON.stringify(
            provider === 'openai'
              ? {
                  output: [
                    {
                      content: [
                        {
                          type: 'output_text',
                          text: JSON.stringify({ ...suggestion, categoryId: 'missing' }),
                        },
                      ],
                    },
                  ],
                }
              : {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({ ...suggestion, categoryId: 'missing' }),
                    },
                  ],
                },
          ),
        ),
      );
      expect(
        (await helper.enrich({ merchant: 'Coffee', occurredAt: now, categories: [] })).status,
      ).not.toBe('success');
    },
  );
});

describe('console financial safeguards', () => {
  it('records explicit credit limits from standalone messages and ignores older observations', async () => {
    const { settings, config, store, processor } = fixture();
    const saved = settings.seed(config);
    saved.accounts[1]!.type = 'credit';
    settings.set('routing', saved);
    const first = store.enqueue({
      eventId: 'limit-new',
      sender: 'SAB',
      message: 'Card **5678 credit limit: SAR 30,000.00',
      receivedAt: now,
    });
    await processor.tick();
    expect(settings.get(`limit:credit`)).toMatchObject({ cents: 3000000, eventId: first.id });
    store.enqueue({
      eventId: 'limit-old',
      sender: 'SAB',
      message: 'Card **5678 credit limit: SAR 20,000.00',
      receivedAt: '2026-11-04T10:00:00+03:00',
    });
    await processor.tick();
    expect(settings.get(`limit:credit`)).toMatchObject({ cents: 3000000 });
    store.enqueue({
      eventId: 'available',
      sender: 'SAB',
      message: 'Card **5678 available balance SAR 40,000.00',
      receivedAt: now,
    });
    await processor.tick();
    expect(settings.get(`limit:credit`)).toMatchObject({ cents: 3000000 });
  });
  it('shows the automatically routed counterparty for an imported own-account transfer', async () => {
    const { app, headers, store, processor, imports, config } = await server();
    config.accounts[0]!.match = { bank: 'alrajhi', accountSuffixes: ['0131'] };
    config.accounts[1]!.match = { bank: 'alrajhi', accountSuffixes: ['7900'] };
    const { id } = store.enqueue({
      sender: 'AlRajhiBank',
      message: 'حوالة بين حساباتك\nمبلغ:SR 1\nمن:0131\nالى:7900\n26/11/6 00:01',
      receivedAt: '2026-11-06T00:01:00+03:00',
    });
    await processor.tick();
    expect(imports).toHaveBeenCalledWith('checking', [
      expect.objectContaining({ amount: -100, payee: 'payee-credit' }),
    ]);
    const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      status: 'imported',
      targetAccountId: 'credit',
      parsed: { accountAlias: '0131', transferCounterpartyAlias: '7900' },
    });
    expect(detail.json().parsed.explicitTransferAccountId).toBeUndefined();
    await app.close();
  });
  it.each([
    { fields: { transferCounterpartyAlias: '5678' }, target: 'credit' },
    { fields: { transferCounterpartyAlias: '9999' }, target: null },
    {
      fields: { transferCounterpartyAlias: '5678', explicitTransferAccountId: 'checking' },
      target: 'checking',
    },
    { fields: { billPaymentIdentifier: '404' }, target: 'credit' },
    {
      fields: {
        kind: 'transfer_in',
        cardPaymentReceived: true,
        assumedFundingAccountId: 'checking',
      },
      target: 'checking',
    },
    { fields: { kind: 'purchase', billPaymentIdentifier: '404' }, target: null },
  ])(
    'resolves message detail counterparty using import rules: $fields',
    async ({ fields, target }) => {
      const { app, headers, store, config } = await server();
      config.accounts[1]!.match.billPaymentIdentifiers = ['404'];
      const { id } = store.enqueue({ sender: 'SAB', message: 'Transfer fixture', receivedAt: now });
      store.update(id, 'imported', {
        parsed: {
          bank: 'sab',
          kind: 'transfer_out',
          amountCents: -100,
          feeCents: 0,
          payee: 'Bank transfer',
          occurredAt: now,
          note: 'Fixture',
          ...fields,
        } as import('../src/types.js').ParsedTransaction,
      });
      const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().targetAccountId).toBe(target);
      await app.close();
    },
  );
  it('separates the principal and fee for a manually reviewed transfer', async () => {
    const { app, headers, store, processor, imports } = await server();
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'Unknown transfer message',
      receivedAt: now,
    });
    store.update(id, 'needs_review');
    const result = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/action`,
      headers,
      payload: {
        kind: 'transfer_out',
        accountId: 'checking',
        targetAccountId: 'credit',
        amountCents: 10000,
        feeCents: 150,
        payee: 'Card repayment',
        occurredAt: now,
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    await processor.tick();
    expect(imports).toHaveBeenCalledWith('checking', [
      expect.objectContaining({ amount: -10000, payee: 'payee-credit' }),
    ]);
    expect(imports).toHaveBeenCalledWith('checking', [
      expect.objectContaining({ amount: -150, category: 'fees' }),
    ]);
    expect(store.get(id)?.status).toBe('imported');
    await app.close();
  });
  it('retains unsupported nonempty Tasker messages in the log without importing them', async () => {
    const { app, headers, store } = await server();
    await app.inject({ method: 'POST', url: '/api/console/tasker/rotate', headers, payload: {} });
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/inbox-sync/start',
      headers: { 'x-api-key': apiKey },
    });
    const checkpoint = start.json().checkpoint;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/inbox-sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: {
        checkpoint,
        rows: [
          {
            rowId: 123,
            date: checkpoint.date + 1000,
            sender: 'UNKNOWN',
            message: 'Unsupported test message',
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json().results[0].outcome).toBe('unsupported');
    expect(store.list({ limit: 10 })).toMatchObject([
      { status: 'ignored', parser_reason: 'unsupported_sender' },
    ]);
    await app.close();
  });
  it('sends overlapping reference templates to review', async () => {
    const { settings, store, processor, imports } = fixture();
    settings.set('templates', [
      {
        id: 'one',
        name: 'One',
        bank: 'sab',
        kind: 'purchase',
        pattern: 'New {amount} merchant {merchant} card {suffix}',
        enabled: true,
      },
      {
        id: 'two',
        name: 'Two',
        bank: 'sab',
        kind: 'purchase',
        pattern: 'New {amount} merchant {merchant} card {suffix}',
        enabled: true,
      },
    ]);
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'New 25.00 merchant Coffee card 1234',
      receivedAt: now,
    });
    await processor.tick();
    expect(store.get(id)).toMatchObject({
      status: 'needs_review',
      parser_reason: 'ambiguous_template',
    });
    expect(imports).not.toHaveBeenCalled();
  });
});

describe('explicit additional console origins', () => {
  it('allows login and authenticated writes from a configured Tailscale origin while rejecting others', async () => {
    const tailnetOrigin = 'http://100.120.220.101:3002';
    const { app } = await server(true, [tailnetOrigin]);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: tailnetOrigin, host: '100.120.220.101:3002' },
      payload: { username: 'owner', password: 'testpass' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    expect(cookie).toContain('session_token');
    const save = await app.inject({
      method: 'PUT',
      url: '/api/console/preferences',
      headers: { origin: tailnetOrigin, cookie },
      payload: { actualUrl: 'http://localhost:5006' },
    });
    expect(save.statusCode, save.body).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/console/preferences',
          headers: { origin: 'http://100.120.220.102:3002', cookie },
          payload: { actualUrl: 'http://localhost:5006' },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });
});

describe('username and eight-character passwords', () => {
  it('rejects short passwords and missing API keys without creating an owner', async () => {
    const { app, store } = await server(false);
    const short = await app.inject({
      method: 'POST',
      url: '/api/console/setup',
      headers: { origin },
      payload: { username: 'admin', password: '1234567', apiKey },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toContain('8 characters');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/setup',
          headers: { origin },
          payload: { username: 'admin', password: 'testpass' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (store.db.prepare('SELECT COUNT(*) count FROM user').get() as { count: number }).count,
    ).toBe(0);
    await app.close();
  });
  it('accepts eight characters for setup, login and password changes, and blocks email sign-in', async () => {
    const { app, headers } = await server();
    const short = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { currentPassword: 'testpass', newPassword: '1234567', revokeOtherSessions: true },
    });
    expect(short.statusCode).toBe(400);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { currentPassword: 'testpass', newPassword: 'newpass8', revokeOtherSessions: true },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin },
      payload: { username: 'OWNER', password: 'newpass8' },
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().user.username).toBe('owner');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { origin },
          payload: { email: 'owner@example.com', password: 'newpass8' },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
  it('gives an existing owner a username without changing their password or sessions', async () => {
    const { app, store, headers } = await server();
    store.db.prepare('UPDATE user SET username=NULL,name=?').run('Legacy Owner');
    const auth = await createConsoleAuth(
      store,
      origin,
      'test-auth-secret-with-more-than-32-characters',
    );
    const result = await auth.api.signInUsername({
      body: { username: 'legacy_owner', password: 'testpass' },
    });
    expect(result.user.username).toBe('legacy_owner');
    expect((await app.inject({ url: '/api/console/settings', headers })).statusCode).toBe(200);
    await app.close();
  });
});

it('reveals Tasker credentials only to an authenticated same-origin request', async () => {
  const { app, headers, settings } = await server();
  await app.inject({ method: 'POST', url: '/api/console/tasker/rotate', headers, payload: {} });
  const token = settings.decrypt(settings.get<string>('taskerKey')!);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/console/tasker/credentials',
        headers: { origin },
        payload: {},
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/console/tasker/credentials',
        headers: { cookie: headers.cookie, origin: 'https://evil.test' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  const response = await app.inject({
    method: 'POST',
    url: '/api/console/tasker/credentials',
    headers,
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ apiKey: token, serviceUrl: origin });
  expect(response.headers['cache-control']).toBe('no-store');
  expect((await app.inject({ url: '/api/console/settings', headers })).body).not.toContain(token);
  await app.close();
});
