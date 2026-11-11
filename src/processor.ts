import { matchMessageTemplate, type ConsoleConfig } from './console-config.js';
import { resolveSmsSource } from './sms-source.js';
import { stableId } from './transaction-id.js';
import { DateTime } from 'luxon';
import type {
  ActualAdapter,
  Enricher,
  ParsedTransaction,
  ResolvedConfig,
  SmsInput,
  AiSuggestion,
  ActualTransaction,
} from './types.js';
import { EventStore, type StoredEvent } from './db.js';
import { PARSER_REVISION, parseSms } from './parser.js';
import { resolveAccount, resolveTransferTarget } from './routing.js';
import { MerchantResolver, merchantKey } from './merchant-resolver.js';
import { transactionNotes } from './transaction-notes.js';
import { merchantReviewReason } from './merchant-identity.js';
import { recheckMerchants } from './merchant-recheck.js';

const retryMs = [60_000, 300_000, 1_800_000, 7_200_000];
// Historical imports used the parsed SMS suffix. Keep that stable whenever a
// source identifier was present, only falling back to the resolved account.
export class Processor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private merchantResolver: MerchantResolver;
  constructor(
    private store: EventStore,
    private actual: ActualAdapter,
    private ai: Enricher,
    private config: ResolvedConfig,
    private maxAttempts = 5,
    private minConfidence = 0.7,
    merchantResolver?: MerchantResolver,
    private consoleConfig?: ConsoleConfig,
    private canProcess: () => boolean = () => true,
  ) {
    this.merchantResolver = merchantResolver ?? new MerchantResolver(store, actual, config);
  }
  async withActualAccess<T>(work: () => Promise<T>): Promise<T> {
    if (this.running || !this.canProcess())
      throw new Error('Actual is busy or not ready. Refresh and try again.');
    this.running = true;
    try {
      return await work();
    } finally {
      this.running = false;
    }
  }
  isBusy() {
    return this.running;
  }
  setMinConfidence(value: number) {
    this.minConfidence = value;
  }
  refreshMappings() {
    return this.merchantResolver.refresh();
  }
  recheckMerchants() {
    return recheckMerchants(this.store, this.config);
  }
  start() {
    this.store.recover();
    this.store.replayParserRevision(PARSER_REVISION);
    this.timer = setInterval(() => void this.tick(), 500);
    void this.tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }
  async tick() {
    if (this.running || !this.canProcess()) return;
    const event = this.store.claim();
    if (!event) return;
    this.running = true;
    try {
      await this.process(event);
    } catch (error) {
      const attempts = event.attempts + 1,
        message = error instanceof Error ? error.message : String(error);
      if (attempts < this.maxAttempts)
        this.store.update(event.id, 'queued', {
          attempts,
          error: message,
          nextAttemptAt: new Date(
            Date.now() + (retryMs[attempts - 1] ?? retryMs.at(-1)!),
          ).toISOString(),
        });
      else this.store.update(event.id, 'failed', { attempts, error: message });
    } finally {
      this.running = false;
    }
  }
  private async importTransactions(accountId: string, transactions: ActualTransaction[]) {
    const imported = await this.actual.importTransactions(accountId, transactions);
    if (imported.errors.length)
      throw new Error(imported.errors.map((error) => error.message).join('; '));
    for (const transaction of transactions)
      if (transaction.imported_payee && transaction.payee_name)
        this.store.recordMerchantImport(
          transaction.imported_id,
          transaction.payee_name,
          transaction.category,
        );
    return imported;
  }
  private observeCreditLimit(input: SmsInput, eventId: string) {
    if (!this.consoleConfig) return;
    const source = resolveSmsSource(input.sender ?? '', input.message, this.config.banks);
    if (source.type === 'unsupported') return;
    const limit =
      /(?:credit\s+limit|الحد\s+الائتماني|حد\s+ائتماني)\s*[:：]?\s*(?:SAR|SR|ر\.س)?\s*([\d٠-٩][\d٠-٩,.]*)/iu.exec(
        input.message,
      );
    if (!limit) return;
    const normalize = (value: string) =>
      value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632));
    const alias = this.config.parsing.shared.fields.accountAlias
      ?.map((r) => r.exec(input.message)?.groups?.value)
      .find(Boolean);
    if (!alias) return;
    const accounts = this.config.accounts.filter(
      (a) => a.match.bank === source.bank && a.match.accountSuffixes?.includes(normalize(alias)),
    );
    const ids = [...new Set(accounts.map((a) => a.id))];
    if (
      ids.length !== 1 ||
      this.consoleConfig.seed(this.config).accounts.find((a) => a.id === ids[0])?.type !== 'credit'
    )
      return;
    const cents = Math.round(Number(normalize(limit[1]!).replaceAll(',', '')) * 100);
    const previous = this.consoleConfig.get<{ observedAt: string }>(`limit:${ids[0]}`);
    if (
      Number.isSafeInteger(cents) &&
      cents > 0 &&
      (!previous || Date.parse(previous.observedAt) <= Date.parse(input.receivedAt))
    )
      this.consoleConfig.set(`limit:${ids[0]}`, { cents, eventId, observedAt: input.receivedAt });
  }
  private async process(event: StoredEvent) {
    const input = JSON.parse(event.payload!) as SmsInput;
    this.observeCreditLimit(input, event.id);
    let result = parseSms(
      input.message,
      input.receivedAt,
      this.config.banks,
      input.sender,
      this.config.parsing,
    );
    const manualRow = this.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='console_overrides'")
      .get()
      ? (this.store.db
          .prepare('SELECT value FROM console_overrides WHERE event_id=?')
          .get(event.id) as { value: string } | undefined)
      : undefined;
    const manual = manualRow
      ? (JSON.parse(manualRow.value) as {
          transaction: ParsedTransaction;
          accountId: string;
          categoryId?: string;
          merchant?: string;
        })
      : undefined;
    let templateCategory: string | undefined;
    if (manual) result = { type: 'transaction', transaction: manual.transaction };
    else if (
      this.consoleConfig &&
      !(result.type === 'ignored' && result.reason !== 'unsupported_sender')
    ) {
      const source = resolveSmsSource(input.sender ?? '', input.message, this.config.banks);
      if (source.type !== 'unsupported') {
        const templates = this.consoleConfig
          .templates()
          .map((t) => ({
            template: t,
            transaction: matchMessageTemplate(t, input.message, input.receivedAt, source.bank),
          }))
          .filter((t) => t.transaction);
        if (templates.length > 1) result = { type: 'needs_review', reason: 'ambiguous_template' };
        else if (templates[0]?.transaction) {
          result = { type: 'transaction', transaction: templates[0].transaction };
          templateCategory = templates[0].template.categoryId;
        }
      }
    }
    if (result.type === 'ignored' || result.type === 'needs_review') {
      this.store.recordEnrichment(event.id, 'not_applicable', {
        reason: result.type,
        parserReason: result.reason,
      });
      this.store.update(
        event.id,
        result.type === 'needs_review' &&
          ['unrecognized_template', 'malformed_notification'].includes(result.reason)
          ? 'unsupported_format'
          : result.type,
        {
          parserReason: result.reason,
          parserRevision: PARSER_REVISION,
        },
      );
      return;
    }
    const tx = result.transaction;
    const account = manual
      ? this.config.accounts.find((a) => a.id === manual.accountId)
      : resolveAccount(this.config.accounts, tx);
    if (!account)
      throw new Error(
        `Unmapped account route: ${tx.bank}${tx.accountAlias ? ` suffix ${tx.accountAlias}` : ''}`,
      );
    if (
      tx.kind === 'transfer_in' &&
      tx.cardPaymentReceived &&
      !tx.transferCounterpartyAlias &&
      !tx.billPaymentIdentifier
    ) {
      const previous = event.parsed ? (JSON.parse(event.parsed) as ParsedTransaction) : undefined;
      // Preserve the first decision across retries, including no default.
      const fundingId = previous
        ? previous.assumedFundingAccountId
        : (account.fundingAccountId ?? this.config.creditCardPaymentFundingAccount?.id);
      if (fundingId === account.id)
        throw new Error('Credit-card payment funding account must differ from the card account');
      if (fundingId) tx.assumedFundingAccountId = fundingId;
    }
    let review = false;
    if (tx.balanceCents !== undefined) {
      if (tx.amountCents === null && tx.foreign) {
        const previous = this.store.previousBalance(account.key, tx.occurredAt);
        if (previous !== undefined) {
          const delta = tx.balanceCents - previous;
          const positive =
            tx.kind === 'refund' || tx.kind === 'transfer_in' || tx.kind === 'deposit';
          if (delta !== 0 && delta > 0 === positive) tx.amountCents = delta;
          else review = true;
        } else review = true;
      }
      this.store.addBalance(account.key, tx.occurredAt, tx.balanceCents, event.id);
    }
    if (tx.amountCents === null) {
      tx.amountCents = 0;
      review = true;
    }
    this.store.update(event.id, 'processing', { parsed: tx, parserRevision: PARSER_REVISION });
    const isTransfer = ['transfer_in', 'transfer_out', 'card_payment'].includes(tx.kind);
    const transferTarget = isTransfer ? resolveTransferTarget(this.config.accounts, tx) : undefined;
    const canCategorize = !transferTarget;
    let suggestion: AiSuggestion | null = null;
    this.store.observeMerchant(account.id, manual?.merchant ?? tx.payee);
    const sharedMerchant = this.store.merchants.find(manual?.merchant ?? tx.payee);
    let selectedPayee = tx.payee;
    let selectedCategory: string | undefined = canCategorize
      ? (manual?.categoryId ??
        templateCategory ??
        (tx.kind === 'fee' ? this.config.bankFeesCategoryId : undefined))
      : undefined;
    if (
      canCategorize &&
      tx.kind !== 'withdrawal' &&
      (!isTransfer || tx.payee !== 'Bank transfer') &&
      !merchantReviewReason(tx.payee) &&
      !selectedCategory &&
      !sharedMerchant?.conflict
    ) {
      const mapping = this.merchantResolver.lookup(tx.payee);
      if (mapping) {
        selectedPayee = mapping.payee;
        selectedCategory = mapping.category_id;
        this.store.recordEnrichment(event.id, 'history_hit', {
          merchant: tx.payee,
          merchantKey: mapping.merchant_key,
          accountId: account.id,
          payee: mapping.payee,
          categoryId: mapping.category_id,
          source: mapping.source,
          sourceRef: mapping.source_ref,
          decisionAt: mapping.decision_at,
        });
      } else {
        const request = {
          merchant: tx.payee,
          location: input.location,
          occurredAt: tx.occurredAt,
          categories: this.config.eligibleCategories,
        };
        this.store.recordEnrichment(event.id, 'history_miss', {
          merchant: tx.payee,
          merchantKey: merchantKey(tx.payee),
          accountId: account.id,
        });
        const started = Date.now();
        const enrichment = await this.ai.enrich(request).catch((error) => ({
          status: 'network_error' as const,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        }));
        if (enrichment.status === 'success') {
          suggestion = enrichment.suggestion;
          const applied = suggestion.confidence >= this.minConfidence;
          // The model may format a name, but only a confirmed alias can change its identity.
          const payeeApplied = applied && merchantKey(suggestion.payee) === merchantKey(tx.payee);
          if (payeeApplied) selectedPayee = suggestion.payee;
          if (applied) {
            selectedCategory = suggestion.categoryId;
            this.merchantResolver.learnSuggestion(account.id, tx.payee, suggestion, event.id);
          }
          this.store.update(event.id, 'processing', { suggestion });
          this.store.recordEnrichment(event.id, applied ? 'llm_success' : 'llm_low_confidence', {
            request,
            result: bounded(enrichment),
            threshold: this.minConfidence,
            payeeApplied,
            ...(!payeeApplied && applied ? { payeeReason: 'unconfirmed_merchant_alias' } : {}),
            categoryApplied: applied,
          });
        } else {
          this.store.recordEnrichment(event.id, `llm_${enrichment.status}`, {
            request,
            result: bounded(enrichment),
            threshold: this.minConfidence,
          });
        }
      }
    } else {
      this.store.recordEnrichment(event.id, 'not_applicable', {
        reason: selectedCategory ? 'user_category' : isTransfer ? 'transfer' : 'withdrawal',
        kind: tx.kind,
      });
    }
    if (manual?.categoryId && canCategorize)
      this.store.putLocalMapping({
        account_id: account.id,
        merchant_key: merchantKey(manual.merchant ?? tx.payee),
        payee: tx.payee,
        category_id: manual.categoryId,
        source_ref: `console-review:${event.id}`,
        decision_at: new Date().toISOString(),
      });
    const merchant = this.store.merchants.find(manual?.merchant ?? tx.payee);
    if (canCategorize && merchant?.name_confirmed && !manual) selectedPayee = merchant.payee;
    if (canCategorize) tx.importCategoryId = selectedCategory ?? null;
    this.store.update(event.id, 'processing', { parsed: tx });
    const date = DateTime.fromISO(tx.occurredAt, { setZone: true }).toISODate()!;
    const notes = transactionNotes(tx, review);
    if (isTransfer) {
      const counterpart = this.store
        .findTransferCounterparts(
          event.id,
          account.key,
          tx.principalCents ?? tx.amountCents,
          tx.occurredAt,
        )
        .find((candidate) => {
          const prior = JSON.parse(
            this.store.get(candidate.event_id)!.parsed!,
          ) as ParsedTransaction;
          if (!['transfer_in', 'transfer_out', 'card_payment'].includes(prior.kind)) return false;
          if (tx.explicitTransferAccountId === null || prior.explicitTransferAccountId === null)
            return false;
          const currentTarget = transferTarget;
          const priorTarget = resolveTransferTarget(this.config.accounts, prior);
          if (currentTarget && currentTarget.key !== candidate.source_alias) return false;
          if (priorTarget && priorTarget.key !== account.key) return false;
          return currentTarget !== undefined || priorTarget !== undefined;
        });
      const counterpartTx = counterpart
        ? (JSON.parse(this.store.get(counterpart.event_id)!.parsed!) as ParsedTransaction)
        : undefined;
      const counterpartTarget = counterpartTx
        ? resolveTransferTarget(this.config.accounts, counterpartTx)
        : undefined;
      if (counterpart && counterpartTarget) {
        tx.importTransferAccountId =
          counterpartTarget.id === account.id
            ? this.config.accounts.find((a) => a.key === counterpart.source_alias)?.id
            : undefined;
        tx.importCategoryId = undefined;
        this.store.recordTransfer(
          event.id,
          account.key,
          tx.transferCounterpartyAlias,
          tx.principalCents ?? tx.amountCents,
          tx.occurredAt,
          counterpart.event_id,
        );
        this.store.update(event.id, 'imported', { parsed: tx });
        return;
      }
      // A counterpart already imported without a transfer payee covers only
      // its own account. Import this side independently to avoid crediting
      // that account again through Actual's linked transfer.
      const target = counterpart ? undefined : transferTarget;
      tx.importTransferAccountId = target?.id ?? null;
      tx.importCategoryId = target ? undefined : (selectedCategory ?? null);
      this.store.update(event.id, 'processing', { parsed: tx });
      if (target) {
        const payee = await this.actual.transferPayee(target.id);
        const principal =
          tx.principalCents ?? (tx.amountCents < 0 ? tx.amountCents + tx.feeCents : tx.amountCents);
        const imported = await this.importTransactions(account.id, [
          {
            date,
            amount: principal,
            payee,
            notes,
            imported_id: stableId(tx, account.key, 'principal'),
          },
        ]);
        const actualTransactionId = imported.added[0] ?? imported.updated[0];
        if (actualTransactionId) this.store.update(event.id, 'processing', { actualTransactionId });
        if (tx.feeCents) {
          const feeImport = await this.importTransactions(account.id, [
            {
              date,
              amount: -tx.feeCents,
              payee_name: 'Bank Fees',
              category: this.config.bankFeesCategoryId,
              notes,
              imported_id: stableId(tx, account.key, 'fee'),
            },
          ]);
          tx.importedFeeId = feeImport.added[0] ?? feeImport.updated[0] ?? tx.importedFeeId;
          this.store.update(event.id, 'processing', { parsed: tx });
        }
        this.store.recordTransfer(
          event.id,
          account.key,
          tx.transferCounterpartyAlias,
          principal,
          tx.occurredAt,
        );
      } else {
        const imported = await this.importTransactions(account.id, [
          {
            date,
            amount:
              tx.principalCents ??
              (tx.amountCents < 0 ? tx.amountCents + tx.feeCents : tx.amountCents),
            payee_name: selectedPayee,
            imported_payee: tx.payee,
            ...(selectedCategory ? { category: selectedCategory } : {}),
            notes,
            imported_id: stableId(tx, account.key),
          },
        ]);
        const actualTransactionId = imported.added[0] ?? imported.updated[0];
        if (actualTransactionId) this.store.update(event.id, 'processing', { actualTransactionId });
        if (tx.feeCents) {
          const feeImport = await this.importTransactions(account.id, [
            {
              date,
              amount: -tx.feeCents,
              payee_name: 'Bank Fees',
              ...(selectedCategory ? { category: selectedCategory } : {}),
              notes,
              imported_id: stableId(tx, account.key, 'fee'),
            },
          ]);
          tx.importedFeeId = feeImport.added[0] ?? feeImport.updated[0] ?? tx.importedFeeId;
          this.store.update(event.id, 'processing', { parsed: tx });
        }
        this.store.recordTransfer(
          event.id,
          account.key,
          tx.transferCounterpartyAlias,
          tx.principalCents ?? tx.amountCents,
          tx.occurredAt,
          counterpart?.event_id,
        );
      }
    } else {
      const imported = await this.importTransactions(account.id, [
        {
          date,
          amount: tx.amountCents,
          payee_name: selectedPayee,
          imported_payee: tx.payee,
          category: selectedCategory,
          notes,
          imported_id: stableId(tx, account.key),
        },
      ]);
      const actualTransactionId = imported.added[0] ?? imported.updated[0];
      if (actualTransactionId) this.store.update(event.id, 'processing', { actualTransactionId });
    }
    await this.actual.sync();
    this.store.update(event.id, review ? 'imported_review' : 'imported');
  }
}

function bounded(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized.length <= 65_536
    ? value
    : { truncated: true, value: serialized.slice(0, 65_536) };
}
