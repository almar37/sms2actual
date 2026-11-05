let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) onUnauthorized?.();
    throw new Error(
      data.error?.message ?? data.error ?? data.message ?? `Request failed (${response.status})`,
    );
  }
  return data as T;
}
export const money = (cents: number | null | undefined) =>
  cents == null
    ? '—'
    : new Intl.NumberFormat('en-SA', {
        style: 'currency',
        currency: 'SAR',
        minimumFractionDigits: 2,
      }).format(cents / 100);
export const when = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Never';
export const actions = [
  ['purchase', 'Purchase'],
  ['refund', 'Refund'],
  ['transfer_out', 'Transfer out'],
  ['transfer_in', 'Transfer in'],
  ['card_payment', 'Card payment'],
  ['deposit', 'Deposit'],
  ['withdrawal', 'Cash withdrawal'],
  ['fee', 'Bank fee'],
] as const;

export function localDateInput(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function localDateIso(value: string) {
  const offset = -new Date(value).getTimezoneOffset();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.length === 16 ? value + ':00' : value}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
