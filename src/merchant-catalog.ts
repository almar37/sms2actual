import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { merchantKey, merchantReviewReason } from './merchant-identity.js';

const nameKey = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
export interface Merchant {
  id: string;
  payee: string;
  category_id: string | null;
  source: 'local' | 'actual' | 'ai' | 'sms';
  name_priority: number;
  category_priority: number;
  name_choices: string;
  category_choices: string;
  name_confirmed: number;
  conflict: number;
  review_reason: string | null;
  decision_at: string;
  updated_at: string;
}
export interface MerchantView extends Merchant {
  identifiers: string[];
  reviewReason: string | null;
}
interface Observation {
  identifier: string;
  payee: string;
  categoryId?: string | null;
  source: Merchant['source'];
  at: string;
  priority?: number;
  reviewReason?: string | null;
}
const priority = { sms: 0, ai: 1, actual: 2, local: 3 };

/** Account IDs belong to transaction evidence, never to merchant identity. */
export class MerchantCatalog {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS merchants(id TEXT PRIMARY KEY,payee TEXT NOT NULL,payee_key TEXT NOT NULL,category_id TEXT,source TEXT NOT NULL,name_priority INTEGER NOT NULL,category_priority INTEGER NOT NULL,name_choices TEXT NOT NULL,category_choices TEXT NOT NULL,name_confirmed INTEGER NOT NULL,conflict INTEGER NOT NULL,review_reason TEXT,decision_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS merchant_payee_key ON merchants(payee_key);
      CREATE TABLE IF NOT EXISTS merchant_identifiers(merchant_key TEXT PRIMARY KEY,merchant_id TEXT NOT NULL REFERENCES merchants(id),identifier TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS merchant_identifier_owner ON merchant_identifiers(merchant_id);
      CREATE TABLE IF NOT EXISTS suppressed_merchant_identifiers(merchant_key TEXT PRIMARY KEY);
    `);
  }
  get(id: string): MerchantView | undefined {
    const row = this.db.prepare('SELECT * FROM merchants WHERE id=?').get(id) as
      Merchant | undefined;
    if (!row) return;
    const identifiers = this.db
      .prepare(
        'SELECT identifier FROM merchant_identifiers WHERE merchant_id=? ORDER BY identifier',
      )
      .all(id) as { identifier: string }[];
    return {
      ...row,
      identifiers: identifiers.map((r) => r.identifier),
      reviewReason: row.review_reason,
    };
  }
  find(identifier: string): MerchantView | undefined {
    const row = this.db
      .prepare('SELECT merchant_id FROM merchant_identifiers WHERE merchant_key=?')
      .get(merchantKey(identifier)) as { merchant_id: string } | undefined;
    return row ? this.get(row.merchant_id) : undefined;
  }
  list(): MerchantView[] {
    return (
      this.db.prepare('SELECT id FROM merchants ORDER BY payee,id').all() as { id: string }[]
    ).map((row) => this.get(row.id)!);
  }
  observe(identifier: string) {
    const existing = this.find(identifier);
    if (existing) {
      this.db
        .prepare(
          'UPDATE merchant_identifiers SET identifier=? WHERE merchant_key=? AND identifier=merchant_key',
        )
        .run(identifier, merchantKey(identifier));
      return;
    }
    this.record({ identifier, payee: identifier, source: 'sms', at: new Date().toISOString() });
  }
  record(input: Observation) {
    if (merchantReviewReason(input.identifier)) return;
    const key = merchantKey(input.identifier);
    if (
      this.db.prepare('SELECT 1 FROM suppressed_merchant_identifiers WHERE merchant_key=?').get(key)
    )
      return;
    this.db.transaction(() => {
      const p = input.priority ?? priority[input.source];
      const trusted = input.source === 'local' || input.source === 'actual';
      const payee = trusted && !merchantReviewReason(input.payee) ? input.payee : input.identifier;
      const owner = this.find(input.identifier);
      const allowNameMerge =
        trusted && (!owner || p >= owner.name_priority || nameKey(owner.payee) === nameKey(payee));
      const related = (
        this.db
          .prepare(
            `SELECT DISTINCT m.id FROM merchants m LEFT JOIN merchant_identifiers i ON i.merchant_id=m.id
        WHERE i.merchant_key=? OR (? AND m.name_confirmed=1 AND m.payee_key=?) ORDER BY m.id`,
          )
          .all(key, Number(allowNameMerge), nameKey(payee)) as { id: string }[]
      ).map((r) => this.get(r.id)!);
      const id = related[0]?.id ?? randomUUID();
      const now = new Date().toISOString();
      const seed: Merchant = {
        id,
        payee,
        category_id: input.categoryId ?? null,
        source: input.source,
        name_priority: trusted ? p : 0,
        category_priority: input.categoryId ? p : -1,
        name_choices: JSON.stringify([payee]),
        category_choices: JSON.stringify(input.categoryId ? [input.categoryId] : []),
        name_confirmed: Number(trusted),
        conflict: 0,
        review_reason:
          input.reviewReason ??
          (input.source === 'ai' ? 'AI suggestion — confirm before reuse' : null),
        decision_at: input.at,
        updated_at: now,
      };
      const all = [...related, seed];
      const namePriority = Math.max(...all.map((m) => m.name_priority));
      const categoryPriority = Math.max(...all.map((m) => m.category_priority));
      const nameRows = all
        .filter((m) => m.name_priority === namePriority)
        .sort(
          (a, b) =>
            Date.parse(a.decision_at) - Date.parse(b.decision_at) ||
            a.decision_at.localeCompare(b.decision_at),
        );
      const winner = nameRows.at(-1)!;
      const names = [...new Set(nameRows.flatMap((m) => JSON.parse(m.name_choices) as string[]))];
      const categories = [
        ...new Set(
          all
            .filter((m) => m.category_priority === categoryPriority)
            .flatMap((m) => JSON.parse(m.category_choices) as string[]),
        ),
      ];
      const nameConflict = namePriority > 0 && new Set(names.map(nameKey)).size > 1;
      const categoryConflict = categories.length > 1;
      const reason = nameConflict
        ? 'Conflicting saved names — confirm this merchant'
        : categoryConflict
          ? 'Conflicting saved categories — choose a shared category'
          : winner.name_priority >= 4
            ? null
            : (input.reviewReason ??
              related.find((m) => m.review_reason && m.source !== 'ai')?.review_reason ??
              (categoryPriority === 1 ? 'AI suggestion — confirm before reuse' : null));
      const merged = {
        ...winner,
        id,
        source: namePriority === 0 && categoryPriority === 1 ? ('ai' as const) : winner.source,
        name_priority: namePriority,
        category_priority: categoryPriority,
        name_choices: JSON.stringify(names),
        category_choices: JSON.stringify(categories),
        category_id: categoryConflict ? null : (categories[0] ?? null),
        name_confirmed: Number(
          namePriority > 0 &&
            !nameConflict &&
            (!reason ||
              reason === 'Conflicting saved categories — choose a shared category' ||
              reason === 'AI suggestion — confirm before reuse'),
        ),
        conflict: Number(
          nameConflict ||
            categoryConflict ||
            (winner.name_priority < 4 &&
              Boolean(reason) &&
              reason !== 'AI suggestion — confirm before reuse'),
        ),
        review_reason: reason,
        updated_at: now,
      };
      this.write(merged);
      for (const old of related)
        if (old.id !== id) {
          this.db
            .prepare('UPDATE merchant_identifiers SET merchant_id=? WHERE merchant_id=?')
            .run(id, old.id);
          this.db.prepare('DELETE FROM merchants WHERE id=?').run(old.id);
        }
      this.db
        .prepare(
          'INSERT OR IGNORE INTO merchant_identifiers(merchant_key,merchant_id,identifier) VALUES(?,?,?)',
        )
        .run(key, id, input.identifier);
    })();
  }
  private write(m: Merchant) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO merchants(id,payee,payee_key,category_id,source,name_priority,category_priority,name_choices,category_choices,name_confirmed,conflict,review_reason,decision_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.id,
        m.payee,
        nameKey(m.payee),
        m.category_id,
        m.source,
        m.name_priority,
        m.category_priority,
        m.name_choices,
        m.category_choices,
        m.name_confirmed,
        m.conflict,
        m.review_reason,
        m.decision_at,
        m.updated_at,
      );
  }
  /** Saving an existing preferred name explicitly combines the two merchants. */
  validateEdit(id: string | undefined, payee: string, identifiers: string[]) {
    if (id && !this.get(id)) throw new Error('Merchant changed or was merged. Refresh the list.');
    const allowed = (
      this.db
        .prepare('SELECT id FROM merchants WHERE id=? OR payee_key=?')
        .all(id ?? '', nameKey(payee)) as { id: string }[]
    ).map((r) => this.get(r.id)!);
    const keys = new Set(identifiers.map(merchantKey));
    if (keys.size !== identifiers.length)
      throw new Error('Each SMS identifier must be unique (ignoring case and punctuation).');
    for (const identifier of identifiers) {
      if (merchantReviewReason(identifier))
        throw new Error('Use merchant identifiers without dates, amounts, or generic placeholders');
      const owner = this.find(identifier);
      if (owner && !allowed.some((m) => m.id === owner.id))
        throw new Error(
          `SMS identifier “${identifier}” already belongs to ${owner.payee}. Use the same preferred name to merge them.`,
        );
    }
    return allowed;
  }
  save(
    id: string | undefined,
    payee: string,
    identifiers: string[],
    categoryId: string | null,
  ): MerchantView {
    return this.db.transaction(() => {
      const related = this.validateEdit(id, payee, identifiers);
      const target = id ?? related[0]?.id ?? randomUUID();
      const now = new Date().toISOString();
      const retained = [...identifiers];
      // Absorbed merchants keep all their identifiers; an edit may remove its own identifiers.
      for (const other of related.filter((m) => m.id !== id))
        for (const identifier of other.identifiers)
          if (!retained.some((i) => merchantKey(i) === merchantKey(identifier)))
            retained.push(identifier);
      const keys = new Set(retained.map(merchantKey));
      for (const old of related) {
        for (const identifier of old.identifiers)
          if (!keys.has(merchantKey(identifier)))
            this.db
              .prepare('INSERT OR IGNORE INTO suppressed_merchant_identifiers VALUES(?)')
              .run(merchantKey(identifier));
        this.db.prepare('DELETE FROM merchant_identifiers WHERE merchant_id=?').run(old.id);
        this.db.prepare('DELETE FROM merchants WHERE id=?').run(old.id);
      }
      this.write({
        id: target,
        payee,
        category_id: categoryId,
        source: 'local',
        name_priority: 4,
        category_priority: 4,
        name_choices: JSON.stringify([payee]),
        category_choices: JSON.stringify(categoryId ? [categoryId] : []),
        name_confirmed: 1,
        conflict: 0,
        review_reason: null,
        decision_at: now,
        updated_at: now,
      });
      for (const identifier of retained) {
        this.db
          .prepare('DELETE FROM suppressed_merchant_identifiers WHERE merchant_key=?')
          .run(merchantKey(identifier));
        this.db
          .prepare(
            'INSERT INTO merchant_identifiers(merchant_key,merchant_id,identifier) VALUES(?,?,?)',
          )
          .run(merchantKey(identifier), target, identifier);
      }
      return this.get(target)!;
    })();
  }
  flag(identifier: string, reason: string) {
    const m = this.find(identifier);
    if (m)
      this.write({
        ...m,
        name_priority: Math.min(m.name_priority, 3),
        category_priority: Math.min(m.category_priority, 3),
        conflict: 1,
        name_confirmed: 0,
        review_reason: reason,
      });
  }
  /** Actual history is a snapshot: removed or corrected observations must not stay authoritative. */
  resetHistory() {
    this.db.transaction(() => {
      for (const m of this.list()) {
        const retainedReview =
          m.name_priority >= 3 &&
          m.review_reason !== 'Conflicting saved categories — choose a shared category'
            ? m.review_reason
            : null;
        if (m.name_priority === 2) {
          m.payee = m.identifiers[0]!;
          m.name_priority = 0;
          m.name_choices = JSON.stringify([m.payee]);
          m.name_confirmed = 0;
          m.source = 'sms';
          m.review_reason = null;
          m.conflict = 0;
        }
        if (m.category_priority === 2) {
          m.category_id = null;
          m.category_priority = -1;
          m.category_choices = '[]';
          m.review_reason = null;
          m.conflict = 0;
        }
        if (retainedReview) {
          m.review_reason = retainedReview;
          m.conflict = 1;
          m.name_confirmed = 0;
        }
        this.write(m);
      }
    })();
  }
  migrate() {
    const key = 'global-merchants-v1';
    if (this.db.prepare('SELECT 1 FROM service_migrations WHERE key=?').get(key)) return;
    this.db.transaction(() => {
      const profiles = this.db
        .prepare('SELECT * FROM merchant_profiles ORDER BY updated_at')
        .all() as {
        merchant: string;
        merchant_key: string;
        payee: string;
        renamed: number;
        updated_at: string;
        account_id: string;
      }[];
      const mappings = this.db
        .prepare('SELECT * FROM merchant_mappings ORDER BY decision_at')
        .all() as {
        merchant_key: string;
        payee: string;
        category_id: string;
        source: 'local' | 'actual' | 'ai';
        decision_at: string;
        account_id: string;
        review_reason?: string;
      }[];
      const profileIndex = new Map(
        profiles.map((p) => [JSON.stringify([p.account_id, p.merchant_key]), p]),
      );
      // Keep the original scoped records for provenance and upgrade recovery.
      for (const p of profiles)
        this.record({
          identifier: p.merchant,
          payee: p.payee,
          source: p.renamed ? 'local' : 'sms',
          at: p.updated_at,
        });
      for (const m of mappings) {
        const profile = profileIndex.get(JSON.stringify([m.account_id, m.merchant_key]));
        this.record({
          identifier: profile?.merchant ?? m.merchant_key,
          payee: profile?.renamed ? profile.payee : m.payee,
          source: m.source,
          categoryId: m.category_id,
          at: m.decision_at,
          reviewReason: m.review_reason,
        });
      }
      this.db.prepare('INSERT INTO service_migrations(key,value) VALUES(?,?)').run(
        key,
        JSON.stringify({
          at: new Date().toISOString(),
          merchants: this.list().length,
          profiles: profiles.length,
          mappings: mappings.length,
        }),
      );
    })();
  }
}
