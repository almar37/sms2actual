import { describe, expect, it } from 'vitest';
import { extractReviewDraft, extractReviewSelections, parseSms } from '../src/parser.js';
import { patternFromSelections, selectionError } from '../src/template-selection.js';
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
  it('parses the compact Arabic transfer and retains review suggestions', () => {
    expect(parseSms(waterTransfer, receivedAt, banks, 'AlRajhiBank', parsing)).toMatchObject({
      type: 'transaction',
      transaction: { kind: 'transfer_out', amountCents: -20029, payee: 'Ammar Shehari' },
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
  it.each(['SR 125.50', '125.50 SR', '١٢٥٫٥٠ SR'])(
    'suggests a unique %s amount and compact من account for unknown wording',
    (amount) => {
      const message = `تنبيه جديد ${amount}\nمن٠١٣١\nرسوم:٠٫٢٩ SR\nرصيد:٩٠٠٠ SR`;
      expect(parseSms(message, receivedAt, banks, 'AlRajhiBank', parsing)).toMatchObject({
        type: 'needs_review',
      });
      expect(draft(message)).toMatchObject({
        accountAlias: '0131',
        principalCents: -12550,
        feeCents: 29,
      });
      const selections = extractReviewSelections(
        message,
        receivedAt,
        banks,
        'AlRajhiBank',
        parsing,
      );
      expect(selections.suffix?.value).toBe('٠١٣١');
      expect(selections.amount?.value).toBe(amount.replace(/SR\s*|\s*SR/gu, ''));
      for (const selection of Object.values(selections))
        expect(selectionError(message, selection)).toBeUndefined();
      expect(patternFromSelections(message, selections)).toContain('من{suffix}');
    },
  );
  it('keeps exact offsets for repeated amounts, separators, escaped newlines and Arabic digits', () => {
    const message = 'تنبيه جديد ١٬٢٣٤٫٥٦ SR\\nمن٠١٣١\\nرسوم:٠٫٢٩ SR\\nرصيد:١٬٢٣٤٫٥٦ SR';
    const selections = extractReviewSelections(message, receivedAt, banks, 'AlRajhiBank', parsing);
    expect(selections.amount?.value).toBe('١٬٢٣٤٫٥٦');
    expect(selections.balance?.value).toBe('١٬٢٣٤٫٥٦');
    expect(selections.amount?.start).not.toBe(selections.balance?.start);
    expect(patternFromSelections(message, selections)).toBe(
      'تنبيه جديد {amount} SR\\nمن{suffix}\\nرسوم:{fee} SR\\nرصيد:{balance} SR',
    );
  });
  it.each([
    'Fees SR 10 Balance SR 900',
    'Unknown 10 SR and 20 SR',
    'Unknown -10 SR',
    'Unknown 10.001 SR',
  ])('does not guess a principal from ambiguous or invalid money: %s', (message) => {
    expect(draft(message).principalCents).toBeUndefined();
    expect(
      extractReviewSelections(message, receivedAt, banks, 'AlRajhiBank', parsing).amount,
    ).toBeUndefined();
  });
});
