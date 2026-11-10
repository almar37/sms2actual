import { describe, expect, it } from 'vitest';
import { patternFromSelections, selectionError } from '../src/template-selection.js';
import { compileMessageTemplate } from '../src/console-config.js';

describe('learning literal SMS fields', () => {
  it('preserves Arabic text and punctuation while capturing future values', () => {
    const pattern = patternFromSelections('عملية: متجر! مبلغ ١٢٫٥٠ ريال بطاقة ١٢٣٤', {
      merchant: { value: 'متجر!' },
      amount: { value: '١٢٫٥٠' },
      suffix: { value: '١٢٣٤' },
    });
    expect(pattern).toBe('عملية: {merchant} مبلغ {amount} ريال بطاقة {suffix}');
    expect(
      compileMessageTemplate(pattern).exec('عملية: آخر مبلغ ٩٩٫٩٠ ريال بطاقة ٥٦٧٨')?.groups,
    ).toMatchObject({ merchant: 'آخر', amount: '٩٩٫٩٠', suffix: '٥٦٧٨' });
  });
  it('requires exact text and explicit positions for repeated values', () => {
    expect(selectionError('Amount 25 balance 25', { value: 'Coffee' })).toMatch(/actual part/);
    expect(selectionError('Amount 25 balance 25', { value: '25' })).toMatch(/more than once/);
    expect(selectionError('Amount 25 balance 25', { value: '25', start: 7 })).toBeUndefined();
    expect(() =>
      patternFromSelections('Amount 25 balance 25', {
        amount: { value: '25', start: 7 },
        balance: { value: '25', start: 18 },
      }),
    ).not.toThrow();
  });
  it('rejects overlapping selections, forged offsets, partial numbers and adjacent fields', () => {
    expect(() =>
      patternFromSelections('Paid 125.00 at Shop', { amount: { value: '25.00' } }),
    ).toThrow(/complete number/);
    expect(() =>
      patternFromSelections('Paid 25 at Shop', { amount: { value: '25', start: 0 } }),
    ).toThrow(/actual part/);
    expect(() =>
      patternFromSelections('Paid 25 at Shop', {
        amount: { value: '25' },
        merchant: { value: '25 at Shop' },
      }),
    ).toThrow(/overlap/);
    expect(() =>
      compileMessageTemplate(
        patternFromSelections('25Shop', { amount: { value: '25' }, merchant: { value: 'Shop' } }),
      ),
    ).toThrow(/Separate fields/);
  });
  it('rejects missing amounts and placeholder injection in the sample', () => {
    expect(() => patternFromSelections('Shop', { merchant: { value: 'Shop' } })).toThrow(/amount/);
    expect(() => patternFromSelections('25 {merchant}', { amount: { value: '25' } })).toThrow(
      /braces/,
    );
  });
});

describe('dates captured from literal SMS text', () => {
  it.each([
    ['٥/١١/٢٦ ١٤:٣٠', 'd/M/yy H:mm', '2026-11-05T14:30:00.000+03:00'],
    ['26/11/5 14:30', 'yy/M/d H:mm', '2026-11-05T14:30:00.000+03:00'],
    ['2026-11-05T14:30:00+03:00', 'iso', '2026-11-05T14:30:00.000+03:00'],
  ] as const)('parses %s using the selected format', async (date, dateFormat, expected) => {
    const { matchMessageTemplate } = await import('../src/console-config.js');
    const tx = matchMessageTemplate(
      {
        id: 'date-test',
        name: 'Receipt',
        bank: 'sab',
        kind: 'purchase',
        pattern: 'Paid {amount} at {date}',
        dateFormat,
        enabled: true,
      },
      `Paid 25 at ${date}`,
      '2026-11-05T15:00:00+03:00',
      'sab',
    );
    expect(tx?.occurredAt).toBe(expected);
  });
  it('rejects an invalid calendar date instead of falling back to the received date', async () => {
    const { matchMessageTemplate } = await import('../src/console-config.js');
    expect(() =>
      matchMessageTemplate(
        {
          id: 'invalid-date',
          name: 'Receipt',
          bank: 'sab',
          kind: 'purchase',
          pattern: 'Paid {amount} at {date}',
          dateFormat: 'd/M/yy',
          enabled: true,
        },
        'Paid 25 at 31/2/26',
        '2026-11-05T15:00:00+03:00',
        'sab',
      ),
    ).toThrow(/date format/);
  });
});
