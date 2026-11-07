import { createHash } from 'node:crypto';
import type { ParsedTransaction } from './types.js';
export const stableId = (tx: ParsedTransaction, accountKey: string, suffix = 'main') =>
  'sms:' +
  createHash('sha256')
    .update(
      [
        tx.bank,
        tx.accountAlias ?? accountKey,
        tx.kind,
        tx.occurredAt,
        tx.amountCents,
        tx.payee,
        suffix,
      ].join('|'),
    )
    .digest('hex');
