import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../src/db.js';
import { MerchantResolver } from '../src/merchant-resolver.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores.length = 0;
});
const at = '2026-11-10T10:00:00.000Z';
const memory = () => {
  const s = new EventStore(':memory:');
  stores.push(s);
  return s;
};

describe('shared merchants', () => {
  it('shares all identifiers, name and category across accounts and combines same-name merchants', () => {
    const s = memory();
    const first = s.merchants.save(
      undefined,
      'My coffee shop',
      ['COFFEE-POS', 'Coffee House'],
      'food',
    );
    const second = s.merchants.save(undefined, ' my coffee shop ', ['CAFE TERMINAL'], 'food');
    expect(second.id).toBe(first.id);
    expect(s.merchants.list()).toHaveLength(1);
    expect(new Set(second.identifiers)).toEqual(
      new Set(['COFFEE-POS', 'Coffee House', 'CAFE TERMINAL']),
    );
    const resolver = new MerchantResolver(s, {} as never, {} as never);
    for (const identifier of second.identifiers)
      expect(resolver.lookup(identifier)).toMatchObject({
        payee: ' my coffee shop ',
        category_id: 'food',
      });
  });
  it('keeps names and removed identifiers stable through history refreshes, reset and stale legacy observations', () => {
    const s = memory();
    const first = s.merchants.save(undefined, 'Cafe', ['POS-A', 'POS-B'], 'food');
    s.merchants.save(first.id, 'Cafe', ['POS-B'], null);
    s.putMapping({
      account_id: 'old',
      merchant_key: 'pos a',
      payee: 'Old cafe',
      category_id: 'shopping',
      source: 'actual',
      source_ref: 'legacy',
      decision_at: at,
    });
    s.merchants.observe('POS-A');
    s.merchants.resetHistory();
    s.resetSmsData();
    expect(s.merchants.find('POS-A')).toBeUndefined();
    expect(s.merchants.find('POS-B')).toMatchObject({ payee: 'Cafe', category_id: null });
    s.merchants.save(first.id, 'Cafe', ['POS-A', 'POS-B'], 'food');
    expect(s.merchants.find('POS-A')?.id).toBe(first.id);
  });
  it('rejects an identifier owned by a different merchant and merges deliberately when names match', () => {
    const s = memory();
    const one = s.merchants.save(undefined, 'First', ['POS-ONE'], 'food');
    const two = s.merchants.save(undefined, 'Second', ['POS-TWO'], 'shopping');
    expect(() => s.merchants.save(one.id, 'First', ['POS-ONE', 'POS-TWO'], 'food')).toThrow(
      /already belongs/,
    );
    expect(() => s.merchants.save(one.id, 'First', ['POS-ONE', 'pos one'], 'food')).toThrow(
      /unique/,
    );
    const merged = s.merchants.save(two.id, 'First', ['POS-TWO'], 'food');
    expect(merged.identifiers).toEqual(['POS-ONE', 'POS-TWO']);
    expect(s.merchants.list()).toHaveLength(1);
    expect(s.merchants.find('POS-ONE')?.id).toBe(two.id);
  });
  it('never groups unrelated identifiers using an unconfirmed AI payee guess', () => {
    const s = memory();
    for (const merchant_key of ['unrelated one', 'unrelated two'])
      s.putMapping({
        account_id: 'old',
        merchant_key,
        payee: 'Same guess',
        category_id: 'food',
        source: 'ai',
        source_ref: merchant_key,
        decision_at: at,
      });
    expect(s.merchants.list()).toHaveLength(2);
    expect(s.merchants.find('unrelated one')?.name_confirmed).toBe(0);
  });
});

it('merges a deployed account-scoped database once on startup, retaining identifiers, conflicts and originals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sms-merchant-migration-'));
  const path = join(directory, 'events.sqlite');
  try {
    const old = new EventStore(path);
    // Simulate deployment data written by the previous release, before any catalog existed.
    old.db.exec("DELETE FROM service_migrations WHERE key='global-merchants-v1'");
    const profile = old.db.prepare(
      'INSERT INTO merchant_profiles(account_id,merchant_key,merchant,payee,renamed,updated_at) VALUES(?,?,?,?,1,?)',
    );
    const mapping = old.db.prepare(
      'INSERT INTO merchant_mappings(account_id,merchant_key,payee,category_id,source,decision_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    );
    for (const [account, key, identifier, category] of [
      ['checking', 'coffee pos', 'COFFEE-POS', 'food'],
      ['credit', 'coffee pos', 'COFFEE-POS', 'food'],
      ['another card', 'coffee terminal', 'Coffee Terminal', 'shopping'],
    ]) {
      profile.run(account, key, identifier, 'My coffee shop', at);
      mapping.run(account, key, 'My coffee shop', category, 'local', at, at);
    }
    old.db
      .prepare(
        'INSERT INTO merchant_profiles(account_id,merchant_key,merchant,payee,renamed,updated_at) VALUES(?,?,?,?,0,?)',
      )
      .run('cash', 'unknown pos', 'Unknown POS', 'Unknown POS', at);
    const event = old.enqueue({
      sender: 'SAB',
      message: 'Original SMS must stay intact',
      receivedAt: at,
    });
    const original = old.get(event.id);
    old.close();
    const migrated = new EventStore(path);
    const coffee = migrated.merchants.find('COFFEE-POS')!;
    expect(migrated.merchants.list()).toHaveLength(2);
    expect(coffee.identifiers).toEqual(['COFFEE-POS', 'Coffee Terminal']);
    expect(coffee).toMatchObject({ payee: 'My coffee shop', category_id: null, conflict: 1 });
    expect(coffee.reviewReason).toContain('categories');
    expect(migrated.get(event.id)).toEqual(original);
    expect(migrated.db.prepare('SELECT COUNT(*) n FROM merchant_profiles').get()).toEqual({ n: 4 });
    migrated.merchants.save(coffee.id, coffee.payee, coffee.identifiers, 'food');
    migrated.close();
    const restarted = new EventStore(path);
    try {
      expect(restarted.merchants.find('Coffee Terminal')).toMatchObject({
        id: coffee.id,
        category_id: 'food',
        conflict: 0,
      });
      expect(restarted.merchants.list()).toHaveLength(2);
      expect(
        restarted.db
          .prepare("SELECT value FROM service_migrations WHERE key='global-merchants-v1'")
          .get(),
      ).toBeDefined();
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rolls the entire migration back on failure and can retry without losing scoped data', () => {
  const s = memory();
  s.db.exec("DELETE FROM service_migrations WHERE key='global-merchants-v1'");
  const insert = s.db.prepare(
    'INSERT INTO merchant_profiles(account_id,merchant_key,merchant,payee,renamed,updated_at) VALUES(?,?,?,?,1,?)',
  );
  insert.run('one', 'first pos', 'First POS', 'First', at);
  insert.run('two', 'second pos', 'Second POS', 'Second', at);
  s.db.exec(
    "CREATE TRIGGER fail_alias BEFORE INSERT ON merchant_identifiers WHEN NEW.merchant_key='second pos' BEGIN SELECT RAISE(ABORT,'simulated migration failure'); END",
  );
  expect(() => s.merchants.migrate()).toThrow(/simulated migration failure/);
  expect(s.merchants.list()).toEqual([]);
  expect(
    s.db.prepare("SELECT 1 FROM service_migrations WHERE key='global-merchants-v1'").get(),
  ).toBeUndefined();
  expect(s.db.prepare('SELECT COUNT(*) n FROM merchant_profiles').get()).toEqual({ n: 2 });
  s.db.exec('DROP TRIGGER fail_alias');
  s.merchants.migrate();
  expect(s.merchants.list()).toHaveLength(2);
});

it('does not merge explicit merchants when an older Actual payee disagrees with their saved names', () => {
  const s = memory();
  const one = s.merchants.save(undefined, 'First cafe', ['FIRST-POS'], 'food');
  const two = s.merchants.save(undefined, 'Second cafe', ['SECOND-POS'], 'shopping');
  s.putMapping({
    account_id: 'old-card',
    merchant_key: 'first pos',
    payee: 'Second cafe',
    category_id: 'shopping',
    source: 'actual',
    source_ref: 'old-transaction',
    decision_at: at,
  });
  expect(s.merchants.list()).toHaveLength(2);
  expect(s.merchants.find('FIRST-POS')).toMatchObject({
    id: one.id,
    payee: 'First cafe',
    category_id: 'food',
    conflict: 0,
  });
  expect(s.merchants.find('SECOND-POS')?.id).toBe(two.id);
});
