import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActualConnection } from '../src/actual-connection.js';
import { ConsoleConfig } from '../src/console-config.js';
import { EventStore } from '../src/db.js';
import type { ActualAdapter, ResolvedConfig } from '../src/types.js';
import { banks, parsing } from './fixtures/banks.js';

const stores: EventStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
const credentials = {
  serverURL: 'http://actual:5006',
  password: 'private-server-password',
  syncId: 'budget-id',
  encryptionPassword: 'private-encryption-password',
};
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  const settings = new ConsoleConfig(store, 'test-stable-secret');
  const config: ResolvedConfig = {
    banks,
    parsing,
    accounts: [],
    bankFeesCategoryId: '',
    eligibleCategories: [],
  };
  const adapter: ActualAdapter = {
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    serverVersion: async () => '26.9.0',
    sync: async () => {},
    accounts: async () => [{ id: 'checking', name: 'Current' }],
    categories: async () => [
      { id: 'fees', name: 'Bank Fees' },
      { id: 'food', name: 'Food' },
    ],
    transactions: async () => [],
    transferPayee: async (id) => id,
    importTransactions: async () => ({ added: [], updated: [], errors: [] }),
  };
  const factory = vi.fn(() => adapter);
  const connection = new ActualConnection(
    settings,
    config,
    '/unused',
    undefined,
    undefined,
    factory,
  );
  return { connection, store, config, settings, adapter, factory };
}
function saveRouting(f: ReturnType<typeof fixture>) {
  const routing = {
    accounts: [
      {
        id: 'checking',
        name: 'Current',
        type: 'checking' as const,
        match: { bank: 'sab', accountSuffixes: ['1234'] },
        cards: [],
      },
    ],
    bankFeesCategoryId: 'fees',
    eligibleCategoryIds: ['food'],
  };
  f.settings.set('routing', routing);
  f.settings.apply(routing, f.config, [{ id: 'food', name: 'Food' }]);
}

describe('saved Actual connection lifecycle', () => {
  it('encrypts connection credentials and restores connection and routing on restart', async () => {
    const f = fixture();
    expect(f.connection.status()).toMatchObject({
      configured: false,
      connected: false,
      ready: false,
    });
    await f.connection.connect(credentials);
    expect(f.connection.status()).toMatchObject({ connected: true, ready: false });
    const persisted = f.settings.get<string>('actualConnection')!;
    expect(persisted).not.toContain(credentials.password);
    expect(persisted).not.toContain(credentials.encryptionPassword);
    expect(JSON.parse(f.settings.decrypt(persisted))).toEqual(credentials);
    saveRouting(f);
    await f.connection.shutdown();
    const restored = new ActualConnection(
      f.settings,
      f.config,
      '/unused',
      undefined,
      undefined,
      f.factory,
    );
    await restored.initialize();
    expect(restored.status()).toMatchObject({ connected: true, ready: true });
    expect(JSON.stringify(restored.status())).not.toContain('private-');
    expect(f.factory).toHaveBeenLastCalledWith({ ...credentials, dataDir: '/unused' });
  });
  it('keeps saved credentials and pauses imports on failure, then recovers using the saved connection', async () => {
    const f = fixture();
    await f.connection.connect(credentials);
    saveRouting(f);
    vi.mocked(f.adapter.initialize).mockRejectedValueOnce(
      new Error('SDK failure containing private-server-password'),
    );
    await expect(
      f.connection.connect({ ...credentials, password: 'wrong-password' }),
    ).rejects.toThrow('Could not connect');
    expect(f.connection.status()).toMatchObject({
      configured: true,
      connected: false,
      ready: false,
    });
    expect(JSON.stringify(f.connection.status())).not.toContain(credentials.password);
    expect(JSON.parse(f.settings.decrypt(f.settings.get<string>('actualConnection')!))).toEqual(
      credentials,
    );
    await f.connection.initialize();
    expect(f.connection.canProcess()).toBe(true);
  });
  it('pauses new work and waits for in-flight work before replacing the SDK session', async () => {
    const f = fixture();
    await f.connection.connect(credentials);
    saveRouting(f);
    let release!: () => void;
    f.connection.setQuiesce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const reconnect = f.connection.connect(credentials);
    expect(f.connection.canProcess()).toBe(false);
    await expect(f.connection.accounts()).resolves.toEqual([{ id: 'checking', name: 'Current' }]);
    await expect(f.connection.sync()).resolves.toBeUndefined();
    expect(f.adapter.shutdown).not.toHaveBeenCalled();
    await expect(f.connection.connect(credentials)).rejects.toThrow('already in progress');
    release();
    await reconnect;
    expect(f.adapter.shutdown).toHaveBeenCalledOnce();
    expect(f.connection.canProcess()).toBe(true);
  });
  it('requires remapping removed accounts and fee categories', async () => {
    const f = fixture();
    await f.connection.connect(credentials);
    saveRouting(f);
    f.adapter.accounts = async () => [];
    f.adapter.categories = async () => [];
    await f.connection.connect(credentials);
    expect(f.config.accounts).toEqual([]);
    expect(f.config.bankFeesCategoryId).toBe('');
    expect(f.connection.canProcess()).toBe(false);
  });
  it('retains legacy funding defaults when saved web routing already exists', async () => {
    const f = fixture();
    saveRouting(f);
    const connection = new ActualConnection(
      f.settings,
      f.config,
      '/unused',
      credentials,
      {
        accounts: [{ actualName: 'Current', match: { bank: 'sab', accountSuffixes: ['1234'] } }],
        bankFeesCategory: 'Bank Fees',
        creditCardPaymentFundingAccount: 'Current',
      },
      f.factory,
    );
    await connection.initialize();
    expect(f.config.creditCardPaymentFundingAccount).toEqual({ id: 'checking', name: 'Current' });
    expect(connection.canProcess()).toBe(true);
  });
  it('prevents changing budgets after imports without disturbing the current connection', async () => {
    const f = fixture();
    await f.connection.connect(credentials);
    saveRouting(f);
    const { id } = f.store.enqueue({
      sender: 'SAB',
      message: 'Imported fixture',
      receivedAt: '2026-11-06T00:00:00Z',
    });
    f.store.update(id, 'imported');
    await expect(
      f.connection.connect({ ...credentials, syncId: 'different-budget' }),
    ).rejects.toThrow('separate sms2actual instance');
    expect(f.adapter.shutdown).not.toHaveBeenCalled();
    expect(f.connection.canProcess()).toBe(true);
  });
});
