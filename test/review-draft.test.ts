import { describe, expect, it } from 'vitest';
import { extractReviewDraft, parseSms } from '../src/parser.js';
import { banks, parsing } from './fixtures/banks.js';
import { sevenGramMessage, sevenGramReceivedAt } from './fixtures/alrajhi-compact-pos.js';

const receivedAt = '2026-11-06T14:10:00+03:00';
export const waterTransfer =
  'حوالة محلية صادرةبـ200 SR\nمن7900\nلـ7001;Ammar Shehari\nرسوم:0.29 SR\n26/11/6 14:08';
const draft = (message: string, sender = 'AlRajhiBank') =>
  extractReviewDraft(message, receivedAt, banks, sender, parsing);

describe('review suggestions', () => {
  it('prefills Seven Gram details even if the notification remains in review', () => {
    expect(
      extractReviewDraft(sevenGramMessage, sevenGramReceivedAt, banks, 'AlRajhiBank', parsing),
    ).toMatchObject({
      bank: 'alrajhi',
      kind: 'purchase',
      accountAlias: '2271',
      principalCents: -1200,
      payee: 'Seven Gram',
      occurredAt: '2026-11-10T23:17:00.000+03:00',
    });
    const partial = extractReviewDraft(
      sevenGramMessage.replace('بـ12 SR', ''),
      sevenGramReceivedAt,
      banks,
      'AlRajhiBank',
      parsing,
    );
    expect(partial).toMatchObject({ accountAlias: '2271', payee: 'Seven Gram' });
    expect(partial.principalCents).toBeUndefined();
  });
  it('extracts the compact Arabic transfer without authorizing automatic import', () => {
    expect(parseSms(waterTransfer, receivedAt, banks, 'AlRajhiBank', parsing)).toEqual({
      type: 'needs_review',
      reason: 'unrecognized_template',
    });
    expect(draft(waterTransfer)).toMatchObject({
      bank: 'alrajhi',
      kind: 'transfer_out',
      accountAlias: '7900',
      principalCents: -20000,
      feeCents: 29,
      payee: 'Ammar Shehari',
      occurredAt: '2026-11-06T14:08:00.000+03:00',
    });
  });
  it('recognizes incoming direction and Arabic digits', () => {
    expect(draft('حوالة محلية واردة ٢٠٠ SR إلى ٧٩٠٠ من Example Person رسوم:٠٫٢٩ SR')).toMatchObject(
      {
        kind: 'transfer_in',
        accountAlias: '7900',
        principalCents: 20000,
        feeCents: 29,
      },
    );
  });
  it('retains available fields when the amount is missing', () => {
    const result = draft('Transfer sent From: 1234 To: Example Person Fees: SAR 0.29', 'SAB');
    expect(result).toMatchObject({
      bank: 'sab',
      kind: 'transfer_out',
      accountAlias: '1234',
      feeCents: 29,
    });
    expect(result.principalCents).toBeUndefined();
  });
  it('does not invent an action or amount for unfamiliar wording', () => {
    const result = draft('Unfamiliar notification');
    expect(result.bank).toBe('alrajhi');
    expect(result.kind).toBeUndefined();
    expect(result.principalCents).toBeUndefined();
  });
  it('keeps named senders authoritative and supports review-only banks', () => {
    expect(draft('SAB transfer sent Amount SAR 10', 'Unknown').bank).toBeUndefined();
    expect(draft('Transfer sent Amount SAR 10', 'STC Bank').bank).toBe('stc');
  });
  it('does not use a balance or fee as the missing principal', () => {
    expect(draft('Transfer sent Fees SAR 0.29 Balance SAR 900').principalCents).toBeUndefined();
  });
  it('derives principal from an explicitly labelled total and fees', () => {
    expect(draft('Transfer sent Total amount SAR 200.29 Fees SAR 0.29')).toMatchObject({
      principalCents: -20000,
      feeCents: 29,
    });
  });
});
