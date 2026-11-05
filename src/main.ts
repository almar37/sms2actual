import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConsoleConfig } from './console-config.js';
import { createConsoleAuth } from './console-auth.js';
import { ConfigurableEnricher } from './provider-enricher.js';
import { loadParserConfig } from './parsing/config.js';
import { loadBankConfigFile, loadConfigFile, loadEnv } from './config.js';
import { EventStore } from './db.js';
import { ActualConnection } from './actual-connection.js';
import { loadRuntimeSecrets } from './runtime-secrets.js';
import { NoopEnricher, OpenCodeGoEnricher } from './enricher.js';
import { Processor } from './processor.js';
import { buildServer } from './server.js';
import type { ResolvedConfig } from './types.js';

const env = loadEnv();
await Promise.all([
  mkdir(dirname(env.DB_PATH), { recursive: true }),
  mkdir(env.ACTUAL_CACHE_DIR, { recursive: true }),
]);
const secrets = await loadRuntimeSecrets(join(dirname(env.DB_PATH), 'runtime-secrets.json'), env);
const banks = await loadBankConfigFile(env.BANKS_CONFIG_PATH);
const parsing = await loadParserConfig(env.PARSING_CONFIG_PATH, banks);
const legacy = env.CONFIG_PATH ? await loadConfigFile(env.CONFIG_PATH, banks) : undefined;
const store = new EventStore(env.DB_PATH);
const settings = new ConsoleConfig(store, secrets.authSecret);
const config: ResolvedConfig = {
  banks,
  parsing,
  accounts: [],
  bankFeesCategoryId: '',
  eligibleCategories: [],
};
const actual = new ActualConnection(
  settings,
  config,
  env.ACTUAL_CACHE_DIR,
  env.ACTUAL_SERVER_URL && env.ACTUAL_PASSWORD && env.ACTUAL_SYNC_ID
    ? {
        serverURL: env.ACTUAL_SERVER_URL,
        password: env.ACTUAL_PASSWORD,
        syncId: env.ACTUAL_SYNC_ID,
        encryptionPassword: env.ACTUAL_ENCRYPTION_PASSWORD,
      }
    : undefined,
  legacy,
);
let ready = false;
try {
  if (!settings.get('taskerKey'))
    settings.set('taskerKey', settings.encrypt(randomBytes(32).toString('base64url')));
  const auth = await createConsoleAuth(
    store,
    env.PUBLIC_URL,
    secrets.authSecret,
    env.TRUSTED_ORIGINS,
  );
  const fallbackAi = env.OPENCODE_GO_API_KEY
    ? new OpenCodeGoEnricher(env.OPENCODE_GO_API_KEY, env.OPENCODE_GO_MODEL)
    : new NoopEnricher();
  if (!settings.get('ai') && env.OPENCODE_GO_API_KEY)
    settings.saveAi({
      provider: 'opencode',
      model: env.OPENCODE_GO_MODEL,
      apiKey: env.OPENCODE_GO_API_KEY,
      minConfidence: env.ENRICHMENT_MIN_CONFIDENCE,
    });
  const ai = new ConfigurableEnricher(settings, fallbackAi);
  let mappingRefresh: Promise<void> | undefined;
  const processor = new Processor(
    store,
    actual,
    ai,
    config,
    env.MAX_ATTEMPTS,
    settings.get('ai') ? settings.ai().minConfidence : env.ENRICHMENT_MIN_CONFIDENCE,
    undefined,
    settings,
    () => actual.canProcess() && !mappingRefresh,
  );
  actual.setQuiesce(async () => {
    while (processor.isBusy()) await new Promise((resolve) => setTimeout(resolve, 20));
    await mappingRefresh;
  });
  const app = buildServer({
    apiKey: secrets.apiKey,
    banks,
    store,
    processor,
    ready: () => ready,
    logger: env.LOG_LEVEL,
    console: {
      auth,
      settings,
      actual,
      config,
      publicUrl: env.PUBLIC_URL,
      actualServerUrl: env.ACTUAL_SERVER_URL,
      trustedOrigins: env.TRUSTED_ORIGINS,
      requireSetupKey: Boolean(env.API_KEY),
      connection: actual,
      onRoutingChanged: refreshMappings,
      enricher: ai,
    },
  });
  function refreshMappings(): Promise<void> {
    if (!actual.canProcess()) return Promise.resolve();
    if (mappingRefresh) return mappingRefresh;
    mappingRefresh = processor
      .refreshMappings()
      .catch(() => app.log.warn('Merchant mapping refresh failed; using persisted mappings'))
      .finally(() => {
        mappingRefresh = undefined;
      });
    return mappingRefresh;
  }
  const timer = setInterval(refreshMappings, env.MAPPING_REFRESH_MINUTES * 60_000);
  timer.unref();
  let startup = Promise.resolve();
  const shutdown = async (signal: string) => {
    ready = false;
    clearInterval(timer);
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await processor.stop();
    await startup;
    await mappingRefresh;
    await actual.sync().catch(() => {});
    await actual.shutdown();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  ready = true;
  processor.start();
  // Serve setup and recovery even when the saved Actual server is unavailable.
  startup = actual
    .initialize()
    .then(refreshMappings)
    .catch(() =>
      app.log.warn('Actual is unavailable. Open workspace settings to connect or retry.'),
    );
} catch (error) {
  ready = false;
  await actual.shutdown().catch(() => {});
  store.close();
  throw error;
}
