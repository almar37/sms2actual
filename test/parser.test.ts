import { banks, parsing } from './fixtures/banks.js';
import { describe, expect, it } from 'vitest';
import { normalizeText, PARSER_REVISION, parseSms } from '../src/parser.js';
import { smsFixtures } from './fixtures/sms.js';

describe('SMS parser fixture corpus', () => {
  it.each(smsFixtures)('$provenance: $name', ({ sender, message, receivedAt, expected }) => {
    expect(parseSms(message, receivedAt, banks, sender, parsing)).toStrictEqual(expected);
  });

  it('tracks the parser release represented by the corpus', () => {
    expect(PARSER_REVISION).toBe(16);
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

  it.each(['\n', '\\n', '\r\n', '\\r\\n'])(
    'bounds the merchant without a balance using %j',
    (newline) => {
      const sms = ['شراء إنترنت بـSR 42.35', 'عبر4187;فيزا', 'لـAmazon sa', '5/11/26 21:34'].join(
        newline,
      );
      expect(parse(sms)).toMatchObject({
        type: 'transaction',
        transaction: { payee: 'Amazon sa', amountCents: -4235 },
      });
    },
  );

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

describe('Al Rajhi merchant integrity', () => {
  const parse = (sms: string) =>
    parseSms(sms, '2026-11-07T19:09:21.169Z', banks, 'AlRajhiBank', parsing);
  it.each(['\n', '\\n', '\r\n', '\\r\\n'])('parses Arabic POS with %j', (newline) => {
    const sms = [
      'شراء عبر نقاط البيع',
      'بطاقة:8077 ;فيزا',
      'لدى:MYSR*Jahe',
      'مبلغ:٧٧٫٥ SAR',
      'رصيد:٢٠٬٠٢٠٫٨٨ SAR',
      '؜7/11/26 22:09',
    ].join(newline);
    expect(parse(sms)).toMatchObject({
      type: 'transaction',
      transaction: { payee: 'MYSR*Jahe', amountCents: -7750, balanceCents: 2002088 },
    });
  });
  it.each(['SHOP COUNTRY MARKET', 'Coffee, Books & Co.', 'متجر في الرياض', 'متجر ٢٤'])(
    'preserves %s exactly',
    (merchant) => {
      expect(
        parse(`POS Purchase\nCard:8077;Visa\nAt:${merchant}\nAmount:SAR 20\nBalance:SAR 100`),
      ).toMatchObject({
        type: 'transaction',
        transaction: { payee: merchant, amountCents: -2000 },
      });
    },
  );
  it.each(['Online Purchase', 'Reverse Transaction', 'شراء عبر نقاط البيع', 'عكس عملية'])(
    'requires a merchant for %s',
    (header) => {
      for (const merchant of [
        '',
        'At:\n',
        'لدى:\n',
        'At:Unknown merchant\n',
        'At:5/11/26 21:34\n',
        'At:٥/١١/٢٦ ٢١:٣٤\n',
        'At:Amount:SAR 20\n',
        'At:One\nAt:Two\n',
      ]) {
        expect(
          parse(`${header}\nCard:8077;Visa\n${merchant}Amount:SAR 20\nBalance:SAR 100`),
        ).toEqual({ type: 'needs_review', reason: 'malformed_notification' });
      }
    },
  );
  it('uses delimited fields on a single line without truncating label words in the name', () => {
    expect(
      parse('Online Purchase Card:8077;Visa At:SHOP COUNTRY MARKET Amount:SAR 20 Balance:SAR 100'),
    ).toMatchObject({ type: 'transaction', transaction: { payee: 'SHOP COUNTRY MARKET' } });
  });
  it('preserves a refund merchant across transport formats', () => {
    for (const newline of ['\n', '\\n', '\r\n'])
      expect(
        parse(
          [
            'Reverse Transaction',
            'By:2393;Visa',
            'At:Coffee, Books & Co.',
            'Amount:SAR 20',
            '5/11/26 21:34',
          ].join(newline),
        ),
      ).toMatchObject({
        type: 'transaction',
        transaction: { kind: 'refund', payee: 'Coffee, Books & Co.', amountCents: 2000 },
      });
  });
});

describe('Al Rajhi compact credit-card payment receipts', () => {
  const message = 'بطاقة فيزا:سداد بـSR 80.50 \\nعبر2393;فيزا\\nرصيد:1200.1 SR \\n؜5/11/26 21:56';
  const receivedAt = '2026-11-05T18:56:40.094Z';
  const parse = (sms: string) => parseSms(sms, receivedAt, banks, 'AlRajhiBank', parsing);

  it.each([
    ['literal newline escapes', message],
    ['newlines', message.replaceAll('\\n', '\n')],
    ['CRLF', message.replaceAll('\\n', '\r\n')],
    ['Arabic digits', message.replace('80.50', '٨٠٫٥٠').replace('2393', '٢٣٩٣')],
    ['no balance', message.replace('رصيد:1200.1 SR', '')],
  ])('credits the card without inventing a funding account with %s', (_name, sms) => {
    expect(parse(sms!)).toMatchObject({
      type: 'transaction',
      transaction: {
        bank: 'alrajhi',
        kind: 'transfer_in',
        cardPaymentReceived: true,
        accountAlias: '2393',
        amountCents: 8050,
        principalCents: 8050,
        feeCents: 0,
        transferCounterpartyAlias: undefined,
        payee: 'Bank transfer',
        occurredAt: '2026-11-05T21:56:00.000+03:00',
      },
    });
  });

  it.each([
    ['missing amount', message.replace('SR 80.50', 'SR')],
    ['foreign amount', message.replace('SR 80.50', 'USD 80.50')],
    ['invalid amount', message.replace('80.50', '80.501')],
    ['missing card', message.replace('2393', '')],
    ['invalid card', message.replace('2393', '239312345')],
  ])('holds a receipt with %s for review', (_name, sms) => {
    expect(parse(sms!)).toStrictEqual({ type: 'needs_review', reason: 'malformed_notification' });
  });

  it('does not mark an ordinary deposit as a credit-card repayment', () => {
    const result = parse('Incoming transfer To: 2393 Amount: SAR 80.50 Balance: SAR 1200.10');
    expect(result).toMatchObject({ type: 'transaction', transaction: { kind: 'transfer_in' } });
    if (result.type === 'transaction')
      expect(result.transaction.cardPaymentReceived).toBeUndefined();
  });
});

describe('Arabic merchant field boundaries', () => {
  it('keeps the amount label out of the Jahez merchant', () => {
    const result = parseSms(
      'شراء عبر نقاط البيع \nبطاقة:8077 ;فيزا\nلدى:MYSR*Jahe\nمبلغ:77.5 SAR\nرصيد:20020.88 SAR\n؜7/11/26 22:09',
      '2026-11-07T19:09:21.169Z',
      banks,
      'AlRajhiBank',
      parsing,
    );
    expect(result).toMatchObject({
      type: 'transaction',
      transaction: {
        payee: 'MYSR*Jahe',
        amountCents: -7750,
        accountAlias: '8077',
      },
    });
  });
});
