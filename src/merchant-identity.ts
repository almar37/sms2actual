const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

export function merchantKey(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[٠-٩]/gu, (digit) => String(arabicDigits.indexOf(digit)))
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** These descriptions cannot identify a merchant, even when an old mapping exists. */
export function merchantReviewReason(value: string): string | undefined {
  const key = merchantKey(value);
  if (!key) return 'Missing merchant';
  if (['unknown merchant', 'bank transfer', 'card cashback', 'atm withdrawal'].includes(key))
    return 'Generic description';
  const digits = value.replace(/[٠-٩]/gu, (digit) => String(arabicDigits.indexOf(digit)));
  if (
    /\d{1,4}[-/]\d{1,2}[-/]\d{1,4}|\d{1,2}:\d{2}/u.test(digits) ||
    /\b\d{1,4} \d{1,2} \d{1,4} \d{1,2} \d{2}$/u.test(key)
  )
    return 'Contains a transaction date or time';
  if (/^(?:amount|balance|رصيد|الرصيد|مبلغ|المبلغ)\s*[:：]/iu.test(value))
    return 'Contains a transaction field';
  if (/(?:^|\s)(?:مبلغ|المبلغ|رصيد|الرصيد|amount|balance)(?:\s+\d|$)/iu.test(key))
    return 'Contains a transaction amount or balance';
}
