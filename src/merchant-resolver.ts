import type {
  ActualAdapter,
  AiSuggestion,
  HistoricalTransaction,
  ParsedTransaction,
  ResolvedConfig,
} from './types.js';
import { EventStore, type MerchantMapping } from './db.js';
import { resolveAccount } from './routing.js';
import { currentBudgetDate } from './budget-date.js';
import { stableId } from './transaction-id.js';
import { merchantKey, merchantReviewReason } from './merchant-identity.js';
import { recheckMerchants } from './merchant-recheck.js';

export { merchantKey } from './merchant-identity.js';

export class MerchantResolver {
  private activeCategoryIds = new Set<string>();
  private categoriesLoaded = false;
  private refreshing?: Promise<void>;

  constructor(
    private store: EventStore,
    private actual: ActualAdapter,
    private config: ResolvedConfig,
  ) {}

  lookup(accountId: string, merchant: string): MerchantMapping | undefined {
    if (merchantReviewReason(merchant)) return;
    const mapping = this.store.mapping(accountId, merchantKey(merchant));
    return mapping &&
      mapping.source !== 'ai' &&
      !mapping.review_reason &&
      (!this.categoriesLoaded || this.activeCategoryIds.has(mapping.category_id))
      ? mapping
      : undefined;
  }

  learnSuggestion(
    accountId: string,
    merchant: string,
    suggestion: AiSuggestion,
    eventId: string,
    decisionAt = new Date().toISOString(),
  ) {
    if (merchantReviewReason(merchant)) return;
    this.store.putLocalMapping({
      account_id: accountId,
      merchant_key: merchantKey(merchant),
      payee: suggestion.payee,
      category_id: suggestion.categoryId,
      source_ref: eventId,
      decision_at: decisionAt,
      source: 'ai',
    });
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async performRefresh() {
    recheckMerchants(this.store, this.config);
    await this.actual.sync();
    const categories = await this.actual.categories();
    this.activeCategoryIds = new Set(
      categories
        .filter((category) => !category.isIncome && !category.hidden)
        .map((category) => category.id),
    );
    this.categoriesLoaded = true;
    const accountIds = [...new Set(this.config.accounts.map((account) => account.id))];
    const end = currentBudgetDate();
    const histories = await Promise.all(
      accountIds.map((accountId) => this.actual.transactions(accountId, '1900-01-01', end)),
    );
    const transactions = histories.flat();
    this.seedImportBaselines(transactions);
    const observations = transactions
      .map((transaction) => this.observation(transaction))
      .filter((observation) => observation !== undefined);
    this.store.replaceActualMappings(observations, new Date().toISOString());
  }

  private observation(transaction: HistoricalTransaction) {
    if (
      !transaction.categoryId ||
      !this.activeCategoryIds.has(transaction.categoryId) ||
      transaction.transferId ||
      transaction.transferAccountId ||
      transaction.isSplit
    )
      return undefined;
    const originalDescription = transaction.importedPayee || transaction.payeeName;
    const repair = originalDescription
      ? this.store.merchantRepair(transaction.accountId, merchantKey(originalDescription))
      : undefined;
    if (repair && !repair.merchant_key) return undefined;
    const description = repair?.merchant ?? originalDescription;
    if (!description || merchantReviewReason(description)) return undefined;
    this.store.observeMerchant(transaction.accountId, description);
    const serviceImport =
      transaction.importedId?.startsWith('sms:') || transaction.importedId?.startsWith('sms-edit:');
    if (serviceImport && transaction.importedId) {
      const baseline = this.store.merchantImport(transaction.importedId);
      // A service import is evidence only after its payee/category has been corrected.
      // Missing baselines (for example after a legacy reset) cannot establish consent.
      if (
        !baseline ||
        (baseline.payee === (transaction.payeeName || originalDescription) &&
          baseline.category_id === transaction.categoryId)
      )
        return undefined;
    }
    return {
      actualTransactionId: transaction.id,
      accountId: transaction.accountId,
      merchantKey: merchantKey(description),
      payee:
        transaction.payeeName && !merchantReviewReason(transaction.payeeName)
          ? transaction.payeeName
          : description,
      categoryId: transaction.categoryId,
      transactionDate: transaction.date,
      corrected: serviceImport,
    };
  }

  private seedImportBaselines(transactions: HistoricalTransaction[]) {
    const byId = new Map(transactions.map((transaction) => [transaction.id, transaction]));
    const rows = this.store.db
      .prepare(
        "SELECT id,parsed,suggestion,actual_transaction_id FROM events WHERE parsed IS NOT NULL AND status IN ('imported','imported_review')",
      )
      .all() as {
      id: string;
      parsed: string;
      suggestion: string | null;
      actual_transaction_id: string | null;
    }[];
    for (const row of rows) {
      const transaction = JSON.parse(row.parsed) as ParsedTransaction;
      const account = resolveAccount(this.config.accounts, transaction);
      const importedId =
        (row.actual_transaction_id ? byId.get(row.actual_transaction_id)?.importedId : undefined) ??
        (account ? stableId(transaction, account.key) : undefined);
      if (!importedId || this.store.merchantImport(importedId)) continue;
      const attempts = this.store.enrichmentAttempts(row.id);
      if (attempts.some((attempt) => attempt.status === 'user_actual_update')) continue;
      const decision = attempts.findLast((attempt) =>
        ['history_hit', 'llm_success', 'llm_low_confidence'].includes(attempt.status),
      );
      const history =
        decision?.status === 'history_hit'
          ? (JSON.parse(decision.details) as { payee: string; categoryId: string })
          : undefined;
      const aiAttempt = decision?.status.startsWith('llm_') ? decision : undefined;
      const ai = aiAttempt
        ? (JSON.parse(aiAttempt.details) as { payeeApplied?: boolean })
        : undefined;
      const suggestion = row.suggestion ? (JSON.parse(row.suggestion) as AiSuggestion) : undefined;
      // Legacy suggestion rows without application evidence cannot prove a later edit.
      if (suggestion && !history && ai?.payeeApplied === undefined) continue;
      const payee =
        ai?.payeeApplied && suggestion ? suggestion.payee : (history?.payee ?? transaction.payee);
      const category =
        transaction.importCategoryId !== undefined
          ? (transaction.importCategoryId ?? undefined)
          : (history?.categoryId ??
            (aiAttempt?.status === 'llm_success' ? suggestion?.categoryId : undefined));
      this.store.recordMerchantImport(importedId, payee, category);
    }
  }
}
