import { DateTime } from 'luxon';

/** Use the same calendar day as SMS parsing, regardless of the container's timezone. */
export function currentBudgetDate(): string {
  return DateTime.now().setZone('Asia/Riyadh').toISODate()!;
}
