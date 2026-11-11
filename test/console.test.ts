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
import { ActualConnection } from '../src/actual-connection.js';
import { NoopEnricher } from '../src/enricher.js';
import { ConfigurableEnricher } from '../src/provider-enricher.js';
import { generateTaskerProject } from '../src/tasker-export.js';
import type { ActualAdapter, HistoricalTransaction, ResolvedConfig } from '../src/types.js';
import { banks, parsing } from './fixtures/banks.js';
import { sevenGramMessage, sevenGramReceivedAt } from './fixtures/alrajhi-compact-pos.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
  vi.useRealTimers();
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
async function server(signedIn = true, trustedOrigins: string[] = [], onboarding = false) {
  const f = fixture();
  const connection = onboarding
    ? new ActualConnection(f.settings, f.config, '/unused', undefined, undefined, () => f.actual)
    : undefined;
  if (connection) {
    f.config.accounts = [];
    f.config.bankFeesCategoryId = '';
    f.config.eligibleCategories = [];
    f.processor = new Processor(
      f.store,
      connection,
      f.ai,
      f.config,
      5,
      0.7,
      undefined,
      f.settings,
      () => connection.canProcess(),
    );
  }
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
    processor: {
      tick: async () => {},
      setMinConfidence: () => {},
      isBusy: () => f.processor.isBusy(),
      recheckMerchants: () => f.processor.recheckMerchants(),
      withActualAccess: <T>(work: () => Promise<T>) => f.processor.withActualAccess(work),
    } as unknown as Processor,
    ready: () => true,
    console: {
      auth,
      settings: f.settings,
      actual: connection ?? f.actual,
      connection,
      requireSetupKey: !onboarding,
      onRoutingChanged: connection ? () => f.processor.refreshMappings() : undefined,
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
        password: 'testpass',
        apiKey,
      },
    });
    expect(setup.statusCode, setup.body).toBe(200);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/password',
      headers: { origin },
      payload: { password: 'testpass' },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    expect(cookie).toContain('session_token');
  }
  const headers = { origin, cookie };
  return { ...f, app, headers, connection };
}

describe('web onboarding', () => {
  it('creates an owner and connects Actual without environment keys or YAML, then processes after account setup', async () => {
    const { app, store, processor, imports, connection } = await server(false, [], true);
    expect((await app.inject('/api/console/setup')).json()).toEqual({
      needsSetup: true,
      requiresApiKey: false,
    });
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    const setup = await app.inject({
      method: 'POST',
      url: '/api/console/setup',
      headers: { origin },
      payload: { password: 'testpass' },
    });
    expect(setup.statusCode, setup.body).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/setup',
          headers: { origin },
          payload: { password: 'testpass' },
        })
      ).statusCode,
    ).toBe(409);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/password',
      headers: { origin },
      payload: { password: 'testpass' },
    });
    const headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
    const initial = await app.inject({ url: '/api/console/settings', headers });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      accounts: [],
      connection: { connected: false, ready: false },
    });
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'SAB purchase Card **1234 Amount SAR 1 at Example',
      receivedAt: now,
    });
    await processor.tick();
    expect(store.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
    const connected = await app.inject({
      method: 'POST',
      url: '/api/console/actual',
      headers,
      payload: {
        serverURL: 'http://actual:5006',
        password: 'actual-secret',
        syncId: 'budget-id',
        encryptionPassword: 'budget-secret',
      },
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({ connected: true, ready: false });
    expect(connected.body).not.toContain('actual-secret');
    expect(connected.body).not.toContain('budget-secret');
    await processor.tick();
    expect(store.get(id)?.status).toBe('queued');
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/console/settings',
      headers,
      payload: {
        accounts: [
          {
            id: 'checking',
            name: 'Current',
            type: 'checking',
            match: { bank: 'sab', accountSuffixes: ['1234'] },
            cards: [],
          },
        ],
        bankFeesCategoryId: 'fees',
        eligibleCategoryIds: ['food'],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(connection!.canProcess()).toBe(true);
    await processor.tick();
    expect(store.get(id)?.status).toBe('imported');
    expect(imports).toHaveBeenCalledWith('checking', [
      expect.objectContaining({ amount: -100, category: 'food' }),
    ]);
    await app.close();
  });
  it('protects connection endpoints and rejects invalid connection details', async () => {
    const { app, headers } = await server(true, [], true);
    expect((await app.inject({ url: '/api/console/actual' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/actual',
          headers: { cookie: headers.cookie, origin: 'https://evil.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/actual',
          headers,
          payload: { serverURL: 'file:///etc/passwd', password: 'secret', syncId: 'id' },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
});

describe('SMS and logs hard reset', () => {
  it('clears local SMS and logs, moves the checkpoint to now, and retains settings and Actual data', async () => {
    const { app, headers, store, settings, config, actual, imports } = await server();
    settings.set('routing', settings.seed(config));
    settings.set('actualConnection', settings.encrypt('saved-actual-credentials'));
    settings.set('taskerKey', settings.encrypt('saved-tasker-key'));
    settings.saveAi({
      provider: 'openai',
      model: 'test-model',
      apiKey: 'saved-ai-key',
      minConfidence: 0.7,
    });
    settings.set('templates', [{ id: 'saved-template', sample: 'Saved SMS template' }]);
    settings.set('lastTaskerSync', now);
    settings.set('limit:credit', { cents: 100000, eventId: 'sms-imported' });
    const retainedSettings = store.db
      .prepare(
        "SELECT key,value FROM console_settings WHERE key NOT LIKE 'limit:%' AND key!='lastTaskerSync' ORDER BY key",
      )
      .all();
    const retainedOwner = store.db
      .prepare('SELECT id,userId,password FROM account ORDER BY id')
      .all();
    const checkpoint = store.startInboxSync(Date.now() - 10000);
    for (const [id, status] of [
      ['sms-imported', 'imported'],
      ['sms-queued', 'queued'],
      ['sms-failed', 'failed'],
    ] as const) {
      store.enqueue({ eventId: id, sender: 'SAB', message: `Private SMS ${id}`, receivedAt: now });
      store.update(id, status);
      store.recordEnrichment(id, 'success', { response: 'Private AI log' });
    }
    store.addBalance('checking', now, 10000, 'sms-imported');
    store.recordTransfer('sms-imported', 'checking', 'credit', -100, now);
    store.db
      .prepare('INSERT INTO console_overrides(event_id,value) VALUES(?,?)')
      .run('sms-queued', JSON.stringify({ merchant: 'Private review' }));
    store.putLocalMapping({
      account_id: 'checking',
      merchant_key: 'saved merchant',
      payee: 'Saved merchant',
      category_id: 'food',
      source_ref: 'manual-rule',
      decision_at: now,
    });
    const sync = vi.spyOn(actual, 'sync');
    const history = vi.spyOn(actual, 'transactions');
    const before = Date.now();
    const result = await app.inject({
      method: 'POST',
      url: '/api/console/data/reset',
      headers,
      payload: { confirmation: 'RESET' },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      deletedMessages: 3,
      deletedEnrichmentAttempts: 3,
      checkpoint: { rowId: 0 },
    });
    expect(result.json().deletedHistory).toBeGreaterThanOrEqual(3);
    expect(result.json().checkpoint.date).toBeGreaterThanOrEqual(before);
    expect(result.json().checkpoint.date).toBeLessThanOrEqual(Date.now());
    for (const table of [
      'events',
      'event_history',
      'enrichment_attempts',
      'balances',
      'transfers',
      'console_overrides',
    ]) {
      expect(
        (store.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count,
        table,
      ).toBe(0);
    }
    expect(store.db.prepare('SELECT key,value FROM console_settings ORDER BY key').all()).toEqual(
      retainedSettings,
    );
    expect(store.db.prepare('SELECT id,userId,password FROM account ORDER BY id').all()).toEqual(
      retainedOwner,
    );
    expect(store.mapping('checking', 'saved merchant')?.payee).toBe('Saved merchant');
    expect(sync).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(imports).not.toHaveBeenCalled();
    expect((await app.inject({ url: '/api/console/settings', headers })).statusCode).toBe(200);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/inbox-sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: {
        checkpoint,
        rows: [
          { rowId: 1, date: checkpoint.date + 1, sender: 'SAB', message: 'Old pending batch' },
        ],
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(store.list({ limit: 10 })).toEqual([]);
    await app.close();
  });
  it('requires owner authentication, same-origin requests, and the exact reset confirmation', async () => {
    const { app, headers, store } = await server();
    store.enqueue({ eventId: 'kept', sender: 'SAB', message: 'Keep this SMS', receivedAt: now });
    for (const confirmation of [undefined, '', 'reset', 'DELETE']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/console/data/reset',
            headers,
            payload: { confirmation },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/data/reset',
          headers: { origin, 'x-api-key': apiKey },
          payload: { confirmation: 'RESET' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/data/reset',
          headers: { cookie: headers.cookie, origin: 'https://evil.test' },
          payload: { confirmation: 'RESET' },
        })
      ).statusCode,
    ).toBe(403);
    expect(store.get('kept')).toBeDefined();
    await app.close();
  });
  it('refuses a reset while an import is in progress', async () => {
    const { app, headers, store, processor } = await server();
    store.enqueue({
      eventId: 'processing',
      sender: 'SAB',
      message: 'Keep this SMS',
      receivedAt: now,
    });
    store.update('processing', 'processing');
    vi.spyOn(processor, 'isBusy').mockReturnValue(true);
    const result = await app.inject({
      method: 'POST',
      url: '/api/console/data/reset',
      headers,
      payload: { confirmation: 'RESET' },
    });
    expect(result.statusCode).toBe(409);
    expect(store.get('processing')?.status).toBe('processing');
    await app.close();
  });
  it('rolls back the entire reset if clearing review data fails', async () => {
    const { app, headers, store, settings } = await server();
    store.enqueue({ eventId: 'kept', sender: 'SAB', message: 'Keep this SMS', receivedAt: now });
    store.recordEnrichment('kept', 'success', { response: 'Keep this AI log' });
    const checkpoint = store.startInboxSync(Date.now() - 10000);
    settings.set('lastTaskerSync', now);
    store.db.prepare('INSERT INTO console_overrides(event_id,value) VALUES(?,?)').run('kept', '{}');
    store.db.exec(
      "CREATE TRIGGER fail_reset BEFORE DELETE ON console_overrides BEGIN SELECT RAISE(ABORT,'injected reset failure'); END",
    );
    const result = await app.inject({
      method: 'POST',
      url: '/api/console/data/reset',
      headers,
      payload: { confirmation: 'RESET' },
    });
    expect(result.statusCode).toBe(500);
    expect(store.get('kept')).toBeDefined();
    expect(store.eventHistory('kept')).toHaveLength(1);
    expect(store.enrichmentAttempts('kept')).toHaveLength(1);
    expect(store.inboxCheckpoint()).toEqual(checkpoint);
    expect(settings.get('lastTaskerSync')).toBe(now);
    await app.close();
  });
});

describe('Tasker checkpoint controls', () => {
  it('defaults new checkpoints to now and keeps a saved checkpoint when the page or phone reloads', async () => {
    const { app, headers, store } = await server();
    const initial = await app.inject({ url: '/api/console/tasker/checkpoint', headers });
    expect(initial.json()).toEqual({ checkpoint: null });
    expect(store.inboxCheckpoint()).toBeUndefined();
    const before = Date.now();
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/console/tasker/checkpoint',
      headers,
      payload: { date: 'now', expected: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const checkpoint = saved.json().checkpoint;
    expect(checkpoint.rowId).toBe(0);
    expect(checkpoint.date).toBeGreaterThanOrEqual(before);
    expect(checkpoint.date).toBeLessThanOrEqual(Date.now());
    expect((await app.inject({ url: '/api/console/tasker/checkpoint', headers })).json()).toEqual({
      checkpoint,
    });
    expect(store.startInboxSync(checkpoint.date + 300000)).toEqual(checkpoint);
    await app.close();
  });
  it('lets the owner move backward and forward while keeping imported messages deduplicated', async () => {
    const { app, headers, store } = await server();
    const initial = store.startInboxSync(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const row = {
      rowId: 7,
      date: initial.date + 1000,
      sender: 'SAB',
      message: 'SAB purchase Card **1234 Amount SAR 1 at Example',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/inbox-sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: { checkpoint: initial, rows: [row] },
    });
    expect(first.statusCode, first.body).toBe(202);
    const eventId = first.json().results[0].eventId;
    store.update(eventId, 'imported');
    const older = await app.inject({
      method: 'PUT',
      url: '/api/console/tasker/checkpoint',
      headers,
      payload: { date: initial.date - 1000, expected: first.json().checkpoint },
    });
    expect(older.statusCode, older.body).toBe(200);
    expect(older.json().checkpoint).toEqual({ date: initial.date - 1000, rowId: 0 });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/inbox-sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: { checkpoint: older.json().checkpoint, rows: [row] },
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json().results[0]).toMatchObject({ eventId, outcome: 'duplicate' });
    const laterDate = Date.now() - 24 * 60 * 60 * 1000;
    const later = await app.inject({
      method: 'PUT',
      url: '/api/console/tasker/checkpoint',
      headers,
      payload: { date: laterDate, expected: replay.json().checkpoint },
    });
    expect(later.statusCode, later.body).toBe(200);
    expect(store.inboxCheckpoint()).toEqual({ date: laterDate, rowId: 0 });
    expect(store.get(eventId)?.status).toBe('imported');
    expect(store.list({ limit: 10 })).toHaveLength(1);
    const staleBatch = await app.inject({
      method: 'POST',
      url: '/api/v1/inbox-sync/batch',
      headers: { 'x-api-key': apiKey },
      payload: {
        checkpoint: replay.json().checkpoint,
        rows: [{ ...row, rowId: 8, date: row.date + 1000 }],
      },
    });
    expect(staleBatch.statusCode).toBe(409);
    expect(store.inboxCheckpoint()).toEqual({ date: laterDate, rowId: 0 });
    expect(store.list({ limit: 10 })).toHaveLength(1);
    await app.close();
  });
  it('rejects stale edits when Tasker creates or advances a checkpoint', async () => {
    const { app, headers, store } = await server();
    const initial = store.startInboxSync(Date.now() - 10000);
    const created = await app.inject({
      method: 'PUT',
      url: '/api/console/tasker/checkpoint',
      headers,
      payload: { date: 'now', expected: null },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json().checkpoint).toEqual(initial);
    store.commitInboxBatch(initial, [
      {
        row: { rowId: 4, date: initial.date + 1000, sender: null, message: null },
        skipped: 'empty',
      },
    ]);
    const advanced = store.inboxCheckpoint();
    const stale = await app.inject({
      method: 'PUT',
      url: '/api/console/tasker/checkpoint',
      headers,
      payload: { date: initial.date - 1000, expected: initial },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().checkpoint).toEqual(advanced);
    expect(store.inboxCheckpoint()).toEqual(advanced);
    await app.close();
  });
  it('restricts edits to the signed-in owner and rejects invalid or future dates', async () => {
    const { app, headers, store, settings } = await server();
    const initial = store.startInboxSync(Date.now() - 10000);
    expect((await app.inject('/api/console/tasker/checkpoint')).statusCode).toBe(401);
    await app.inject({ method: 'POST', url: '/api/console/tasker/rotate', headers, payload: {} });
    const taskerKey = settings.decrypt(settings.get<string>('taskerKey')!);
    const payload = { date: 'now', expected: initial };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/console/tasker/checkpoint',
          headers: { origin, 'x-api-key': taskerKey },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/console/tasker/checkpoint',
          headers: { cookie: headers.cookie, origin: 'https://evil.test' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    for (const date of [-1, 1.5, 'invalid', null, Number.MAX_SAFE_INTEGER, Date.now() + 60000]) {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/console/tasker/checkpoint',
            headers,
            payload: { date, expected: initial },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(store.inboxCheckpoint()).toEqual(initial);
    await app.close();
  });
});

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
  it('refreshes from Actual before reading balances and includes new transactions after Riyadh midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T21:01:00Z'));
    const { app, headers, actual } = await server();
    let remote: HistoricalTransaction[] = [
      { id: 'old', accountId: 'checking', date: '2026-11-05', amount: 50000 },
    ];
    let local = [...remote];
    let waitForSync = Promise.resolve();
    let syncStarted = () => {};
    const sync = vi.spyOn(actual, 'sync').mockImplementation(async () => {
      syncStarted();
      await waitForSync;
      local = structuredClone(remote);
    });
    const balances = vi.fn<NonNullable<ActualAdapter['accountBalance']>>(
      async (id, throughDate = '') =>
        local
          .filter((tx) => tx.accountId === id && tx.date <= throughDate)
          .reduce((sum, tx) => sum + (tx.amount ?? 0), 0),
    );
    actual.accountBalance = balances;
    const transactions = vi
      .spyOn(actual, 'transactions')
      .mockImplementation(async (id, start, end) =>
        local.filter((tx) => tx.accountId === id && tx.date >= start && tx.date <= end),
      );
    try {
      const initial = await app.inject({ url: '/api/console/summary', headers });
      expect(initial.json().accounts[0].balanceCents).toBe(50000);
      remote = [
        { ...remote[0]!, amount: 60000 },
        {
          id: 'new',
          accountId: 'checking',
          date: '2026-11-06',
          amount: -100,
          payeeName: 'New in Actual',
        },
      ];
      balances.mockClear();
      transactions.mockClear();
      let release!: () => void;
      waitForSync = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        syncStarted = resolve;
      });
      const pending = app
        .inject({ url: '/api/console/summary', headers })
        .then((response) => response);
      await started;
      expect(balances).not.toHaveBeenCalled();
      expect(transactions).not.toHaveBeenCalled();
      release();
      const refreshed = await pending;
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.headers['cache-control']).toBe('no-store');
      expect(refreshed.json().accounts[0].balanceCents).toBe(59900);
      expect(refreshed.json().transactions[0]).toMatchObject({
        id: 'new',
        date: '2026-11-06',
        payeeName: 'New in Actual',
      });
      expect(sync).toHaveBeenCalledTimes(2);
      expect(balances).toHaveBeenCalledWith('checking', '2026-11-06');
      expect(transactions).toHaveBeenCalledWith('checking', '1900-01-01', '2026-11-06', 10);
    } finally {
      await app.close();
    }
  });
  it('reports sync failures instead of returning an outdated overview as a successful refresh', async () => {
    const { app, headers, actual } = await server();
    vi.spyOn(actual, 'sync').mockRejectedValue(new Error('Actual unavailable'));
    const balances = vi.spyOn(actual, 'accountBalance');
    const transactions = vi.spyOn(actual, 'transactions');
    const response = await app.inject({ url: '/api/console/summary', headers });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('Could not refresh from Actual');
    expect(balances).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
    await app.close();
  });
  it.each([true, false])(
    'distinguishes a rejected suggestion from an applied category (snapshot %s)',
    async (snapshot) => {
      const { app, headers, store } = await server();
      const { id } = store.enqueue({
        sender: 'AlRajhiBank',
        message: 'AIR ARABI',
        receivedAt: now,
      });
      store.update(id, 'imported', {
        parsed: {
          bank: 'alrajhi',
          kind: 'purchase',
          amountCents: -94570,
          feeCents: 0,
          payee: 'AIR ARABI',
          occurredAt: now,
          note: 'Parsed alrajhi purchase',
          ...(snapshot ? { importCategoryId: null } : {}),
        },
        suggestion: {
          payee: 'Air Arabia',
          categoryId: 'food',
          confidence: 0.55,
          reason: 'No travel category available',
        },
      });
      store.recordEnrichment(id, 'llm_low_confidence', { threshold: 0.7, categoryApplied: false });
      const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
      expect(detail.json()).toMatchObject({
        categoryId: null,
        categoryNeedsAttention: true,
        categorySuggestion: {
          categoryId: 'food',
          confidence: 0.55,
          applied: false,
          threshold: 0.7,
        },
      });
      const list = await app.inject({ url: '/api/console/events', headers });
      expect(list.json().events.find((event: any) => event.id === id).categoryNeedsAttention).toBe(
        true,
      );
      await app.close();
    },
  );
  it.each(['history_hit', 'llm_success'])(
    'shows the category applied by a legacy %s decision',
    async (status) => {
      const { app, headers, store } = await server();
      const { id } = store.enqueue({ sender: 'SAB', message: 'Purchase', receivedAt: now });
      store.update(id, 'imported', {
        parsed: {
          bank: 'sab',
          kind: 'purchase',
          amountCents: -100,
          feeCents: 0,
          payee: 'Shop',
          occurredAt: now,
          note: 'Parsed sab purchase',
        },
        suggestion: { payee: 'Shop', categoryId: 'food', confidence: 0.9, reason: 'Known shop' },
      });
      store.recordEnrichment(id, status, {
        categoryId: 'food',
        threshold: 0.7,
        categoryApplied: true,
      });
      const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
      expect(detail.json()).toMatchObject({ categoryId: 'food', categoryNeedsAttention: false });
      await app.close();
    },
  );
  it('updates a linked imported transaction through the review API and rejects stale revisions', async () => {
    const { app, headers, store, actual, imports } = await server();
    const row = {
      id: 'linked-actual-id',
      accountId: 'checking',
      date: '2026-11-05',
      amount: -94570,
      payeeName: 'Air Arabia',
      notes: 'Changed in Actual',
      categoryId: undefined as string | undefined,
    };
    vi.spyOn(actual, 'transactions').mockImplementation(async (accountId) =>
      accountId === row.accountId ? [row] : [],
    );
    actual.updateTransactions = vi.fn(async (updates) => {
      const update = updates[0]!;
      Object.assign(row, {
        categoryId: update.categoryId ?? undefined,
        notes: update.notes,
        amount: update.amount,
      });
    });
    const { id } = store.enqueue({ sender: 'SAB', message: 'Original bank text', receivedAt: now });
    store.update(id, 'imported', {
      actualTransactionId: row.id,
      parsed: {
        bank: 'sab',
        kind: 'purchase',
        accountAlias: '1234',
        amountCents: -94570,
        feeCents: 0,
        payee: 'AIR ARABI',
        occurredAt: now,
        note: 'Parsed sab purchase',
      },
    });
    const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
    expect(detail.json().actualSync.form).toMatchObject({
      payee: 'Air Arabia',
      notes: 'Changed in Actual',
    });
    const edit = {
      ...detail.json().actualSync.form,
      categoryId: 'food',
      notes: 'Flight booking',
      actualRevision: detail.json().actualSync.revision,
    };
    const saved = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/action`,
      headers,
      payload: edit,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ updated: true });
    expect(row).toMatchObject({
      id: 'linked-actual-id',
      categoryId: 'food',
      notes: 'Flight booking',
    });
    expect(imports).not.toHaveBeenCalled();
    const stale = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/action`,
      headers,
      payload: edit,
    });
    expect(stale.statusCode).toBe(409);
    expect(actual.updateTransactions).toHaveBeenCalledTimes(1);
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
    store.putLocalMapping({
      account_id: 'checking',
      merchant_key: 'coffee shop',
      payee: 'AI guess',
      category_id: 'food',
      source_ref: 'ai-event',
      source: 'ai',
      decision_at: now,
    });
    const suggestions = await app.inject({ url: '/api/console/merchants', headers });
    expect(suggestions.json().merchants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'ai',
          reviewReason: 'AI suggestion — confirm before reuse',
        }),
      ]),
    );
    for (const merchant of ['Unknown merchant', 'Amazon sa 5/11/26 21:34']) {
      const invalid = await app.inject({
        method: 'PUT',
        url: '/api/console/merchants',
        headers,
        payload: { identifiers: [merchant], payee: 'Wrong', categoryId: 'food' },
      });
      expect(invalid.statusCode).toBe(409);
    }
    const edit = await app.inject({
      method: 'PUT',
      url: '/api/console/merchants',
      headers,
      payload: {
        identifiers: ['COFFEE SHOP'],
        payee: 'Coffee Shop',
        categoryId: 'food',
      },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(store.merchants.find('coffee shop')).toMatchObject({
      payee: 'Coffee Shop',
      category_id: 'food',
      source: 'local',
    });
    const confirmed = await app.inject({ url: '/api/console/merchants', headers });
    expect(
      confirmed
        .json()
        .merchants.find((m: { identifiers: string[] }) =>
          m.identifiers.some((i) => i.toLowerCase() === 'coffee shop'),
        ).reviewReason,
    ).toBeNull();
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
  it('rechecks retained Al Rajhi merchant keys without reimporting or editing Actual', async () => {
    const { app, headers, store, config, actual, imports, processor } = await server();
    config.accounts.push({
      id: 'alrajhi',
      key: 'alrajhi',
      name: 'Al Rajhi',
      match: { bank: 'alrajhi', accountSuffixes: ['4187'] },
    });
    const { id } = store.enqueue({
      sender: 'AlRajhiBank',
      receivedAt: now,
      message: 'شراء إنترنت بـSR 42.35\nعبر4187;فيزا\nلـAmazon sa\n8/11/26 00:31',
    });
    store.update(id, 'imported', {
      parsed: {
        bank: 'alrajhi',
        kind: 'purchase',
        accountAlias: '4187',
        amountCents: -4235,
        feeCents: 0,
        payee: 'Amazon sa 8/11/26 00:31',
        occurredAt: now,
        note: 'Old import',
      },
      actualTransactionId: 'existing-id',
    });
    store.putLocalMapping({
      account_id: 'alrajhi',
      merchant_key: 'amazon sa 8 11 26 00 31',
      payee: 'Amazon SA',
      category_id: 'food',
      source: 'ai',
      source_ref: id,
      decision_at: now,
    });
    const sync = vi.spyOn(actual, 'sync');
    const response = await app.inject({
      method: 'POST',
      url: '/api/console/merchants/recheck',
      headers,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ checked: 1, repaired: 1 });
    const list = await app.inject({ url: '/api/console/merchants', headers });
    expect(list.json().merchants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identifiers: ['Amazon sa'], source: 'ai' }),
      ]),
    );
    expect(store.get(id)?.actual_transaction_id).toBe('existing-id');
    expect(imports).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    vi.spyOn(processor, 'isBusy').mockReturnValue(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/merchants/recheck',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/merchants/recheck',
          headers: { origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
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
  it('prefills a retained review without changing its status or importing', async () => {
    const { app, headers, store, config, imports } = await server();
    config.accounts[1]!.match = { bank: 'alrajhi', accountSuffixes: ['7900'] };
    const { id } = store.enqueue({
      sender: 'AlRajhiBank',
      message:
        'حوالة محلية صادرةبـ200 SR\nمن7900\nلـ7001;Ammar Shehari\nرسوم:0.29 SR\n26/11/6 14:08',
      receivedAt: '2026-11-06T14:10:00+03:00',
    });
    store.update(id, 'needs_review', { parserReason: 'unrecognized_template' });
    const response = await app.inject({ url: `/api/console/events/${id}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'needs_review',
      parsed: null,
      parser_reason: 'unrecognized_template',
      sourceAccountId: 'credit',
      sourceBank: config.banks.find((bank) => bank.id === 'alrajhi')!.name,
      reviewDraft: {
        bank: 'alrajhi',
        kind: 'transfer_out',
        principalCents: -20000,
        feeCents: 29,
        payee: 'Ammar Shehari',
      },
    });
    expect(store.get(id)?.status).toBe('needs_review');
    expect(store.get(id)?.parsed).toBeNull();
    expect(imports).not.toHaveBeenCalled();
    await app.close();
  });
  it.each([
    ['2271', 'credit'],
    ['6599', null],
  ] as const)(
    'prefills Seven Gram and selects the account only when suffix %s matches',
    async (configuredSuffix, accountId) => {
      const { app, headers, store, config, imports } = await server();
      config.accounts[1]!.match = { bank: 'alrajhi', accountSuffixes: [configuredSuffix] };
      const { id } = store.enqueue({
        sender: 'AlRajhiBank',
        message: sevenGramMessage,
        receivedAt: sevenGramReceivedAt,
      });
      store.update(id, 'needs_review', {
        parserReason: 'malformed_notification',
        parserRevision: 16,
      });
      const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        status: 'needs_review',
        sourceAccountId: accountId,
        reviewDraft: {
          kind: 'purchase',
          accountAlias: '2271',
          principalCents: -1200,
          payee: 'Seven Gram',
          occurredAt: '2026-11-10T23:17:00.000+03:00',
        },
      });
      expect(store.get(id)?.parsed).toBeNull();
      expect(imports).not.toHaveBeenCalled();
      await app.close();
    },
  );
  it('leaves an ambiguous source account for the user to choose', async () => {
    const { app, headers, store } = await server();
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'Unfamiliar notification',
      receivedAt: now,
    });
    store.update(id, 'needs_review');
    const response = await app.inject({ url: `/api/console/events/${id}`, headers });
    expect(response.json()).toMatchObject({ sourceAccountId: null, reviewDraft: { bank: 'sab' } });
    await app.close();
  });
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
  it.each([
    ['transfer_out', -20000],
    ['transfer_in', 20000],
  ])('categorizes a reviewed external %s and its fee together', async (kind, amount) => {
    const { app, headers, store, processor, imports } = await server();
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'Unknown water transfer',
      receivedAt: now,
    });
    store.update(id, 'needs_review');
    const response = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/action`,
      headers,
      payload: {
        kind,
        accountId: 'checking',
        amountCents: 20000,
        feeCents: 29,
        payee: 'Water Provider',
        categoryId: 'food',
        occurredAt: now,
        notes: 'Water bill\nNovember 2026',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await processor.tick();
    expect(imports).toHaveBeenCalledTimes(2);
    expect(imports).toHaveBeenNthCalledWith(1, 'checking', [
      expect.objectContaining({
        amount,
        category: 'food',
        payee_name: 'Water Provider',
        notes: 'Water bill\nNovember 2026',
      }),
    ]);
    expect(imports).toHaveBeenNthCalledWith(2, 'checking', [
      expect.objectContaining({
        amount: -29,
        category: 'food',
        payee_name: 'Bank Fees',
        notes: 'Water bill\nNovember 2026',
      }),
    ]);
    expect(imports.mock.calls[0]![1][0]).not.toHaveProperty('payee');
    expect(store.get(id)?.status).toBe('imported');
    const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
    expect(detail.json()).toMatchObject({
      categoryId: 'food',
      notes: 'Water bill\nNovember 2026',
      targetAccountId: null,
    });
    expect(store.mapping('checking', 'water provider')).toMatchObject({ category_id: 'food' });
    if (kind === 'transfer_out') {
      const next = store.enqueue({
        sender: 'SAB',
        message: 'Transfer sent From: 1234 To: Water Provider Amount: SAR 210 Fees: SAR 0.29',
        receivedAt: now,
      });
      await processor.tick();
      expect(store.get(next.id)?.status).toBe('imported');
      expect(imports.mock.calls[2]![1][0]).toMatchObject({ amount: -21000, category: 'food' });
      expect(imports.mock.calls[3]![1][0]).toMatchObject({ amount: -29, category: 'food' });
    }
    await app.close();
  });
  it('keeps edited notes and category when retrying a failed external fee import', async () => {
    const { app, headers, store, processor, imports } = await server();
    imports
      .mockResolvedValueOnce({ added: ['principal-id'], updated: [], errors: [] })
      .mockRejectedValueOnce(new Error('Fee import failed'));
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'Unknown water transfer',
      receivedAt: now,
    });
    store.update(id, 'needs_review');
    const response = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/action`,
      headers,
      payload: {
        kind: 'transfer_out',
        accountId: 'checking',
        amountCents: 20000,
        feeCents: 29,
        payee: 'Water Provider',
        categoryId: 'food',
        occurredAt: now,
        notes: 'November water bill',
      },
    });
    expect(response.statusCode).toBe(200);
    await processor.tick();
    expect(store.get(id)).toMatchObject({ status: 'queued', error: 'Fee import failed' });
    const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
    expect(detail.json()).toMatchObject({
      categoryId: 'food',
      notes: 'November water bill',
      targetAccountId: null,
    });
    store.update(id, 'queued', { nextAttemptAt: new Date().toISOString() });
    await processor.tick();
    expect(store.get(id)?.status).toBe('imported');
    expect(imports.mock.calls[2]![1]).toEqual(imports.mock.calls[0]![1]);
    expect(imports.mock.calls[3]![1]).toEqual(imports.mock.calls[1]![1]);
    await app.close();
  });
  it.each(['', 'My edited notes'])(
    'preserves user notes verbatim, including an empty value (%j)',
    async (notes) => {
      const { app, headers, store, processor, imports } = await server();
      const { id } = store.enqueue({ sender: 'SAB', message: 'Unknown purchase', receivedAt: now });
      store.update(id, 'needs_review');
      const response = await app.inject({
        method: 'POST',
        url: `/api/console/events/${id}/action`,
        headers,
        payload: {
          kind: 'purchase',
          accountId: 'checking',
          amountCents: 20000,
          payee: 'Water Provider',
          categoryId: 'food',
          occurredAt: now,
          notes,
        },
      });
      expect(response.statusCode).toBe(200);
      await processor.tick();
      expect(imports).toHaveBeenCalledWith('checking', [expect.objectContaining({ notes })]);
      await app.close();
    },
  );
  it('prefills the notes that would be imported, including foreign-currency context', async () => {
    const { app, headers, store } = await server();
    const { id } = store.enqueue({ sender: 'SAB', message: 'Unknown purchase', receivedAt: now });
    store.update(id, 'failed', {
      parsed: {
        bank: 'sab',
        kind: 'purchase',
        amountCents: -20000,
        feeCents: 0,
        payee: 'Water Provider',
        occurredAt: now,
        note: 'Parsed sab purchase',
        foreign: { currency: 'USD', amount: 53.33 },
      },
    });
    const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
    expect(detail.json().notes).toBe('Parsed sab purchase | 53.33 USD');
    await app.close();
  });
  it.each([
    {
      name: 'a category on a linked transfer',
      fields: { categoryId: 'food', targetAccountId: 'credit' },
    },
    { name: 'an unknown category', fields: { categoryId: 'missing' } },
    { name: 'overlong notes', fields: { notes: 'x'.repeat(4001) } },
  ])('rejects $name', async ({ fields }) => {
    const { app, headers, store, imports } = await server();
    const { id } = store.enqueue({ sender: 'SAB', message: 'Unknown transfer', receivedAt: now });
    store.update(id, 'needs_review');
    const response = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/action`,
      headers,
      payload: {
        kind: 'transfer_out',
        accountId: 'checking',
        amountCents: 20000,
        payee: 'Water Provider',
        occurredAt: now,
        ...fields,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(imports).not.toHaveBeenCalled();
    expect(store.get(id)?.status).toBe('needs_review');
    await app.close();
  });
  it('leaves an uncategorized external transfer and its fee uncategorized', async () => {
    const { app, headers, store, processor, imports } = await server();
    const { id } = store.enqueue({ sender: 'SAB', message: 'Unknown transfer', receivedAt: now });
    store.update(id, 'needs_review');
    const response = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/action`,
      headers,
      payload: {
        kind: 'transfer_out',
        accountId: 'checking',
        amountCents: 20000,
        feeCents: 29,
        payee: 'Bank transfer',
        occurredAt: now,
      },
    });
    expect(response.statusCode).toBe(200);
    await processor.tick();
    expect(imports).toHaveBeenCalledTimes(2);
    for (const call of imports.mock.calls) expect(call[1][0]).not.toHaveProperty('category');
    await app.close();
  });
  it('does not pair an explicitly external transfer with an unrelated own-account transfer', async () => {
    const { app, headers, store, processor, imports } = await server();
    const previous = store.enqueue({
      sender: 'SAB',
      message: 'Prior own-account transfer',
      receivedAt: now,
    });
    store.update(previous.id, 'imported', {
      parsed: {
        bank: 'sab',
        kind: 'transfer_in',
        amountCents: 20000,
        principalCents: 20000,
        feeCents: 0,
        payee: 'Bank transfer',
        occurredAt: now,
        note: 'Previous transfer',
        explicitTransferAccountId: 'checking',
      },
    });
    store.recordTransfer(previous.id, 'credit', undefined, 20000, now);
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'Unknown water transfer',
      receivedAt: now,
    });
    store.update(id, 'needs_review');
    const response = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/action`,
      headers,
      payload: {
        kind: 'transfer_out',
        accountId: 'checking',
        amountCents: 20000,
        feeCents: 29,
        payee: 'Water Provider',
        categoryId: 'food',
        occurredAt: now,
      },
    });
    expect(response.statusCode).toBe(200);
    await processor.tick();
    expect(store.get(id)?.status).toBe('imported');
    expect(imports).toHaveBeenCalledTimes(2);
    expect(imports.mock.calls[0]![1][0]).toMatchObject({
      amount: -20000,
      category: 'food',
      payee_name: 'Water Provider',
    });
    await app.close();
  });
  it('applies a transfer template category only to external counterparties and their fees', async () => {
    const { app, headers, store, processor, imports } = await server();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/console/templates',
      headers,
      payload: {
        id: 'water-transfer',
        name: 'Water transfer',
        bank: 'sab',
        kind: 'transfer_out',
        categoryId: 'food',
        pattern: 'Transfer {amount} from {suffix} to {to} fee {fee}',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    for (const to of ['9999', '5678']) {
      const { id } = store.enqueue({
        sender: 'SAB',
        message: `Transfer 200 from 1234 to ${to} fee 0.29`,
        receivedAt: now,
      });
      await processor.tick();
      expect(store.get(id)?.status).toBe('imported');
    }
    expect(imports.mock.calls[0]![1][0]).toMatchObject({ amount: -20000, category: 'food' });
    expect(imports.mock.calls[1]![1][0]).toMatchObject({ amount: -29, category: 'food' });
    expect(imports.mock.calls[2]![1][0]).toMatchObject({ amount: -20000, payee: 'payee-credit' });
    expect(imports.mock.calls[2]![1][0]).not.toHaveProperty('category');
    expect(imports.mock.calls[3]![1][0]).toMatchObject({ amount: -29, category: 'fees' });
    await app.close();
  });
  it('discards unrelated Tasker messages without retaining their contents', async () => {
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
    expect(store.list({ limit: 10 })).toHaveLength(0);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM events').all())).not.toContain(
      'Unsupported test message',
    );
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
      url: '/api/auth/sign-in/password',
      headers: { origin: tailnetOrigin, host: '100.120.220.101:3002' },
      payload: { password: 'testpass' },
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

describe('password-only owner access', () => {
  it('rejects short passwords and missing API keys without creating an owner', async () => {
    const { app, store } = await server(false);
    const short = await app.inject({
      method: 'POST',
      url: '/api/console/setup',
      headers: { origin },
      payload: { password: '1234567', apiKey },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toContain('8 characters');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/console/setup',
          headers: { origin },
          payload: { password: 'testpass' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (store.db.prepare('SELECT COUNT(*) count FROM user').get() as { count: number }).count,
    ).toBe(0);
    await app.close();
  });
  it('requires the correct password and rejects caller-selected identities and legacy sign-in routes', async () => {
    const { app } = await server();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/password',
      headers: { origin },
      payload: { password: 'wrongpass' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.cookies).toEqual([]);
    for (const identity of [{ username: 'owner' }, { email: 'owner@example.com' }]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/sign-in/password',
            headers: { origin },
            payload: { password: 'testpass', ...identity },
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const path of ['username', 'email']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/auth/sign-in/${path}`,
            headers: { origin },
            payload: { password: 'testpass' },
          })
        ).statusCode,
      ).toBe(404);
    }
    await app.close();
  });
  it('limits repeated password attempts even with changing forwarded IP headers', async () => {
    const { app } = await server();
    let limited = false;
    for (let attempt = 0; attempt < 21; attempt++) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/password',
        headers: {
          origin,
          'x-forwarded-for': `192.0.2.${attempt}`,
          'x-real-ip': `192.0.2.${attempt}`,
          'cf-connecting-ip': `192.0.2.${attempt}`,
        },
        payload: { password: 'wrongpass' },
      });
      if (result.statusCode === 429) {
        limited = true;
        break;
      }
      expect(result.statusCode, result.body).toBe(401);
    }
    expect(limited).toBe(true);
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
      url: '/api/auth/sign-in/password',
      headers: { origin },
      payload: { password: 'newpass8' },
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().user.name).toBe('Owner');
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

describe('merchant identifiers and preferred names', () => {
  it('keeps exact SMS identifiers, defaults the name, and applies a name without requiring a category', async () => {
    const { app, headers, store, processor, imports } = await server();
    const id = store.enqueue({
      sender: 'SAB',
      message: 'SAB purchase Card **1234 Amount SAR 25 at COFFEE-HOUSE on 2026-11-05 10:00',
      receivedAt: now,
    }).id;
    await processor.tick();
    expect(store.merchantProfile('checking', 'COFFEE-HOUSE')).toMatchObject({
      merchant: 'COFFEE-HOUSE',
      payee: 'COFFEE-HOUSE',
      renamed: 0,
    });
    const list = (await app.inject({ url: '/api/console/merchants', headers })).json().merchants;
    expect(list).toContainEqual(
      expect.objectContaining({ identifiers: ['COFFEE-HOUSE'], payee: 'COFFEE-HOUSE' }),
    );
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/console/merchants',
      headers,
      payload: {
        id: store.merchants.find('COFFEE-HOUSE')!.id,
        identifiers: ['COFFEE-HOUSE'],
        payee: 'My coffee place',
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    store.enqueue({
      sender: 'SAB',
      message: 'SAB purchase Card **1234 Amount SAR 30 at COFFEE-HOUSE on 2026-11-06 10:00',
      receivedAt: now,
    });
    await processor.tick();
    expect(imports.mock.calls.at(-1)?.[1][0]).toMatchObject({
      payee_name: 'My coffee place',
      imported_payee: 'COFFEE-HOUSE',
    });
    expect(JSON.parse(store.get(id)!.parsed!).payee).toBe('COFFEE-HOUSE');
    await app.close();
  });
  it('updates only ordinary service-imported payees across accounts', async () => {
    const { app, headers, actual, store } = await server();
    actual.updatePayees = vi.fn(async () => {});
    const rows = [
      {
        id: 'own',
        importedId: 'sms:one',
        importedPayee: 'COFFEE-HOUSE',
        payeeName: 'Old',
        accountId: 'checking',
        date: '2026-11-05',
      },
      {
        id: 'other',
        importedId: 'sms:two',
        importedPayee: 'Other store',
        accountId: 'checking',
        date: '2026-11-05',
      },
      { id: 'manual', importedPayee: 'COFFEE-HOUSE', accountId: 'checking', date: '2026-11-05' },
      {
        id: 'transfer',
        importedId: 'sms:three',
        importedPayee: 'COFFEE-HOUSE',
        transferId: 'linked',
        accountId: 'checking',
        date: '2026-11-05',
      },
      {
        id: 'split',
        importedId: 'sms:four',
        importedPayee: 'COFFEE-HOUSE',
        isSplit: true,
        accountId: 'checking',
        date: '2026-11-05',
      },
      {
        id: 'credit-entry',
        importedId: 'sms:credit',
        importedPayee: 'COFFEE TERMINAL',
        payeeName: 'Old name',
        accountId: 'credit',
        date: '2026-11-05',
      },
    ];
    actual.transactions = vi.fn(async (id) => rows.filter((tx) => tx.accountId === id));
    const response = await app.inject({
      method: 'PUT',
      url: '/api/console/merchants',
      headers,
      payload: {
        identifiers: ['COFFEE-HOUSE', 'COFFEE TERMINAL'],
        payee: 'Coffee',
        categoryId: 'food',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().updated).toBe(2);
    expect(actual.updatePayees).toHaveBeenCalledWith(['own', 'credit-entry'], 'Coffee');
    expect(store.merchants.find('COFFEE-HOUSE')?.payee).toBe('Coffee');
    actual.updatePayees = vi.fn(async () => {
      throw new Error('Actual unavailable');
    });
    const failed = await app.inject({
      method: 'PUT',
      url: '/api/console/merchants',
      headers,
      payload: {
        id: store.merchants.find('COFFEE-HOUSE')!.id,
        identifiers: ['COFFEE-HOUSE'],
        payee: 'New',
      },
    });
    expect(failed.statusCode).toBe(409);
    expect(store.merchants.find('COFFEE-HOUSE')?.payee).toBe('Coffee');
    await app.close();
  });
});

describe('learn unsupported SMS formats', () => {
  const message = 'Receipt shop=Coffee; charged=25.50 SAR; card=1234; available=900.00';
  const selections = {
    merchant: { value: 'Coffee' },
    amount: { value: '25.50' },
    suffix: { value: '1234' },
    balance: { value: '900.00' },
  };
  it('learns and imports the original SMS and future matching messages through the durable queue', async () => {
    const { app, headers, store, processor, settings, imports } = await server();
    const id = store.enqueue({ sender: 'SAB', message, receivedAt: now }).id;
    await processor.tick();
    expect(store.get(id)?.status).toBe('unsupported_format');
    const filtered = await app.inject({
      url: '/api/console/events?status=unsupported_format',
      headers,
    });
    expect(filtered.json().events).toHaveLength(1);
    const response = await app.inject({
      method: 'POST',
      url: `/api/console/events/${id}/learn`,
      headers,
      payload: { name: 'Receipts', kind: 'purchase', selections, categoryId: 'food' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(settings.templates()[0]?.pattern).toBe(
      'Receipt shop={merchant}; charged={amount} SAR; card={suffix}; available={balance}',
    );
    await processor.tick();
    expect(store.get(id)?.status).toBe('imported');
    expect(imports.mock.calls[0]?.[1][0]).toMatchObject({
      amount: -2550,
      imported_payee: 'Coffee',
      category: 'food',
    });
    store.saveMerchantName('checking', 'Bakery', 'My bakery');
    store.enqueue({
      sender: 'SAB',
      message: message
        .replace('Coffee', 'Bakery')
        .replace('25.50', '40.00')
        .replace('900.00', '860.00'),
      receivedAt: now,
    });
    await processor.tick();
    expect(imports.mock.calls.at(-1)?.[1][0]).toMatchObject({
      amount: -4000,
      payee_name: 'My bakery',
      category: 'food',
    });
    expect(imports).toHaveBeenCalledTimes(2);
    await app.close();
  });
  it('rejects invalid selections and unsafe rules without saving or queuing anything', async () => {
    const { app, headers, store, processor, settings, imports } = await server();
    const id = store.enqueue({ sender: 'SAB', message, receivedAt: now }).id;
    await processor.tick();
    for (const bad of [
      { ...selections, merchant: { value: 'Imaginary' } },
      { ...selections, amount: { value: '25.50', start: 0 } },
      { ...selections, merchant: { value: 'Coffee; charged=25.50' } },
      { ...selections, amount: { value: 'Coffee' } },
      { ...selections, suffix: undefined },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/console/events/${id}/learn`,
        headers,
        payload: { name: 'Unsafe', kind: 'purchase', selections: bad },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(settings.templates()).toHaveLength(0);
      expect(store.get(id)?.status).toBe('unsupported_format');
    }
    expect(imports).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/console/events/${id}/learn`,
          headers: { origin },
          payload: { name: 'Unsafe', kind: 'purchase', selections },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
  it('only exposes configured bank senders to Tasker, and fails closed before routing setup', async () => {
    const { app, config, store } = await server();
    const start = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/start',
      headers: { 'x-api-key': apiKey },
      payload: {},
    });
    expect(start.json().senders).toEqual(banks.find((b) => b.id === 'sab')!.senders);
    expect(start.json().senderFilter).toContain('LOWER(TRIM(address)) IN');
    store.db.exec(
      "CREATE TEMP TABLE phone_inbox(address TEXT); INSERT INTO phone_inbox VALUES('sAb'),('SAB'),('Private contact'),('Unknown sender');",
    );
    expect(
      store.db.prepare(`SELECT address FROM phone_inbox WHERE ${start.json().senderFilter}`).all(),
    ).toEqual([{ address: 'sAb' }, { address: 'SAB' }]);
    config.accounts = [];
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/start',
      headers: { 'x-api-key': apiKey },
      payload: {},
    });
    expect(empty.json()).toMatchObject({ senders: [], senderFilter: '1=0' });
    await app.close();
  });
});

it('does not let a learned format override an ignored OTP', async () => {
  const { app, settings, store, processor, imports } = await server();
  settings.set('templates', [
    {
      id: 'otp-overlap',
      name: 'Unsafe receipt',
      bank: 'sab',
      kind: 'purchase',
      pattern: 'Verification code {amount}',
      enabled: true,
    },
  ]);
  const id = store.enqueue({
    sender: 'SAB',
    message: 'Verification code 1234',
    receivedAt: now,
  }).id;
  await processor.tick();
  expect(store.get(id)).toMatchObject({ status: 'ignored', parser_reason: 'otp_or_login' });
  expect(imports).not.toHaveBeenCalled();
  await app.close();
});

it('imports multiple SMS identifiers with the shared name and category while routing each card correctly', async () => {
  const { app, headers, store, processor, imports } = await server();
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/console/merchants',
    headers,
    payload: {
      payee: 'Shared cafe',
      identifiers: ['ALPHA CAFE POS', 'BETA CAFE TERMINAL'],
      categoryId: 'food',
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const before = saved.json().merchant.id;
  for (const [suffix, merchant] of [
    ['1234', 'ALPHA CAFE POS'],
    ['5678', 'BETA CAFE TERMINAL'],
  ]) {
    store.enqueue({
      sender: 'SAB',
      message: `SAB purchase Card **${suffix} Amount SAR 25 at ${merchant} on 2026-11-05 10:00`,
      receivedAt: now,
    });
    await processor.tick();
  }
  expect(imports.mock.calls.map((call) => call[0])).toEqual(['checking', 'credit']);
  for (const call of imports.mock.calls)
    expect(call[1][0]).toMatchObject({ payee_name: 'Shared cafe', category: 'food' });
  expect(imports.mock.calls[0]?.[1][0]?.imported_id).not.toBe(
    imports.mock.calls[1]?.[1][0]?.imported_id,
  );
  const list = (await app.inject({ url: '/api/console/merchants', headers })).json().merchants;
  expect(list).toEqual([
    expect.objectContaining({
      id: before,
      payee: 'Shared cafe',
      identifiers: ['ALPHA CAFE POS', 'BETA CAFE TERMINAL'],
    }),
  ]);
  await app.close();
});

describe('delete messages from the SMS inbox', () => {
  it('requires authentication, same-origin requests, confirmation and an explicit Actual choice', async () => {
    const { app, headers, store } = await server();
    const { id } = store.enqueue({
      sender: 'SAB',
      message: 'Delete this review SMS',
      receivedAt: now,
    });
    const url = `/api/console/events/${id}`;
    expect((await app.inject({ url: url + '/deletion' })).statusCode).toBe(401);
    const plan = (await app.inject({ url: url + '/deletion', headers })).json();
    expect(plan.transactionIds).toEqual([]);
    const payload = {
      confirmation: 'DELETE',
      deleteActual: false,
      eventRevision: plan.eventRevision,
    };
    expect(
      (await app.inject({ method: 'DELETE', url, headers: { origin }, payload })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers: { ...headers, origin: 'https://evil.test' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers,
          payload: { confirmation: 'DELETE', eventRevision: plan.eventRevision },
        })
      ).statusCode,
    ).toBe(400);
    expect(store.get(id)).toBeDefined();
    const response = await app.inject({ method: 'DELETE', url, headers, payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().deletedActual).toBe(false);
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    expect(store.claim()).toBeUndefined();
    await app.close();
  });
  it('keeps Actual entries by default and allows SMS-only deletion during an Actual outage', async () => {
    const { app, headers, store, actual } = await server();
    const { id } = store.enqueue({
      eventId: 'outage-delete',
      sender: 'SAB',
      message: 'Imported SMS',
      receivedAt: now,
    });
    store.update(id, 'imported', { actualTransactionId: 'old-id' });
    actual.sync = vi.fn(async () => {
      throw new Error('Actual is offline');
    });
    actual.deleteTransactions = vi.fn(async () => {});
    const url = `/api/console/events/${id}`;
    const plan = (await app.inject({ url: url + '/deletion', headers })).json();
    expect(plan).toMatchObject({ canDeleteActual: false, error: 'Actual is offline' });
    const response = await app.inject({
      method: 'DELETE',
      url,
      headers,
      payload: { confirmation: 'DELETE', deleteActual: false, eventRevision: plan.eventRevision },
    });
    expect(response.statusCode).toBe(200);
    expect(actual.deleteTransactions).not.toHaveBeenCalled();
    expect(
      store.enqueue({ eventId: id, sender: 'SAB', message: 'Imported SMS', receivedAt: now })
        .duplicate,
    ).toBe(false);
    await app.close();
  });
  it('requires a fresh Actual confirmation, removes linked entries, and keeps an SMS on failure', async () => {
    const { app, headers, store, actual } = await server();
    const { id } = store.enqueue({ message: 'Imported SMS to delete', receivedAt: now });
    store.update(id, 'imported', { actualTransactionId: 'tx-id' });
    const rows: HistoricalTransaction[] = [
      { id: 'tx-id', accountId: 'checking', date: '2026-11-05', amount: -2500, payeeName: 'Shop' },
    ];
    actual.transactions = async (accountId) => rows.filter((r) => r.accountId === accountId);
    actual.deleteTransactions = vi.fn(async (ids) => {
      for (let i = rows.length - 1; i >= 0; i--) if (ids.includes(rows[i]!.id)) rows.splice(i, 1);
    });
    const url = `/api/console/events/${id}`;
    const plan = (await app.inject({ url: url + '/deletion', headers })).json();
    const payload = {
      confirmation: 'DELETE',
      deleteActual: true,
      eventRevision: plan.eventRevision,
      actualRevision: plan.revision,
    };
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers,
          payload: { ...payload, actualRevision: undefined },
        })
      ).statusCode,
    ).toBe(400);
    rows[0]!.amount = -3000;
    expect((await app.inject({ method: 'DELETE', url, headers, payload })).statusCode).toBe(409);
    expect(actual.deleteTransactions).not.toHaveBeenCalled();
    const fresh = (await app.inject({ url: url + '/deletion', headers })).json();
    vi.mocked(actual.deleteTransactions).mockRejectedValueOnce(new Error('Actual write failed'));
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers,
          payload: { ...payload, actualRevision: fresh.revision },
        })
      ).statusCode,
    ).toBe(409);
    expect(store.get(id)).toBeDefined();
    expect(
      (await app.inject({ url: '/api/console/events', headers })).json().events[0].deletionPending,
    ).toBe(true);
    expect(
      (await app.inject({ method: 'POST', url: url + '/action', headers, payload: {} })).statusCode,
    ).toBe(409);
    const retry = (await app.inject({ url: url + '/deletion', headers })).json();
    const result = await app.inject({
      method: 'DELETE',
      url,
      headers,
      payload: { ...payload, eventRevision: retry.eventRevision, actualRevision: retry.revision },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(rows).toEqual([]);
    expect(store.get(id)).toBeUndefined();
    await app.close();
  });
  it('blocks deleting processing messages and stale confirmations after queue progress', async () => {
    const { app, headers, store } = await server();
    const { id } = store.enqueue({ message: 'Pending SMS', receivedAt: now });
    const url = `/api/console/events/${id}`;
    const plan = (await app.inject({ url: url + '/deletion', headers })).json();
    store.claim();
    expect((await app.inject({ url: url + '/deletion', headers })).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers,
          payload: {
            confirmation: 'DELETE',
            deleteActual: false,
            eventRevision: plan.eventRevision,
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(store.get(id)?.status).toBe('processing');
    await app.close();
  });
});

it('restores a deleted inbox SMS after rewinding Tasker and deduplicates later resyncs', async () => {
  const { app, store, headers } = await server();
  const checkpoint = store.startInboxSync(1000);
  const row = { rowId: 1, date: 1001, sender: 'SAB', message: 'A bank SMS to restore' };
  const taskerHeaders = { 'x-api-key': apiKey };
  const submit = (cursor: typeof checkpoint) =>
    app.inject({
      method: 'POST',
      url: '/v1/inbox-sync/batch',
      headers: taskerHeaders,
      payload: { checkpoint: cursor, rows: [row] },
    });
  const first = await submit(checkpoint);
  expect(first.statusCode).toBe(202);
  const id = first.json().results[0].eventId;
  const preview = (await app.inject({ url: `/api/console/events/${id}/deletion`, headers })).json();
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/console/events/${id}`,
    headers,
    payload: { confirmation: 'DELETE', deleteActual: false, eventRevision: preview.eventRevision },
  });
  expect(deleted.statusCode).toBe(200);
  expect(store.get(id)).toBeUndefined();
  expect(store.inboxCheckpoint()).toEqual({ date: row.date, rowId: row.rowId });
  const rewind = await app.inject({
    method: 'POST',
    url: '/v1/inbox-sync/rewind',
    headers: taskerHeaders,
    payload: { date: checkpoint.date },
  });
  const restored = await submit(rewind.json().checkpoint);
  expect(restored.json().results[0]).toMatchObject({ eventId: id, outcome: 'queued' });
  expect(JSON.parse(store.get(id)!.payload!).message).toBe(row.message);
  const inbox = (await app.inject({ url: '/api/console/events', headers })).json();
  expect(inbox.events).toHaveLength(1);
  const again = await app.inject({
    method: 'POST',
    url: '/v1/inbox-sync/rewind',
    headers: taskerHeaders,
    payload: { date: checkpoint.date },
  });
  expect((await submit(again.json().checkpoint)).json().results[0].outcome).toBe('duplicate');
  expect((await app.inject({ url: '/api/console/events', headers })).json().events).toHaveLength(1);
  await app.close();
});

it('clears category warnings for existing linked repayments on both SMS sides using one Actual snapshot', async () => {
  const { app, headers, store, actual, imports } = await server();
  const cases = [
    {
      id: 'checking-entry',
      accountId: 'checking',
      alias: '1234',
      amount: -97323,
      kind: 'card_payment',
      target: 'credit',
      otherId: 'credit-entry',
      snapshot: true,
    },
    {
      id: 'credit-entry',
      accountId: 'credit',
      alias: '5678',
      amount: 97323,
      kind: 'transfer_in',
      target: 'checking',
      otherId: 'checking-entry',
      snapshot: true,
    },
    {
      id: 'legacy-repayment',
      accountId: 'credit',
      alias: '5678',
      amount: 15000,
      kind: 'transfer_in',
      target: undefined,
      otherId: 'legacy-checking',
      snapshot: false,
    },
  ] as const;
  const rows: HistoricalTransaction[] = cases.map((c) => ({
    id: c.id,
    accountId: c.accountId,
    date: '2026-11-05',
    amount: c.amount,
    payeeName: 'Transfer',
    transferId: c.otherId,
    transferAccountId: c.target,
  }));
  actual.transactions = vi.fn(async (accountId) =>
    rows.filter((row) => row.accountId === accountId),
  );
  actual.updateTransactions = vi.fn(async () => {});
  const sync = vi.spyOn(actual, 'sync');
  const before = new Map<string, string | null>();
  for (const c of cases) {
    store.enqueue({ eventId: c.id, sender: 'SAB', message: `Repayment ${c.id}`, receivedAt: now });
    store.update(c.id, 'imported', {
      actualTransactionId: c.id,
      parsed: {
        bank: 'sab',
        kind: c.kind,
        accountAlias: c.alias,
        amountCents: c.amount,
        feeCents: 0,
        payee: 'Bank transfer',
        occurredAt: now,
        note: 'Repayment',
        ...(c.kind === 'transfer_in' ? { cardPaymentReceived: true } : {}),
        ...(c.snapshot ? { importCategoryId: null } : {}),
      },
    });
    if (!c.snapshot) store.recordEnrichment(c.id, 'llm_low_confidence', {});
    before.set(c.id, store.get(c.id)!.parsed);
  }
  const paired = store.enqueue({
    eventId: 'paired-repayment-sms',
    sender: 'SAB',
    message: 'Second SMS for the linked repayment',
    receivedAt: now,
  });
  store.update(paired.id, 'imported', {
    parsed: {
      bank: 'sab',
      kind: 'transfer_in',
      cardPaymentReceived: true,
      accountAlias: '5678',
      amountCents: 97323,
      feeCents: 0,
      payee: 'Bank transfer',
      occurredAt: now,
      note: 'Linked counterpart SMS',
      importCategoryId: null,
    },
  });
  store.recordTransfer(paired.id, 'credit', '1234', 97323, now, 'checking-entry');
  before.set(paired.id, store.get(paired.id)!.parsed);
  const list = await app.inject({ url: '/api/console/events', headers });
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().events).toHaveLength(cases.length + 1);
  for (const event of list.json().events) expect(event.categoryNeedsAttention).toBe(false);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(actual.transactions).toHaveBeenCalledTimes(2);
  for (const c of [...cases, { id: paired.id }]) {
    const detail = await app.inject({ url: `/api/console/events/${c.id}`, headers });
    expect(detail.json().categoryNeedsAttention).toBe(false);
    expect(store.get(c.id)!.parsed).toBe(before.get(c.id));
  }
  expect(imports).not.toHaveBeenCalled();
  expect(actual.updateTransactions).not.toHaveBeenCalled();
  await app.close();
});

it('keeps category warnings for unlinked receipts and purchases, including when Actual is unavailable', async () => {
  const { app, headers, store, actual } = await server();
  const rows: HistoricalTransaction[] = [];
  for (const kind of ['transfer_in', 'card_payment', 'purchase'] as const) {
    const id = kind + '-uncategorized';
    store.enqueue({ eventId: id, sender: 'SAB', message: id, receivedAt: now });
    store.update(id, 'imported', {
      actualTransactionId: id,
      parsed: {
        bank: 'sab',
        kind,
        accountAlias: '1234',
        amountCents: kind === 'transfer_in' ? 97323 : -97323,
        feeCents: 0,
        payee: 'Unlinked payment',
        occurredAt: now,
        note: 'Uncategorized',
        importCategoryId: null,
        ...(kind === 'transfer_in' ? { cardPaymentReceived: true } : {}),
      },
    });
    rows.push({ id, accountId: 'checking', amount: 97323, date: '2026-11-05' });
  }
  actual.transactions = async (accountId) => rows.filter((row) => row.accountId === accountId);
  const list = await app.inject({ url: '/api/console/events', headers });
  expect(list.json().events.every((event: any) => event.categoryNeedsAttention)).toBe(true);
  vi.spyOn(actual, 'sync').mockRejectedValueOnce(new Error('Actual is offline'));
  const offline = await app.inject({ url: '/api/console/events', headers });
  expect(offline.statusCode).toBe(200);
  expect(offline.json().events.every((event: any) => event.categoryNeedsAttention)).toBe(true);
  await app.close();
});

it('retains linked repayment outcomes while Actual is busy or offline, including legacy paired SMS', async () => {
  const { app, headers, store, actual, processor } = await server();
  for (const id of ['confirmed-link', 'legacy-debit', 'legacy-receipt', 'external']) {
    store.enqueue({ eventId: id, sender: 'SAB', message: id, receivedAt: now });
    store.update(id, 'imported', {
      parsed: {
        bank: 'sab',
        kind: id === 'legacy-debit' ? 'card_payment' : 'transfer_in',
        accountAlias: id === 'legacy-debit' ? '1234' : '5678',
        amountCents: id === 'legacy-debit' ? -97323 : 97323,
        feeCents: 0,
        payee: 'Bank transfer',
        occurredAt: now,
        note: 'Repayment',
        ...(id !== 'legacy-debit'
          ? { importCategoryId: null }
          : { transferCounterpartyAlias: '5678' }),
        ...(id === 'confirmed-link'
          ? { importTransferAccountId: 'checking' }
          : id === 'external'
            ? { importTransferAccountId: null }
            : {}),
      },
    });
  }
  store.recordTransfer('legacy-debit', 'checking', '5678', -97323, now);
  store.recordTransfer('legacy-receipt', 'credit', undefined, 97323, now, 'legacy-debit');
  actual.sync = vi.fn(async () => {
    throw new Error('Actual offline');
  });
  for (const busy of [false, true]) {
    let release: () => void = () => {};
    const holding = busy
      ? processor.withActualAccess(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        )
      : Promise.resolve();
    try {
      const list = await app.inject({ url: '/api/console/events', headers });
      for (const event of list.json().events)
        expect(event.categoryNeedsAttention).toBe(event.id === 'external');
      for (const id of ['confirmed-link', 'legacy-receipt']) {
        const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
        expect(detail.json().categoryNeedsAttention).toBe(false);
      }
    } finally {
      release();
      await holding;
    }
  }
  await app.close();
});

it('rejects unrelated and unconfigured inbox senders from old Tasker projects while advancing the checkpoint', async () => {
  const { app, headers, store } = await server();
  const checkpoint = store.startInboxSync(1000);
  const messages = [
    { sender: 'Private friend', message: 'Personal text mentioning SAB' },
    { sender: 'AlRajhiBank', message: 'Unselected bank content' },
    { sender: null, message: 'SAB Purchase SAR 10' },
    { sender: 'SAB', message: 'Unknown bank format' },
  ];
  const response = await app.inject({
    method: 'POST',
    url: '/v1/inbox-sync/batch',
    headers: { 'x-api-key': apiKey },
    payload: {
      checkpoint,
      rows: messages.map((row, i) => ({ ...row, rowId: i + 1, date: 1001 + i })),
    },
  });
  expect(response.statusCode, response.body).toBe(202);
  expect(response.json().results.map((r: any) => r.outcome)).toEqual([
    'unsupported',
    'unsupported',
    'unsupported',
    'queued',
  ]);
  expect(response.json().checkpoint).toEqual({ date: 1004, rowId: 4 });
  const list = await app.inject({ url: '/api/console/events', headers });
  expect(list.json().events).toHaveLength(1);
  expect(list.json().events[0].input.message).toBe('Unknown bank format');
  await app.close();
});

it('returns exact teaching suggestions for unknown wording without treating hints as a supported format', async () => {
  const { app, headers, store, processor, imports } = await server();
  const message = 'تنبيه جديد ١٬٢٣٤٫٥٦ SR\nمن١٢٣٤\nرسوم:٠٫٢٩ SR\nرصيد:٩٠٠٠ SR';
  const { id } = store.enqueue({ sender: 'SAB', message, receivedAt: now });
  await processor.tick();
  expect(store.get(id)?.status).toBe('unsupported_format');
  const detail = await app.inject({ url: `/api/console/events/${id}`, headers });
  expect(detail.json()).toMatchObject({
    sourceAccountId: 'checking',
    reviewDraft: { principalCents: -123456 },
    reviewSelections: {
      amount: { value: '١٬٢٣٤٫٥٦' },
      suffix: { value: '١٢٣٤' },
      fee: { value: '٠٫٢٩' },
      balance: { value: '٩٠٠٠' },
    },
  });
  expect(imports).not.toHaveBeenCalled();
  await app.close();
});
