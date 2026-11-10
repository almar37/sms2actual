import { randomBytes, randomUUID } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { InboxCheckpointConflict, type EventStore, type StoredEvent } from './db.js';
import type {
  ActualAdapter,
  Enricher,
  ResolvedConfig,
  ParsedTransaction,
  SmsInput,
} from './types.js';
import type { Processor } from './processor.js';
import {
  ConsoleConfig,
  consoleSettingsSchema,
  aiSettingsSchema,
  templateSchema,
  templateDateFormatSchema,
  compileMessageTemplate,
  matchMessageTemplate,
  actionSchema,
} from './console-config.js';
import type { ConsoleAuth } from './console-auth.js';
import { validateAccountRules } from './config.js';
import { merchantKey } from './merchant-resolver.js';
import { merchantReviewReason } from './merchant-identity.js';
import { extractReviewDraft, parseSms } from './parser.js';
import { resolveSmsSource } from './sms-source.js';
import { resolveAccount, resolveTransferTarget } from './routing.js';
import { generateTaskerProject } from './tasker-export.js';
import { currentBudgetDate } from './budget-date.js';
import { actualConnectionSchema, type ActualConnection } from './actual-connection.js';
import { readMessageActual, saveMessageActual, type MessageActualState } from './message-sync.js';
import { transactionNotes } from './transaction-notes.js';
import {
  deleteMessageActual,
  messageImportIds,
  messageRevision,
  planMessageDeletion,
} from './message-delete.js';
import { patternFromSelections, selectionFields } from './template-selection.js';

export interface ConsoleOptions {
  auth: ConsoleAuth;
  settings: ConsoleConfig;
  actual: ActualAdapter;
  config: ResolvedConfig;
  publicUrl: string;
  actualServerUrl?: string;
  requireSetupKey?: boolean;
  connection?: Pick<ActualConnection, 'status' | 'connect' | 'initialize'>;
  onRoutingChanged?: () => Promise<void>;
  trustedOrigins?: string[];
  enricher: Enricher;
  taskerTemplatePath?: string;
}
const readJson = (value: string | null) => (value ? JSON.parse(value) : null);
const eventView = (e: StoredEvent) => {
  const parsed = readJson(e.parsed) as ParsedTransaction | null;
  const imported = e.status === 'imported' || e.status === 'imported_review';
  const categoryNeedsAttention =
    imported &&
    parsed?.kind !== 'withdrawal' &&
    (parsed?.importCategoryId === null ||
      (parsed?.importCategoryId === undefined &&
        e.enrichment_status?.startsWith('llm_') &&
        e.enrichment_status !== 'llm_success'));
  return {
    ...e,
    input: readJson(e.payload),
    parsed,
    suggestion: readJson(e.suggestion),
    categoryNeedsAttention: Boolean(categoryNeedsAttention),
    payload: undefined,
  };
};
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
  app.post('/api/console/data/reset', async (req, reply) => {
    const body = z
      .object({ confirmation: z.literal('RESET') })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Type RESET to confirm clearing SMS and logs' });
    // Keep this check and the transaction synchronous so a new queue claim cannot
    // start between them. An in-flight import must finish before it can be erased.
    if (processor.isBusy?.())
      return reply
        .code(409)
        .send({ error: 'A message is being processed. Try the reset again in a moment.' });
    return store.db.transaction(() => {
      const result = store.resetSmsData();
      options.settings.clearSmsState();
      return result;
    })();
  });
  app.get(
    '/api/console/actual',
    async () =>
      options.connection?.status() ?? {
        configured: true,
        connected: true,
        connecting: false,
        ready: Boolean(options.config.accounts.length && options.config.bankFeesCategoryId),
        serverURL: options.actualServerUrl ?? '',
        syncId: '',
        error: null,
      },
  );
  app.post('/api/console/actual', async (req, reply) => {
    if (!options.connection)
      return reply.code(409).send({ error: 'Connection is managed by the service environment' });
    const parsed = actualConnectionSchema.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'Enter a valid Actual server address, password, and budget Sync ID' });
    if (options.connection.status().connecting)
      return reply.code(409).send({ error: 'An Actual connection is already in progress' });
    try {
      await options.connection.connect(parsed.data);
      await options.onRoutingChanged?.();
      return options.connection.status();
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Could not connect to Actual' });
    }
  });
  app.post('/api/console/actual/reconnect', async (_req, reply) => {
    if (!options.connection?.status().configured)
      return reply.code(409).send({ error: 'Save an Actual connection first' });
    if (options.connection.status().connecting)
      return reply.code(409).send({ error: 'An Actual connection is already in progress' });
    try {
      await options.connection.initialize();
      await options.onRoutingChanged?.();
      return options.connection.status();
    } catch {
      return reply
        .code(400)
        .send({ error: 'Could not reconnect to Actual. Check your connection settings.' });
    }
  });
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
      actualServerUrl: options.connection?.status().serverURL ?? options.actualServerUrl ?? '',
      connection: options.connection?.status(),
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
      await options.onRoutingChanged?.();
      return { ok: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Invalid configuration' });
    }
  });
  app.get('/api/console/summary', async (_req, reply) => {
    try {
      await options.actual.sync();
    } catch {
      return reply.code(503).send({
        error: 'Could not refresh from Actual. Check the connection and try again.',
      });
    }
    const accounts = await options.actual.accounts();
    const date = currentBudgetDate();
    const data = await Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balanceCents: options.actual.accountBalance
          ? await options.actual.accountBalance(a.id, date)
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
            'unsupported_format',
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
      events: rows.map((e) => ({
        ...eventView(e),
        deletionPending: Boolean(store.pendingDeletion(e.id)),
      })),
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
    const input = readJson(event.payload) as SmsInput | null;
    const reviewDraft =
      ['needs_review', 'unsupported_format'].includes(event.status) && input
        ? extractReviewDraft(
            input.message,
            input.receivedAt,
            options.config.banks,
            input.sender ?? '',
            options.config.parsing,
          )
        : null;
    const hints = tx ?? reviewDraft;
    const override = store.db
      .prepare('SELECT value FROM console_overrides WHERE event_id=?')
      .get(event.id) as { value: string } | undefined;
    const manual = readJson(override?.value ?? null) as {
      accountId?: string;
      categoryId?: string;
    } | null;
    const manualAccount = options.config.accounts.find(
      (account) => account.id === manual?.accountId,
    );
    const accounts = hints?.bank
      ? options.config.accounts.filter(
          (account) =>
            account.match.bank === hints.bank &&
            (!hints.kind ||
              !account.match.transactionKinds?.length ||
              account.match.transactionKinds.includes(hints.kind)) &&
            (!hints.accountAlias || account.match.accountSuffixes?.includes(hints.accountAlias)),
        )
      : [];
    const attempts = store.enrichmentAttempts(event.id);
    const lastDecision = attempts.at(-1);
    const decision = lastDecision ? readJson(lastDecision.details) : null;
    const suggestion = readJson(event.suggestion);
    const imported = event.status === 'imported' || event.status === 'imported_review';
    const categoryId =
      tx?.importCategoryId !== undefined
        ? tx.importCategoryId
        : (manual?.categoryId ??
          (lastDecision?.status === 'history_hit'
            ? decision?.categoryId
            : lastDecision?.status === 'llm_success'
              ? suggestion?.categoryId
              : null));
    let actualState: MessageActualState | undefined;
    let syncError: string | undefined;
    if (imported) {
      if (!options.actual.updateTransactions)
        syncError = 'Actual transaction editing is unavailable';
      else
        try {
          actualState = await processor.withActualAccess(() =>
            readMessageActual(options.actual, store, options.config, event),
          );
        } catch (error) {
          syncError = error instanceof Error ? error.message : String(error);
        }
    }
    return {
      ...eventView(event),
      deletionPending: Boolean(store.pendingDeletion(event.id)),
      reviewDraft,
      categoryNeedsAttention: actualState
        ? !actualState.form.categoryId &&
          !actualState.form.targetAccountId &&
          actualState.form.kind !== 'withdrawal'
        : eventView(event).categoryNeedsAttention,
      actualSync: imported
        ? { form: actualState?.form, revision: actualState?.revision, error: syncError }
        : null,
      sourceBank: options.config.banks.find((bank) => bank.id === hints?.bank)?.name ?? null,
      sourceAccountId: manualAccount?.id ?? (accounts.length === 1 ? accounts[0]!.id : null),
      targetAccountId,
      categoryId: imported
        ? (categoryId ?? null)
        : (manual?.categoryId ?? suggestion?.categoryId ?? null),
      categorySuggestion: suggestion
        ? {
            ...suggestion,
            applied:
              !eventView(event).categoryNeedsAttention &&
              (tx?.importCategoryId === suggestion.categoryId ||
                lastDecision?.status === 'llm_success'),
            threshold: decision?.threshold ?? null,
          }
        : null,
      notes: tx
        ? transactionNotes(tx, event.status === 'imported_review')
        : 'Reviewed in sms2actual',
      history: store.eventHistory(event.id),
      enrichmentAttempts: attempts,
    };
  });
  app.get<{ Params: { id: string } }>('/api/console/events/:id/deletion', async (req, reply) => {
    const event = store.get(req.params.id);
    if (!event) return reply.code(404).send({ error: 'Message not found' });
    if (event.status === 'processing')
      return reply.code(409).send({ error: 'This message is being processed. Try again shortly.' });
    try {
      const read = () => planMessageDeletion(options.actual, store, options.config, event);
      const plan =
        event.parsed || event.actual_transaction_id || store.pendingDeletion(event.id)
          ? await processor.withActualAccess(read)
          : await read();
      return { ...plan, canDeleteActual: Boolean(options.actual.deleteTransactions), error: null };
    } catch (error) {
      return {
        eventRevision: messageRevision(event),
        transactions: [],
        canDeleteActual: false,
        error: error instanceof Error ? error.message : 'Could not check linked Actual entries',
      };
    }
  });
  app.delete<{ Params: { id: string } }>('/api/console/events/:id', async (req, reply) => {
    const body = z
      .object({
        confirmation: z.literal('DELETE'),
        deleteActual: z.boolean(),
        eventRevision: z.string().min(1),
        actualRevision: z.string().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ error: 'Confirm deletion and choose whether to keep the Actual transaction' });
    const event = store.get(req.params.id);
    if (!event) return reply.code(404).send({ error: 'Message not found' });
    if (event.status === 'processing' || messageRevision(event) !== body.data.eventRevision)
      return reply.code(409).send({
        error: 'This message changed or is being processed. Refresh the deletion confirmation.',
      });
    if (!body.data.deleteActual) {
      if (processor.isBusy())
        return reply
          .code(409)
          .send({ error: 'A message or Actual operation is in progress. Try again shortly.' });
      store.deleteMessage(event.id, undefined, [], messageImportIds(options.config, event));
      return { ok: true, deletedActual: false };
    }
    if (!body.data.actualRevision)
      return reply
        .code(400)
        .send({ error: 'Load the linked Actual entries before confirming their deletion' });
    try {
      const deleted = await processor.withActualAccess(() =>
        deleteMessageActual(
          options.actual,
          store,
          options.config,
          event,
          body.data.actualRevision!,
        ),
      );
      return { ok: true, deletedActual: true, deletedTransactions: deleted };
    } catch (error) {
      return reply.code(409).send({
        error:
          error instanceof Error
            ? error.message
            : 'Could not delete linked Actual entries. The SMS was kept.',
      });
    }
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
      notes: z.string().max(4000).optional(),
      actualRevision: z.string().length(64).optional(),
    })
    .strict();
  app.post<{ Params: { id: string } }>('/api/console/events/:id/action', async (req, reply) => {
    const event = store.get(req.params.id);
    if (!event) return reply.code(404).send({ error: 'Message not found' });
    if (store.pendingDeletion(event.id))
      return reply.code(409).send({ error: 'Finish deleting this message before editing it' });
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
    if (transfer && body.targetAccountId && body.categoryId)
      return reply
        .code(400)
        .send({ error: 'Transfers between your accounts use an account instead of a category' });
    if (!transfer && body.targetAccountId)
      return reply.code(400).send({ error: 'Only transfers can have a counterparty account' });
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
      explicitTransferAccountId: transfer ? body.targetAccountId || null : undefined,
      note: body.notes ?? 'Reviewed in sms2actual',
    };
    if (!Number.isSafeInteger(transaction.amountCents))
      return reply.code(400).send({ error: 'Amount and fees exceed the supported range' });
    const current = store.get(event.id);
    if (!current) return reply.code(404).send({ error: 'Message was deleted' });
    if (store.pendingDeletion(event.id))
      return reply.code(409).send({ error: 'Finish deleting this message before editing it' });
    if (current.status === 'processing')
      return reply
        .code(409)
        .send({ error: 'This message is being processed. Refresh before reviewing it.' });
    const imported =
      current.status === 'imported' ||
      current.status === 'imported_review' ||
      Boolean(current.actual_transaction_id);
    if (imported) {
      if (!body.actualRevision)
        return reply.code(409).send({
          error: 'Reopen this message to load its current Actual transaction before saving',
        });
      try {
        await processor.withActualAccess(() =>
          saveMessageActual(
            options.actual,
            store,
            options.config,
            current,
            body,
            body.actualRevision!,
          ),
        );
        return { ok: true, updated: true };
      } catch (error) {
        return reply.code(409).send({
          error:
            error instanceof Error
              ? error.message
              : 'Could not update Actual. Reopen this message and try again',
        });
      }
    }
    if (processor.isBusy())
      return reply
        .code(409)
        .send({ error: 'A message or Actual operation is in progress. Try again shortly.' });
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
  app.post<{ Params: { id: string } }>('/api/console/events/:id/learn', async (req, reply) => {
    const event = store.get(req.params.id);
    if (!event?.payload) return reply.code(404).send({ error: 'Original SMS is unavailable' });
    if (
      event.status !== 'unsupported_format' &&
      !(
        event.status === 'needs_review' &&
        ['unrecognized_template', 'malformed_notification'].includes(event.parser_reason ?? '')
      )
    )
      return reply
        .code(409)
        .send({ error: 'Only an unsupported format can be taught from this message' });
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        kind: actionSchema,
        categoryId: z.string().optional(),
        dateFormat: templateDateFormatSchema.optional(),
        selections: z.record(
          z.enum(selectionFields),
          z
            .object({
              value: z.string().min(1).max(4000),
              start: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Select the SMS fields and a transaction action' });
    const input = JSON.parse(event.payload) as SmsInput;
    try {
      const source = resolveSmsSource(input.sender ?? '', input.message, options.config.banks);
      if (source.type === 'unsupported')
        throw new Error('Choose a supported bank sender before teaching a format');
      if (!(await validateCategory(body.data.categoryId)))
        throw new Error('Choose an existing category');
      const selections = body.data.selections;
      if (['purchase', 'refund'].includes(body.data.kind) && !selections.merchant)
        throw new Error('Select the merchant text from the SMS');
      if (
        selections.fee &&
        !['transfer_in', 'transfer_out', 'card_payment'].includes(body.data.kind)
      )
        throw new Error(
          'Separate fees are supported on transfers and card payments. For other actions, select the full charged amount.',
        );
      const template = templateSchema.parse({
        id: randomUUID(),
        name: body.data.name,
        bank: source.bank,
        kind: body.data.kind,
        pattern: patternFromSelections(input.message, selections),
        dateFormat: body.data.dateFormat,
        sample: input.message,
        sender: input.sender,
        categoryId: body.data.categoryId,
      });
      const transaction = matchMessageTemplate(
        template,
        input.message,
        input.receivedAt,
        source.bank,
      );
      if (!transaction) throw new Error('The selected fields do not safely match this SMS');
      if (
        merchantReviewReason(transaction.payee) &&
        ['purchase', 'refund'].includes(transaction.kind)
      )
        throw new Error('Select only the merchant description, without dates or amounts');
      if (!resolveAccount(options.config.accounts, transaction))
        throw new Error(
          'Select the account/card suffix from the SMS and configure its account routing',
        );
      const conflicting = options.settings
        .templates()
        .some((t) => matchMessageTemplate(t, input.message, input.receivedAt, source.bank));
      if (conflicting)
        throw new Error('An active template already matches this SMS. Edit that template instead.');
      // Recheck after asynchronous validation; the event may have been approved in another tab.
      const current = store.get(event.id);
      if (!current) return reply.code(404).send({ error: 'Message was deleted' });
      if (current.status !== event.status)
        return reply
          .code(409)
          .send({ error: 'This message changed. Reopen it before teaching the format.' });
      store.db.transaction(() => {
        options.settings.set('templates', [...options.settings.templates(), template]);
        store.update(event.id, 'queued', { attempts: 0, nextAttemptAt: new Date().toISOString() });
        store.db
          .prepare(
            'INSERT INTO event_history(event_id,from_status,to_status,details,created_at) VALUES(?,?,?,?,?)',
          )
          .run(
            event.id,
            'queued',
            'queued',
            JSON.stringify({ learnedFormat: { templateId: template.id, selections } }),
            new Date().toISOString(),
          );
      })();
      void processor.tick();
      return { ok: true, template, transaction };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Could not learn this format' });
    }
  });
  app.get('/api/console/merchants', async () => {
    store.seedMerchantProfiles(options.config.accounts);
    return { merchants: store.merchants.list() };
  });
  app.post('/api/console/merchants/recheck', async (_req, reply) => {
    if (processor.isBusy())
      return reply
        .code(409)
        .send({ error: 'A message is being processed. Try the recheck again in a moment.' });
    return processor.recheckMerchants();
  });
  app.put('/api/console/merchants', async (req, reply) => {
    const body = z
      .object({
        id: z.string().optional(),
        identifiers: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
        payee: z.string().trim().min(1).max(100),
        categoryId: z.string().min(1).nullable().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ error: 'Enter a preferred name and at least one SMS identifier' });
    const b = body.data;
    if (!(await validateCategory(b.categoryId ?? undefined)))
      return reply.code(400).send({ error: 'Choose an existing category' });
    try {
      store.merchants.validateEdit(b.id, b.payee, b.identifiers);
      const result = await processor.withActualAccess(async () => {
        const related = store.merchants.validateEdit(b.id, b.payee, b.identifiers);
        const keys = new Set(
          [
            ...b.identifiers,
            ...related.filter((m) => m.id !== b.id).flatMap((m) => m.identifiers),
          ].map(merchantKey),
        );
        const ids = new Set<string>();
        if (options.actual.updatePayees) {
          await options.actual.sync();
          for (const account of await options.actual.accounts()) {
            const history = await options.actual.transactions(
              account.id,
              '1900-01-01',
              currentBudgetDate(),
            );
            for (const tx of history) {
              if (!tx.importedId?.startsWith('sms:') && !tx.importedId?.startsWith('sms-edit:'))
                continue;
              const description = tx.importedPayee;
              const repair = description
                ? store.merchantRepair(account.id, merchantKey(description))
                : undefined;
              if (
                description &&
                keys.has(merchantKey(repair?.merchant ?? description)) &&
                !tx.transferId &&
                !tx.transferAccountId &&
                !tx.isSplit &&
                tx.payeeName !== b.payee
              )
                ids.add(tx.id);
            }
          }
          if (ids.size) await options.actual.updatePayees([...ids], b.payee);
          await options.actual.sync();
        }
        const existing = b.id ? store.merchants.get(b.id) : related[0];
        const merchant = store.merchants.save(
          b.id,
          b.payee,
          b.identifiers,
          b.categoryId === undefined ? (existing?.category_id ?? null) : b.categoryId,
        );
        return { merchant, updated: ids.size };
      });
      return { ok: true, ...result };
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : 'Could not update the merchant' });
    }
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
  app.get('/api/console/tasker/checkpoint', async () => ({
    checkpoint: store.inboxCheckpoint() ?? null,
  }));
  app.put('/api/console/tasker/checkpoint', async (req, reply) => {
    const timestamp = z.number().int().safe().min(0).max(8_640_000_000_000_000);
    const body = z
      .object({
        date: z.union([z.literal('now'), timestamp]),
        expected: z
          .object({ date: timestamp, rowId: z.number().int().safe().min(0) })
          .strict()
          .nullable(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Choose a valid checkpoint date and time' });
    const now = Date.now();
    const date = body.data.date === 'now' ? now : body.data.date;
    if (date > now)
      return reply.code(400).send({ error: 'The checkpoint cannot be in the future' });
    try {
      return store.setInboxCheckpoint(date, body.data.expected);
    } catch (error) {
      if (error instanceof InboxCheckpointConflict)
        return reply.code(409).send({
          error:
            'The inbox checkpoint changed. Its latest position has been loaded; try saving again.',
          checkpoint: error.checkpoint,
        });
      throw error;
    }
  });
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
