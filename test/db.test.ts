import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let stores: EventStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});
describe('event store', () => {
  it('deduplicates explicit and hashed events', () => {
    const s = new EventStore(':memory:');
    stores.push(s);
    const input = {
      message: ' hello   world ',
      sender: 'SAB',
      receivedAt: new Date().toISOString(),
    };
    const a = s.enqueue(input),
      b = s.enqueue({ ...input, message: 'hello world' });
    expect(b).toEqual({ id: a.id, duplicate: true });
  });
  it('keeps a selected inbox checkpoint after reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sms2actual-checkpoint-'));
    const path = join(directory, 'events.sqlite');
    const chosen = { date: Date.parse('2026-10-01T09:30:00+03:00'), rowId: 0 };
    try {
      const first = new EventStore(path);
      try {
        first.setInboxCheckpoint(chosen.date, null);
      } finally {
        first.close();
      }
      const restored = new EventStore(path);
      try {
        expect(restored.inboxCheckpoint()).toEqual(chosen);
        expect(restored.startInboxSync(Date.parse('2026-11-06T00:00:00Z'))).toEqual(chosen);
      } finally {
        restored.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('recovers processing work after restart', () => {
    const s = new EventStore(':memory:');
    stores.push(s);
    const { id } = s.enqueue({ message: 'x', receivedAt: new Date().toISOString() });
    expect(s.claim()?.id).toBe(id);
    s.recover();
    expect(s.claim()?.id).toBe(id);
  });
  it('quarantines legacy AI mappings on upgrade and preserves explicit rules and import baselines', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sms2actual-mappings-'));
    const path = join(directory, 'events.sqlite');
    try {
      const first = new EventStore(path);
      try {
        for (const sourceRef of ['legacy-ai-event', 'console:rule', 'console-review:event'])
          first.putLocalMapping({
            account_id: 'checking',
            merchant_key: sourceRef,
            payee: 'Merchant',
            category_id: 'food',
            source_ref: sourceRef,
            decision_at: '2026-01-01T00:00:00.000Z',
          });
        first.recordMerchantImport('sms:import', 'Original', 'food');
        first.recordMerchantImport(
          'sms:import',
          'Retry should not replace the baseline',
          'shopping',
        );
        first.db.exec('ALTER TABLE local_mapping_observations DROP COLUMN source');
      } finally {
        first.close();
      }
      const restored = new EventStore(path);
      try {
        expect(restored.mapping('checking', 'legacy-ai-event')?.source).toBe('ai');
        expect(restored.mapping('checking', 'console:rule')?.source).toBe('local');
        expect(restored.mapping('checking', 'console-review:event')?.source).toBe('local');
        restored.replaceActualMappings([], '2026-11-08T00:00:00.000Z');
        expect(restored.mapping('checking', 'legacy-ai-event')?.source).toBe('ai');
        restored.resetSmsData();
        expect(restored.merchantImport('sms:import')).toEqual({
          payee: 'Original',
          category_id: 'food',
        });
      } finally {
        restored.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('claims identical-timestamp events in insertion order', () => {
    const s = new EventStore(':memory:');
    stores.push(s);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T10:00:00.000Z'));
    const first = s.enqueue({
      eventId: 'a',
      message: 'x',
      receivedAt: '2026-08-22T13:00:00+03:00',
    }).id;
    const second = s.enqueue({
      eventId: 'b',
      message: 'y',
      receivedAt: '2026-08-22T13:01:00+03:00',
    }).id;
    vi.useRealTimers();
    expect(s.get(first)!.created_at).toBe(s.get(second)!.created_at);
    expect(s.claim()?.id).toBe(first);
    expect(s.claim()?.id).toBe(second);
  });
  it('replays retained parser events once per parser revision', () => {
    const s = new EventStore(':memory:');
    stores.push(s);
    const retained = s.enqueue({
      eventId: 'retained',
      message: 'x',
      receivedAt: new Date().toISOString(),
    }).id;
    const expired = s.enqueue({
      eventId: 'expired',
      message: 'y',
      receivedAt: new Date().toISOString(),
    }).id;
    const imported = s.enqueue({
      eventId: 'imported',
      message: 'z',
      receivedAt: new Date().toISOString(),
    }).id;
    const needsReview = s.enqueue({
      eventId: 'needs-review',
      message: 'traffic fine',
      receivedAt: new Date().toISOString(),
    }).id;
    const queued = s.enqueue({
      eventId: 'queued-route-error',
      message: 'card bill',
      receivedAt: new Date().toISOString(),
    }).id;
    const failed = s.enqueue({
      eventId: 'failed-route-error',
      message: 'card bill',
      receivedAt: new Date().toISOString(),
    }).id;
    s.update(retained, 'ignored', { parserRevision: 2, parserReason: 'unrecognized_template' });
    s.update(expired, 'ignored', { parserRevision: 2, parserReason: 'unrecognized_template' });
    s.update(imported, 'imported', { parserRevision: 1 });
    s.update(needsReview, 'needs_review', {
      parserRevision: 2,
      parserReason: 'unrecognized_template',
    });
    s.update(failed, 'failed', { parserRevision: 2, error: 'Unmapped account route' });
    s.db.prepare('UPDATE events SET payload=NULL WHERE id=?').run(expired);

    expect(s.replayParserRevision(3)).toBe(4);
    expect(s.get(retained)).toMatchObject({
      status: 'queued',
      attempts: 0,
      parser_reason: null,
      parser_revision: 3,
    });
    expect(s.get(expired)?.status).toBe('ignored');
    expect(s.get(imported)?.status).toBe('imported');
    expect(s.get(needsReview)).toMatchObject({ status: 'queued', parser_revision: 3 });
    expect(s.get(queued)).toMatchObject({ status: 'queued', parser_revision: 3, error: null });
    expect(s.get(failed)).toMatchObject({ status: 'queued', parser_revision: 3, error: null });
    expect(s.eventHistory(needsReview).at(-1)).toMatchObject({
      from_status: 'needs_review',
      to_status: 'queued',
    });
    expect(s.replayParserRevision(3)).toBe(0);
  });
  it('retains raw input and append-only history indefinitely', () => {
    const s = new EventStore(':memory:');
    stores.push(s);
    const id = s.enqueue({
      eventId: 'forever',
      message: 'private message',
      receivedAt: '2026-08-22T10:10:30+03:00',
      location: { latitude: 24.7, longitude: 46.6 },
    }).id;
    s.update(id, 'ignored', { parserReason: 'otp_or_login' });
    s.recordEnrichment(id, 'not_applicable', { reason: 'ignored' });
    s.purge(0);

    expect(JSON.parse(s.get(id)!.payload!).message).toBe('private message');
    expect(s.eventHistory(id).map((entry) => entry.to_status)).toEqual(['queued', 'ignored']);
    expect(s.enrichmentAttempts(id)).toHaveLength(1);
  });
});

it('migrates retained unsupported formats with audit history and preserves merchant names across restart and reset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sms2actual-formats-'));
  const path = join(directory, 'events.sqlite');
  try {
    const first = new EventStore(path);
    const id = first.enqueue({
      sender: 'SAB',
      message: 'Old unsupported format',
      receivedAt: new Date().toISOString(),
    }).id;
    first.update(id, 'needs_review', { parserReason: 'unrecognized_template', parserRevision: 1 });
    first.observeMerchant('checking', 'COFFEE-HOUSE');
    first.saveMerchantName('checking', 'COFFEE-HOUSE', 'Coffee');
    first.close();
    const restored = new EventStore(path);
    try {
      expect(restored.get(id)).toMatchObject({
        status: 'unsupported_format',
        parser_reason: 'unrecognized_template',
      });
      expect(restored.eventHistory(id).at(-1)).toMatchObject({
        from_status: 'needs_review',
        to_status: 'unsupported_format',
      });
      expect(restored.replayParserRevision(2)).toBe(1);
      restored.observeMerchant('checking', 'COFFEE-HOUSE');
      restored.rebuildMerchantMappings();
      restored.resetSmsData();
      expect(restored.merchantProfile('checking', 'COFFEE-HOUSE')).toMatchObject({
        merchant: 'COFFEE-HOUSE',
        payee: 'Coffee',
        renamed: 1,
      });
    } finally {
      restored.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
