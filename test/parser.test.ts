import { banks, parsing } from './fixtures/banks.js';
import { describe, expect, it } from 'vitest';
import { normalizeText, PARSER_REVISION, parseSms } from '../src/parser.js';
import { smsFixtures } from './fixtures/sms.js';

describe('SMS parser fixture corpus', () => {
  it.each(smsFixtures)('$provenance: $name', ({ sender, message, receivedAt, expected }) => {
    expect(parseSms(message, receivedAt, banks, sender, parsing)).toStrictEqual(expected);
  });

  it('tracks the parser release represented by the corpus', () => {
    expect(PARSER_REVISION).toBe(15);
  });
});

describe('SMS normalization', () => {
  it('normalizes Arabic digits and separators', () => {
    expect(normalizeText('١٬٢٣٤٫٥٦')).toBe('1234.56');
  });
});

describe('routing identifier regressions', () => {
  it('does not interpret By inside Ruby as an account label', () => {
    expect(
      parseSms(
        'Purchase at Ruby 1234 Amount: SAR 10 Card:2393',
        '2026-08-22T10:00:00Z',
        banks,
        'SAB',
        parsing,
      ),
    ).toMatchObject({ type: 'transaction', transaction: { accountAlias: '2393' } });
  });
  it.each(['IBAN:', 'To:'])('preserves a grouped IBAN suffix in %s', (label) => {
    expect(
      parseSms(
        `Outgoing transfer From: 5202 ${label} SA03 8000 0000 6080 1016 7404 Bank 123 Amount: SAR 100`,
        '2026-08-22T10:00:00Z',
        banks,
        'SAB',
        parsing,
      ),
    ).toMatchObject({ type: 'transaction', transaction: { transferCounterpartyAlias: '7404' } });
  });
});

describe('Al Rajhi transfers between owned accounts', () => {
  it('extracts the debit account and destination from the own-account notification', () => {
    expect(
      parseSms(
        'حوالة بين حساباتك\nمبلغ:SR 1\nمن:7900\nالى:0131\n26/11/5 21:09',
        '2026-11-05T18:09:41.561Z',
        banks,
        'AlRajhiBank',
        parsing,
      ),
    ).toMatchObject({
      type: 'transaction',
      transaction: {
        kind: 'transfer_out',
        accountAlias: '7900',
        transferCounterpartyAlias: '0131',
        amountCents: -100,
        occurredAt: '2026-11-05T21:09:41.561+03:00',
      },
    });
  });
  it('holds an own-account notification without a destination for review', () => {
    expect(
      parseSms(
        'حوالة بين حساباتك مبلغ:SR 1 من:7900',
        '2026-11-05T18:09:41.561Z',
        banks,
        'AlRajhiBank',
        parsing,
      ),
    ).toMatchObject({ type: 'needs_review', reason: 'malformed_notification' });
  });
});

describe('Al Rajhi compact online purchases', () => {
  // Synthetic values preserve the bank's wording and escaped line breaks.
  const message =
    'شراء إنترنت بـSR 42.35 \\nعبر4187;فيزا\\nلـAmazon sa\\nرصيد:1234.56 SR\\n؜5/11/26 21:34';
  const receivedAt = '2026-11-05T18:34:29.264Z';
  const parse = (sms: string) => parseSms(sms, receivedAt, banks, 'AlRajhiBank', parsing);

  it.each([
    ['literal newline escapes', message],
    ['newlines', message.replaceAll('\\n', '\n')],
    ['CRLF', message.replaceAll('\\n', '\r\n')],
    [
      'Arabic digits and separators',
      message.replace('42.35', '٤٢٫٣٥').replace('1234.56', '١٬٢٣٤٫٥٦'),
    ],
  ])('extracts purchase details with %s', (_name, sms) => {
    expect(parse(sms!)).toMatchObject({
      type: 'transaction',
      transaction: {
        bank: 'alrajhi',
        kind: 'purchase',
        accountAlias: '4187',
        amountCents: -4235,
        principalCents: -4235,
        feeCents: 0,
        balanceCents: 123456,
        payee: 'Amazon sa',
        occurredAt: '2026-11-05T21:34:00.000+03:00',
      },
    });
  });

  it.each([
    ['missing amount', message.replace('SR 42.35', 'SR')],
    ['foreign amount', message.replace('SR 42.35', 'USD 42.35')],
    ['invalid amount', message.replace('42.35', '42.355')],
    ['missing card', message.replace('4187', '')],
    ['invalid card', message.replace('4187', '418712345')],
    ['missing merchant', message.replace('لـAmazon sa', '')],
    ['empty merchant with literal escapes', message.replace('Amazon sa', '')],
    ['empty merchant with newlines', message.replace('Amazon sa', '').replaceAll('\\n', '\n')],
  ])('holds a notification with %s for review', (_name, sms) => {
    expect(parse(sms!)).toStrictEqual({ type: 'needs_review', reason: 'malformed_notification' });
  });
});
