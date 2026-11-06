import type { ParsedTransaction } from './types.js';

export function transactionNotes(tx: ParsedTransaction, review = false): string {
  return [
    tx.note,
    tx.foreign ? `${tx.foreign.amount} ${tx.foreign.currency}` : '',
    review ? 'REVIEW REQUIRED' : '',
  ]
    .filter(Boolean)
    .join(' | ');
}
