/** Literal selections keep learned formats anchored to the received SMS. */
export const selectionFields = [
  'amount',
  'merchant',
  'suffix',
  'balance',
  'fee',
  'to',
  'date',
] as const;
export type SelectionField = (typeof selectionFields)[number];
export interface TextSelection {
  value: string;
  start?: number;
}
export type TemplateSelections = Partial<Record<SelectionField, TextSelection>>;

export function selectionError(message: string, selection: TextSelection): string | undefined {
  const { value, start } = selection;
  if (!value || !message.includes(value)) return 'Select an actual part of the received SMS text.';
  if (start !== undefined) {
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      message.slice(start, start + value.length) !== value
    )
      return 'Select an actual part of the received SMS text.';
  } else if (message.indexOf(value) !== message.lastIndexOf(value))
    return 'This text occurs more than once. Select the intended occurrence in the SMS.';
}

export function patternFromSelections(message: string, selections: TemplateSelections): string {
  if (!selections.amount?.value) throw new Error('Select the amount from the SMS.');
  // Literal braces would be interpreted as placeholders by the template compiler.
  if (/[{}]/u.test(message)) throw new Error('Messages containing braces need a manual template.');
  const spans = selectionFields
    .flatMap((field) => {
      const selection = selections[field];
      if (!selection?.value) return [];
      const error = selectionError(message, selection);
      if (error) throw new Error(`${field}: ${error}`);
      const start = selection.start ?? message.indexOf(selection.value);
      if (['amount', 'balance', 'fee', 'suffix', 'to'].includes(field)) {
        const before = message[start - 1] ?? '',
          after = message[start + selection.value.length] ?? '';
        if (/[\d٠-٩.,٬٫]/u.test(before) || /[\d٠-٩.,٬٫]/u.test(after))
          throw new Error(`${field}: Select the complete number from the SMS.`);
      }
      return [
        {
          field,
          start: selection.start ?? message.indexOf(selection.value),
          value: selection.value,
        },
      ];
    })
    .sort((a, b) => a.start - b.start);
  let pattern = '',
    end = 0;
  for (const span of spans) {
    if (span.start < end) throw new Error('Selected fields must not overlap.');
    pattern += message.slice(end, span.start) + `{${span.field}}`;
    end = span.start + span.value.length;
  }
  return (pattern + message.slice(end)).trim();
}

export const templateDateFormats = {
  iso: 'ISO (2026-11-05 14:30)',
  'd/M/yyyy H:mm': 'Day/month/year + time (5/11/2026 14:30)',
  'd/M/yy H:mm': 'Day/month/short year + time (5/11/26 14:30)',
  'yy/M/d H:mm': 'Short year/month/day + time (26/11/5 14:30)',
  'd/M/yyyy': 'Day/month/year (5/11/2026)',
  'd/M/yy': 'Day/month/short year (5/11/26)',
  'yy/M/d': 'Short year/month/day (26/11/5)',
} as const;
export type TemplateDateFormat = keyof typeof templateDateFormats;
