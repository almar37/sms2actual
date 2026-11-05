import { z } from 'zod';
import { ActualApiAdapter } from './actual.js';
import { reportActualCompatibility } from './actual-version.js';
import { consoleSettingsSchema, type ConsoleConfig } from './console-config.js';
import { resolveCreditCardPaymentFundingAccount } from './config.js';
import type { ActualAdapter, AppConfigFile, ResolvedConfig } from './types.js';

export const actualConnectionSchema = z
  .object({
    serverURL: z
      .string()
      .url()
      .max(2000)
      .refine((value) => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      }, 'Use an HTTP or HTTPS address without embedded credentials'),
    password: z.string().min(1).max(1000),
    syncId: z.string().trim().min(1).max(200),
    encryptionPassword: z.string().max(1000).optional(),
  })
  .strict();
export type ActualConnectionSettings = z.infer<typeof actualConnectionSchema>;

/** Owns the SDK's single budget session; imports pause while it is replaced. */
export class ActualConnection implements ActualAdapter {
  private current?: ActualAdapter;
  private busy = false;
  private error: string | null = null;
  private activeSettings?: ActualConnectionSettings;
  private quiesce: () => Promise<void> = async () => {};
  constructor(
    private settings: ConsoleConfig,
    private config: ResolvedConfig,
    private dataDir: string,
    private fallback?: ActualConnectionSettings,
    private legacy?: AppConfigFile,
    private factory: (options: ActualConnectionSettings & { dataDir: string }) => ActualAdapter = (
      options,
    ) => new ActualApiAdapter(options),
  ) {}
  setQuiesce(callback: () => Promise<void>) {
    this.quiesce = callback;
  }
  private saved(): ActualConnectionSettings | undefined {
    const encrypted = this.settings.get<string>('actualConnection');
    return encrypted
      ? actualConnectionSchema.parse(JSON.parse(this.settings.decrypt(encrypted)))
      : this.fallback;
  }
  status() {
    // Connection credentials are never included in status responses.
    const saved = this.saved();
    return {
      configured: Boolean(saved),
      connected: Boolean(this.current),
      connecting: this.busy,
      ready: this.canProcess(),
      serverURL: saved?.serverURL ?? '',
      syncId: saved?.syncId ?? '',
      error: this.error,
    };
  }
  canProcess() {
    return Boolean(
      this.current && !this.busy && this.config.accounts.length && this.config.bankFeesCategoryId,
    );
  }
  async initialize() {
    const saved = this.saved();
    if (saved) await this.connect(saved);
  }
  async connect(input: ActualConnectionSettings) {
    if (this.busy) throw new Error('An Actual connection is already in progress');
    const next = actualConnectionSchema.parse(input);
    const previous = this.activeSettings ?? this.saved();
    if (
      previous &&
      previous.syncId !== next.syncId &&
      this.settings.store.db
        .prepare(
          "SELECT id FROM events WHERE status IN ('imported','imported_review') OR actual_transaction_id IS NOT NULL LIMIT 1",
        )
        .get()
    )
      throw new Error(
        'Use a separate sms2actual instance for a different budget after importing transactions',
      );
    this.busy = true;
    this.error = null;
    let candidate: ActualAdapter | undefined;
    try {
      await this.quiesce();
      const current = this.current;
      this.current = undefined;
      if (current) await current.shutdown();
      candidate = this.factory({ ...next, dataDir: this.dataDir });
      await candidate.initialize();
      await reportActualCompatibility(candidate);
      const [accounts, categories] = await Promise.all([
        candidate.accounts(),
        candidate.categories(),
      ]);
      if (this.legacy)
        this.config.creditCardPaymentFundingAccount = resolveCreditCardPaymentFundingAccount(
          accounts,
          this.legacy.creditCardPaymentFundingAccount,
        );
      let routing = this.settings.get('routing');
      if (!routing && this.legacy) {
        const file = this.legacy;
        this.config.accounts = file.accounts.map((mapping) => {
          const matches = accounts.filter((account) => account.name === mapping.actualName);
          if (matches.length !== 1)
            throw new Error(`Actual account must resolve exactly once: ${mapping.actualName}`);
          return { key: matches[0]!.id, ...matches[0]!, match: mapping.match };
        });
        const fees = categories.filter((category) => category.name === file.bankFeesCategory);
        if (fees.length !== 1)
          throw new Error(`Bank Fees category must resolve exactly once: ${file.bankFeesCategory}`);
        this.config.bankFeesCategoryId = fees[0]!.id;
        this.config.eligibleCategories = categories.filter(
          (category) =>
            !category.hidden &&
            !category.isIncome &&
            (file.eligibleCategories?.length
              ? file.eligibleCategories.includes(category.name)
              : category.id !== fees[0]!.id),
        );
        if (
          file.eligibleCategories?.some(
            (name) => !this.config.eligibleCategories.some((category) => category.name === name),
          )
        )
          throw new Error('One or more eligible category names do not exist');
        routing = this.settings.seed(this.config);
      }
      const parsed = routing
        ? consoleSettingsSchema.parse(routing)
        : {
            accounts: [],
            bankFeesCategoryId: '',
            eligibleCategoryIds: categories
              .filter((category) => !category.hidden && !category.isIncome)
              .map((category) => category.id),
          };
      // Removed/closed accounts or categories must be remapped in the web UI.
      parsed.accounts = parsed.accounts
        .filter((mapping) => accounts.some((account) => account.id === mapping.id))
        .map((mapping) => ({
          ...mapping,
          name: accounts.find((account) => account.id === mapping.id)!.name,
          fundingAccountId: accounts.some((account) => account.id === mapping.fundingAccountId)
            ? mapping.fundingAccountId
            : undefined,
        }));
      if (
        !categories.some(
          (category) =>
            category.id === parsed.bankFeesCategoryId && !category.hidden && !category.isIncome,
        )
      )
        parsed.bankFeesCategoryId = '';
      parsed.eligibleCategoryIds = parsed.eligibleCategoryIds.filter((id) =>
        categories.some((category) => category.id === id && !category.hidden && !category.isIncome),
      );
      this.settings.store.db.transaction(() => {
        this.settings.set('actualConnection', this.settings.encrypt(JSON.stringify(next)));
        this.settings.set('routing', parsed);
      })();
      this.settings.apply(parsed, this.config, categories);
      this.current = candidate;
      this.activeSettings = next;
    } catch {
      await candidate?.shutdown().catch(() => {});
      this.error =
        'Could not connect to Actual. Check the server address, password, Sync ID, encryption password, and server logs.';
      throw new Error(this.error);
    } finally {
      this.busy = false;
    }
  }
  private adapter() {
    if (!this.current) throw new Error('Connect to Actual in workspace settings first');
    return this.current;
  }
  serverVersion() {
    return this.adapter().serverVersion();
  }
  async shutdown() {
    const current = this.current;
    this.current = undefined;
    await current?.shutdown();
  }
  async sync() {
    await this.adapter().sync();
  }
  async accounts() {
    return this.current ? this.current.accounts() : [];
  }
  async categories() {
    return this.current ? this.current.categories() : [];
  }
  async accountBalance(id: string, throughDate?: string) {
    return this.adapter().accountBalance?.(id, throughDate) ?? 0;
  }
  transactions(...args: Parameters<ActualAdapter['transactions']>) {
    return this.adapter().transactions(...args);
  }
  transferPayee(id: string) {
    return this.adapter().transferPayee(id);
  }
  importTransactions(...args: Parameters<ActualAdapter['importTransactions']>) {
    return this.adapter().importTransactions(...args);
  }
}
