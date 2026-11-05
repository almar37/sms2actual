import { createHash, randomBytes } from 'node:crypto';
import { ConsoleConfig, consoleSettingsSchema } from './console-config.js';
import { createConsoleAuth } from './console-auth.js';
import { ConfigurableEnricher } from './provider-enricher.js';
import { loadParserConfig } from './parsing/config.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  loadBankConfigFile,
  loadConfigFile,
  loadEnv,
  resolveCreditCardPaymentFundingAccount,
} from './config.js';
import { EventStore } from './db.js';
import { ActualApiAdapter } from './actual.js';
import { reportActualCompatibility } from './actual-version.js';
import { NoopEnricher, OpenCodeGoEnricher } from './enricher.js';
import { Processor } from './processor.js';
import { buildServer } from './server.js';
import type { ResolvedAccount, ResolvedConfig } from './types.js';

const env = loadEnv();
await Promise.all([
  mkdir(dirname(env.DB_PATH), { recursive: true }),
  mkdir(env.ACTUAL_CACHE_DIR, { recursive: true }),
]);
const banks = await loadBankConfigFile(env.BANKS_CONFIG_PATH);
const parsing = await loadParserConfig(env.PARSING_CONFIG_PATH, banks);
const file = await loadConfigFile(env.CONFIG_PATH, banks);
const store = new EventStore(env.DB_PATH);
const actual = new ActualApiAdapter({
  serverURL: env.ACTUAL_SERVER_URL,
  password: env.ACTUAL_PASSWORD,
  syncId: env.ACTUAL_SYNC_ID,
  encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD,
  dataDir: env.ACTUAL_CACHE_DIR,
});
let ready = false;
try {
  await actual.initialize();
  await reportActualCompatibility(actual);
  const [accounts, categories] = await Promise.all([actual.accounts(), actual.categories()]);
  const resolvedAccounts: ResolvedAccount[] = [];
  for (const mapping of file.accounts) {
    const matches = accounts.filter((a) => a.name === mapping.actualName);
    if (matches.length !== 1)
      throw new Error(`Actual account must resolve exactly once: ${mapping.actualName}`);
    resolvedAccounts.push({ key: matches[0]!.id, ...matches[0]!, match: mapping.match });
  }
  const fee = categories.filter((c) => c.name === file.bankFeesCategory);
  if (fee.length !== 1)
    throw new Error(`Bank Fees category must resolve exactly once: ${file.bankFeesCategory}`);
  const eligible = file.eligibleCategories?.length
    ? categories.filter((c) => file.eligibleCategories!.includes(c.name))
    : categories.filter((c) => c.name !== file.bankFeesCategory);
  if (file.eligibleCategories?.some((name) => !eligible.some((c) => c.name === name)))
    throw new Error('One or more eligible category names do not exist');
  const config: ResolvedConfig = {
    banks,
    parsing,
    accounts: resolvedAccounts,
    creditCardPaymentFundingAccount: resolveCreditCardPaymentFundingAccount(
      accounts,
      file.creditCardPaymentFundingAccount,
    ),
    bankFeesCategoryId: fee[0]!.id,
    eligibleCategories: eligible.map(({ id, name }) => ({ id, name })),
  };
  const secret =
    env.AUTH_SECRET ?? createHash('sha256').update(`sms2actual:${env.API_KEY}`).digest('hex');
  const consoleSettings = new ConsoleConfig(store, secret);
  const saved = consoleSettings.get('routing');
  if (saved) {
    const settings = consoleSettingsSchema.parse(saved);
    if (settings.accounts.some((a) => !accounts.some((current) => current.id === a.id)))
      throw new Error('A saved account is no longer open in Actual');
    if (
      !categories.some((c) => c.id === settings.bankFeesCategoryId) ||
      settings.eligibleCategoryIds.some((id) => !categories.some((c) => c.id === id))
    )
      throw new Error('A saved category is missing in Actual');
    consoleSettings.apply(settings, config, categories);
  }
  if (!consoleSettings.get('taskerKey'))
    consoleSettings.set(
      'taskerKey',
      consoleSettings.encrypt(randomBytes(32).toString('base64url')),
    );
  const auth = await createConsoleAuth(store, env.PUBLIC_URL, secret, env.TRUSTED_ORIGINS);
  const fallbackAi = env.OPENCODE_GO_API_KEY
    ? new OpenCodeGoEnricher(env.OPENCODE_GO_API_KEY, env.OPENCODE_GO_MODEL)
    : new NoopEnricher();
  if (!consoleSettings.get('ai') && env.OPENCODE_GO_API_KEY)
    consoleSettings.saveAi({
      provider: 'opencode',
      model: env.OPENCODE_GO_MODEL,
      apiKey: env.OPENCODE_GO_API_KEY,
      minConfidence: env.ENRICHMENT_MIN_CONFIDENCE,
    });
  const ai = new ConfigurableEnricher(consoleSettings, fallbackAi);
  const processor = new Processor(
    store,
    actual,
    ai,
    config,
    env.MAX_ATTEMPTS,
    consoleSettings.get('ai') ? consoleSettings.ai().minConfidence : env.ENRICHMENT_MIN_CONFIDENCE,
    undefined,
    consoleSettings,
  );
  await processor
    .refreshMappings()
    .catch((error) =>
      console.warn('Initial merchant mapping refresh failed; using persisted mappings', error),
    );
  processor.start();
  ready = true;
  const app = buildServer({
    apiKey: env.API_KEY,
    banks,
    store,
    processor,
    ready: () => ready,
    logger: env.LOG_LEVEL,
    console: {
      auth,
      settings: consoleSettings,
      actual,
      config,
      publicUrl: env.PUBLIC_URL,
      actualServerUrl: env.ACTUAL_SERVER_URL,
      trustedOrigins: env.TRUSTED_ORIGINS,
      enricher: ai,
    },
  });
  const mappingRefresh = setInterval(
    () =>
      void processor
        .refreshMappings()
        .catch((error) => app.log.warn({ error }, 'merchant mapping refresh failed')),
    env.MAPPING_REFRESH_MINUTES * 60_000,
  );
  mappingRefresh.unref();
  const shutdown = async (signal: string) => {
    ready = false;
    clearInterval(mappingRefresh);
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await processor.stop();
    await actual.sync().catch(() => {});
    await actual.shutdown();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ host: '0.0.0.0', port: env.PORT });
} catch (error) {
  ready = false;
  await actual.shutdown().catch(() => {});
  store.close();
  throw error;
}
