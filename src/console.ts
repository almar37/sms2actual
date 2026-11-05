import { randomBytes } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { EventStore, StoredEvent } from './db.js';
import type { ActualAdapter, Enricher, ResolvedConfig, ParsedTransaction } from './types.js';
import type { Processor } from './processor.js';
import {
  ConsoleConfig,
  consoleSettingsSchema,
  aiSettingsSchema,
  templateSchema,
  compileMessageTemplate,
  matchMessageTemplate,
  actionSchema,
} from './console-config.js';
import type { ConsoleAuth } from './console-auth.js';
import { validateAccountRules } from './config.js';
import { merchantKey } from './merchant-resolver.js';
import { parseSms } from './parser.js';
import { resolveSmsSource } from './sms-source.js';
import { resolveTransferTarget } from './routing.js';
import { generateTaskerProject } from './tasker-export.js';

export interface ConsoleOptions {
  auth: ConsoleAuth;
  settings: ConsoleConfig;
  actual: ActualAdapter;
  config: ResolvedConfig;
  publicUrl: string;
  actualServerUrl?: string;
  trustedOrigins?: string[];
  enricher: Enricher;
  taskerTemplatePath?: string;
}
const readJson = (value: string | null) => (value ? JSON.parse(value) : null);
const eventView = (e: StoredEvent) => ({
  ...e,
  input: readJson(e.payload),
  parsed: readJson(e.parsed),
  suggestion: readJson(e.suggestion),
  payload: undefined,
});
export function registerConsole(
  app: FastifyInstance,
  options: ConsoleOptions,
  store: EventStore,
  processor: Processor,
) {
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/console/') || route === '/api/console/setup') return;
    const session = await options.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return reply.code(401).send({ error: 'Please sign in' });
  });
  const validateCategory = async (id?: string) =>
    !id || (await options.actual.categories()).some((c) => c.id === id && !c.hidden);
  app.get('/api/console/settings', async () => {
    const [accounts, categories] = await Promise.all([
      options.actual.accounts(),
      options.actual.categories(),
    ]);
    return {
      settings: options.settings.seed(options.config),
      accounts,
      categories: categories.filter((c) => !c.hidden),
      banks: options.config.banks,
      publicUrl: options.publicUrl,
      actualUrl: options.settings.get('actualUrl') ?? '',
      actualServerUrl: options.actualServerUrl ?? '',
      limits: Object.fromEntries(
        accounts.map((a) => [a.id, options.settings.get(`limit:${a.id}`)]),
      ),
    };
  });
  app.put('/api/console/settings', async (req, reply) => {
    const parsed = consoleSettingsSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Invalid settings', details: parsed.error.issues });
    const [accounts, categories] = await Promise.all([
      options.actual.accounts(),
      options.actual.categories(),
    ]);
    const settings = parsed.data;
    if (processor.isBusy?.())
      return reply
        .code(409)
        .send({ error: 'A message is being processed. Please save again in a moment.' });
    try {
      if (new Set(settings.accounts.map((a) => a.id)).size !== settings.accounts.length)
        throw new Error('Configure each Actual account once');
      for (const a of settings.accounts) {
        const account = accounts.find((current) => current.id === a.id);
        if (!account) throw new Error('Choose an existing open Actual account');
        a.name = account.name;
        if (!options.config.banks.some((b) => b.id === a.match.bank && b.disposition === 'import'))
          throw new Error('Choose a supported bank');
        if (
          !a.match.accountSuffixes?.length &&
          !a.cards.length &&
          !a.match.transactionKinds?.length &&
          a.match.hasBalance === undefined
        )
          throw new Error('Add an account or card suffix');
        if (
          a.fundingAccountId &&
          (a.fundingAccountId === a.id ||
            !accounts.some((current) => current.id === a.fundingAccountId))
        )
          throw new Error('Choose a different open account for repayments');
        if (a.type !== 'credit' && a.cards.some((c) => c.type === 'credit'))
          throw new Error('Credit cards must be linked to a credit card account');
      }
      if (!categories.some((c) => c.id === settings.bankFeesCategoryId && !c.hidden && !c.isIncome))
        throw new Error('Choose a Bank Fees expense category');
      if (
        settings.eligibleCategoryIds.some(
          (id) => !categories.some((c) => c.id === id && !c.hidden && !c.isIncome),
        )
      )
        throw new Error('Choose existing expense categories for enrichment');
      validateAccountRules(
        settings.accounts.map((a) => ({
          actualName: a.name,
          match: {
            ...a.match,
            accountSuffixes: [...(a.match.accountSuffixes ?? []), ...a.cards.map((c) => c.suffix)]
              .length
              ? [...(a.match.accountSuffixes ?? []), ...a.cards.map((c) => c.suffix)]
              : undefined,
          },
        })),
      );
      options.settings.set('routing', settings);
      options.settings.apply(settings, options.config, categories);
      return { ok: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Invalid configuration' });
    }
  });
  app.get('/api/console/summary', async () => {
    await options.actual.sync();
    const accounts = await options.actual.accounts();
    const date = new Date().toISOString().slice(0, 10);
    const data = await Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balanceCents: options.actual.accountBalance
          ? await options.actual.accountBalance(a.id)
          : null,
        transactions: await options.actual.transactions(a.id, '1900-01-01', date, 10),
      })),
    );
    const counts = store.db
      .prepare('SELECT status,COUNT(*) count FROM events GROUP BY status')
      .all();
    return {
      accounts: data.map(({ transactions: _transactions, ...a }) => a),
      transactions: data
        .flatMap((a) => a.transactions.map((t) => ({ ...t, accountName: a.name })))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
        .slice(0, 10),
      counts,
      lastTaskerSync: options.settings.get('lastTaskerSync') ?? null,
    };
  });
  app.get('/api/console/events', async (req, reply) => {
    const query = z
      .object({
        search: z.string().max(200).default(''),
        status: z
          .enum([
            'all',
            'queued',
            'processing',
            'imported',
            'ignored',
            'needs_review',
            'imported_review',
            'failed',
          ])
          .default('all'),
        sort: z.enum(['created_at', 'status', 'sender', 'received_at']).default('created_at'),
        direction: z.enum(['asc', 'desc']).default('desc'),
        page: z.coerce.number().int().min(1).max(1000000).default(1),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid log filters' });
    const q = query.data;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status !== 'all') {
      where.push('status=?');
      params.push(q.status);
    }
    if (q.search) {
      where.push('(payload LIKE ? OR id LIKE ?)');
      params.push(`%${q.search}%`, `%${q.search}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sort = {
      created_at: 'created_at',
      status: 'status',
      sender: "json_extract(payload,'$.sender')",
      received_at: "json_extract(payload,'$.receivedAt')",
    }[q.sort];
    const total = (
      store.db.prepare(`SELECT COUNT(*) total FROM events ${clause}`).get(...params) as {
        total: number;
      }
    ).total;
    const rows = store.db
      .prepare(
        `SELECT * FROM events ${clause} ORDER BY ${sort} ${q.direction},id ${q.direction} LIMIT 50 OFFSET ?`,
      )
      .all(...params, (q.page - 1) * 50) as StoredEvent[];
    return {
      events: rows.map(eventView),
      total,
      page: q.page,
      lastTaskerSync: options.settings.get('lastTaskerSync') ?? null,
    };
  });
  app.get<{ Params: { id: string } }>('/api/console/events/:id', async (req, reply) => {
    const event = store.get(req.params.id);
    if (!event) return reply.code(404).send({ error: 'Message not found' });
    const tx = readJson(event.parsed) as ParsedTransaction | null;
    let targetAccountId: string | null = null;
    if (tx && ['transfer_in', 'transfer_out', 'card_payment'].includes(tx.kind)) {
      try {
        targetAccountId = resolveTransferTarget(options.config.accounts, tx)?.id ?? null;
      } catch {
        // Ambiguous routes must remain inspectable so the owner can review them.
      }
    }
    return {
      ...eventView(event),
      targetAccountId,
      history: store.eventHistory(event.id),
      enrichmentAttempts: store.enrichmentAttempts(event.id),
    };
  });
  const action = z
    .object({
      kind: actionSchema,
      accountId: z.string().min(1),
      amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      feeCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
      payee: z.string().min(1).max(100),
      categoryId: z.string().optional(),
      targetAccountId: z.string().optional(),
      occurredAt: z.string().datetime({ offset: true }),
    })
    .strict();
  app.post<{ Params: { id: string } }>('/api/console/events/:id/action', async (req, reply) => {
    const event = store.get(req.params.id);
    if (!event) return reply.code(404).send({ error: 'Message not found' });
    const parsed = action.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'Check the amount, account, payee, and transaction date' });
    const body = parsed.data;
    const account = options.config.accounts.find((a) => a.id === body.accountId);
    if (!account || !(await validateCategory(body.categoryId)))
      return reply
        .code(400)
        .send({ error: 'Choose a configured account and an existing category' });
    if (
      body.targetAccountId &&
      (body.targetAccountId === body.accountId ||
        !(await options.actual.accounts()).some((a) => a.id === body.targetAccountId))
    )
      return reply.code(400).send({ error: 'Choose a different destination account' });
    if (event.status === 'processing')
      return reply
        .code(409)
        .send({ error: 'This message is being processed. Refresh before reviewing it.' });
    const transfer = ['transfer_in', 'transfer_out', 'card_payment'].includes(body.kind);
    if (transfer && body.categoryId)
      return reply.code(400).send({ error: 'Transfers use an account instead of a category' });
    if (!transfer && body.feeCents)
      return reply.code(400).send({
        error: 'Use fees on transfers and card payments, or map the message to a Bank fee',
      });
    const positive = ['refund', 'deposit', 'transfer_in'].includes(body.kind);
    const transaction: ParsedTransaction = {
      bank: account.match.bank,
      kind: body.kind,
      amountCents: positive
        ? body.amountCents
        : -(body.amountCents + (transfer ? body.feeCents : 0)),
      principalCents: transfer ? (positive ? body.amountCents : -body.amountCents) : undefined,
      feeCents: body.feeCents,
      payee: body.payee,
      occurredAt: body.occurredAt,
      explicitTransferAccountId: body.targetAccountId,
      note: 'Reviewed in sms2actual',
    };
    if (!Number.isSafeInteger(transaction.amountCents))
      return reply.code(400).send({ error: 'Amount and fees exceed the supported range' });
    const current = store.get(event.id)!;
    if (current.status === 'processing')
      return reply
        .code(409)
        .send({ error: 'This message is being processed. Refresh before reviewing it.' });
    const imported =
      current.status === 'imported' ||
      current.status === 'imported_review' ||
      Boolean(current.actual_transaction_id);
    if (imported)
      return reply.code(409).send({
        error:
          'Already imported. Edit the transaction in Actual; use Save as template or the merchant editor for future messages.',
      });
    store.db.transaction(() => {
      store.db
        .prepare(
          'INSERT INTO console_overrides(event_id,value) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET value=excluded.value',
        )
        .run(
          event.id,
          JSON.stringify({
            transaction,
            accountId: body.accountId,
            categoryId: body.categoryId,
            merchant: event.parsed
              ? (JSON.parse(event.parsed) as ParsedTransaction).payee
              : body.payee,
          }),
        );
      store.update(event.id, 'queued', {
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        parsed: transaction,
      });
    })();
    void processor.tick();
    return { ok: true };
  });
  app.get('/api/console/merchants', async () => ({
    merchants: store.db.prepare('SELECT * FROM merchant_mappings ORDER BY payee,account_id').all(),
  }));
  app.put('/api/console/merchants', async (req, reply) => {
    const body = z
      .object({
        accountId: z.string(),
        merchant: z.string().trim().min(1).max(200),
        payee: z.string().trim().min(1).max(100),
        categoryId: z.string(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Enter a merchant, payee, account, and category' });
    const b = body.data;
    if (
      !(await options.actual.accounts()).some((a) => a.id === b.accountId) ||
      !b.categoryId ||
      !(await validateCategory(b.categoryId))
    )
      return reply.code(400).send({ error: 'Choose an existing account and category' });
    store.putLocalMapping({
      account_id: b.accountId,
      merchant_key: merchantKey(b.merchant),
      payee: b.payee,
      category_id: b.categoryId,
      source_ref: `console:${b.accountId}:${merchantKey(b.merchant)}`,
      decision_at: new Date().toISOString(),
    });
    return { ok: true };
  });
  app.get('/api/console/templates', async () => ({
    templates: options.settings.templates(),
    grammar: options.config.parsing.shared.kinds.map((r) => ({
      kind: r.value,
      patterns: r.patterns.map((p) => p.source),
    })),
    bankTemplates: options.config.parsing.templates.map((t) => ({
      id: t.id,
      kind: t.kind,
      banks: options.config.banks.filter((b) => b.templates?.includes(t.id)).map((b) => b.name),
      fields: Object.keys(t.fields),
      patterns: t.match.map((p) => p.source),
    })),
  }));
  app.put('/api/console/templates', async (req, reply) => {
    const body = templateSchema.safeParse(req.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ error: 'Check the template name, bank, action, and message pattern' });
    try {
      if (!options.config.banks.some((b) => b.id === body.data.bank && b.disposition === 'import'))
        throw new Error('Choose a supported bank');
      if (!(await validateCategory(body.data.categoryId)))
        throw new Error('Choose an existing category');
      if (
        ['transfer_in', 'transfer_out', 'card_payment'].includes(body.data.kind) &&
        body.data.categoryId
      )
        throw new Error('Transfers do not use categories');
      compileMessageTemplate(body.data.pattern);
      options.settings.set('templates', [
        ...options.settings.templates().filter((t) => t.id !== body.data.id),
        body.data,
      ]);
      return { ok: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Invalid template' });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/console/templates/:id', async (req) => {
    options.settings.set(
      'templates',
      options.settings.templates().filter((t) => t.id !== req.params.id),
    );
    return { ok: true };
  });
  app.post('/api/console/parse', async (req, reply) => {
    const body = z
      .object({
        message: z.string().min(1).max(20000),
        sender: z.string().max(100),
        receivedAt: z.string().datetime({ offset: true }),
        template: templateSchema.optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Enter a message, sender, and valid date' });
    const b = body.data;
    try {
      const source = resolveSmsSource(b.sender, b.message, options.config.banks);
      if (b.template) {
        const transaction =
          source.type !== 'unsupported'
            ? matchMessageTemplate(b.template, b.message, b.receivedAt, source.bank)
            : undefined;
        return transaction
          ? { type: 'transaction', transaction }
          : { type: 'needs_review', reason: 'Template or bank sender does not match' };
      }
      const matching =
        source.type !== 'unsupported'
          ? options.settings
              .templates()
              .map((t) => matchMessageTemplate(t, b.message, b.receivedAt, source.bank))
              .filter(Boolean)
          : [];
      if (matching.length > 1) return { type: 'needs_review', reason: 'ambiguous_template' };
      if (matching[0]) return { type: 'transaction', transaction: matching[0] };
      return parseSms(
        b.message,
        b.receivedAt,
        options.config.banks,
        b.sender,
        options.config.parsing,
      );
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Could not parse the template' });
    }
  });
  app.get('/api/console/ai', async () => {
    const ai = options.settings.ai();
    return { ...ai, apiKey: undefined, hasKey: Boolean(ai.apiKey) };
  });
  app.put('/api/console/ai', async (req, reply) => {
    const body = aiSettingsSchema.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Check the provider, model, and confidence threshold' });
    try {
      options.settings.saveAi(body.data);
      processor.setMinConfidence(body.data.minConfidence);
      return { ok: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Could not save AI settings' });
    }
  });
  app.post('/api/console/ai/test', async (req, reply) => {
    const body = z
      .object({ merchant: z.string().min(1).max(100) })
      .strict()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Enter a merchant to test' });
    const result = await options.enricher.enrich({
      merchant: body.data.merchant,
      occurredAt: new Date().toISOString(),
      categories: options.config.eligibleCategories,
    });
    return result;
  });
  app.get('/api/console/ai/models', async (_req, reply) => {
    const ai = options.settings.ai();
    if (ai.provider === 'disabled' || !ai.apiKey)
      return reply.code(400).send({ error: 'Save a provider and API key first' });
    const endpoint = {
      openai: 'https://api.openai.com/v1/models',
      anthropic: 'https://api.anthropic.com/v1/models',
      opencode: 'https://opencode.ai/inference/go/openai/v1/models',
    }[ai.provider];
    try {
      const response = await fetch(endpoint, {
        headers:
          ai.provider === 'anthropic'
            ? { 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01' }
            : { authorization: `Bearer ${ai.apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        return reply.code(400).send({
          error: `Provider returned HTTP ${response.status}. Enter a model ID manually if listing is unavailable.`,
        });
      const data = (await response.json()) as { data?: { id: string }[] };
      return {
        models: (data.data ?? [])
          .map((m) => m.id)
          .filter((id) => typeof id === 'string')
          .sort(),
      };
    } catch {
      return reply.code(502).send({ error: 'Could not load models. Enter a model ID manually.' });
    }
  });
  app.put('/api/console/preferences', async (req, reply) => {
    const body = z
      .object({
        actualUrl: z
          .string()
          .url()
          .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Enter an HTTP or HTTPS URL for Actual' });
    options.settings.set('actualUrl', body.data.actualUrl);
    return { ok: true };
  });
  app.get('/api/console/ai/logs', async () => ({
    logs: (
      store.db.prepare('SELECT * FROM enrichment_attempts ORDER BY id DESC LIMIT 100').all() as {
        details: string;
      }[]
    ).map((l) => ({ ...l, details: readJson(l.details) })),
  }));
  app.post('/api/console/tasker/credentials', async (_req, reply) => {
    const encrypted = options.settings.get<string>('taskerKey');
    if (!encrypted) return reply.code(409).send({ error: 'Generate a Tasker credential first' });
    return reply
      .header('cache-control', 'no-store')
      .send({ apiKey: options.settings.decrypt(encrypted), serviceUrl: options.publicUrl });
  });
  app.post('/api/console/tasker/rotate', async () => {
    options.settings.set(
      'taskerKey',
      options.settings.encrypt(randomBytes(32).toString('base64url')),
    );
    return { ok: true };
  });
  app.post('/api/console/tasker/export', async (req, reply) => {
    const body = z.object({ url: z.string().url() }).strict().safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Enter the public HTTPS origin for this service' });
    const encryptedKey = options.settings.get<string>('taskerKey');
    const key = encryptedKey ? options.settings.decrypt(encryptedKey) : undefined;
    if (!key) return reply.code(409).send({ error: 'Generate a Tasker credential first' });
    try {
      const result = await generateTaskerProject(body.data.url, key, options.taskerTemplatePath);
      return reply
        .type('application/xml')
        .header('cache-control', 'no-store')
        .header('content-disposition', 'attachment; filename="sms2actual.prj.xml"')
        .send(result);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Export failed' });
    }
  });
}
