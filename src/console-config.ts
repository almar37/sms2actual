import { DateTime } from 'luxon';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from './db.js';
import type { ResolvedConfig, TxKind } from './types.js';

export const actionSchema = z.enum([
  'purchase',
  'refund',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'card_payment',
  'deposit',
  'fee',
]);
const suffix = z.string().regex(/^\d{3,6}$/);
export const consoleSettingsSchema = z
  .object({
    accounts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            type: z.enum(['checking', 'savings', 'credit']),
            match: z
              .object({
                bank: z.string().min(1),
                accountSuffixes: z.array(suffix).min(1).optional(),
                transferIdentifiers: z.array(suffix).min(1).optional(),
                billPaymentIdentifiers: z.array(suffix).min(1).optional(),
                transactionKinds: z.array(actionSchema).min(1).optional(),
                hasBalance: z.boolean().optional(),
              })
              .strict(),
            cards: z
              .array(
                z
                  .object({ suffix, name: z.string().max(80), type: z.enum(['debit', 'credit']) })
                  .strict(),
              )
              .default([]),
            creditLimitCents: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER)
              .optional(),
            fundingAccountId: z.string().optional(),
          })
          .strict(),
      )
      .max(100),
    bankFeesCategoryId: z.string().min(1),
    eligibleCategoryIds: z.array(z.string().min(1)).max(500),
  })
  .strict();
export type ConsoleSettings = z.infer<typeof consoleSettingsSchema>;
export const aiSettingsSchema = z
  .object({
    provider: z.enum(['disabled', 'opencode', 'openai', 'anthropic']),
    model: z.string().trim().min(1).max(120),
    apiKey: z.string().max(1000).optional(),
    minConfidence: z.number().min(0).max(1).default(0.7),
  })
  .strict();
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export const templateSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    bank: z.string().min(1),
    kind: actionSchema,
    pattern: z.string().trim().min(8).max(4000),
    sample: z.string().max(4000).optional(),
    sender: z.string().max(100).optional(),
    categoryId: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type MessageTemplate = z.infer<typeof templateSchema>;

export class ConsoleConfig {
  constructor(
    readonly store: EventStore,
    private secret: string,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS console_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS console_overrides(event_id TEXT PRIMARY KEY,value TEXT NOT NULL)',
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.store.db.prepare('SELECT value FROM console_settings WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.store.db
      .prepare(
        'INSERT INTO console_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  clearSmsState() {
    this.store.db.prepare('DELETE FROM console_overrides').run();
    this.store.db
      .prepare("DELETE FROM console_settings WHERE key='lastTaskerSync' OR key LIKE 'limit:%'")
      .run();
  }
  seed(config: ResolvedConfig): ConsoleSettings {
    return (
      this.get<ConsoleSettings>('routing') ?? {
        accounts: config.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          type: 'checking' as const,
          match: a.match,
          cards: [],
        })),
        bankFeesCategoryId: config.bankFeesCategoryId,
        eligibleCategoryIds: config.eligibleCategories.map((c) => c.id),
      }
    );
  }
  apply(
    settings: ConsoleSettings,
    config: ResolvedConfig,
    categories: { id: string; name: string }[],
  ) {
    config.accounts = settings.accounts.map((a) => ({
      id: a.id,
      key: a.id,
      name: a.name,
      match: {
        ...a.match,
        ...(a.match.accountSuffixes?.length || a.cards.length
          ? {
              accountSuffixes: [
                ...new Set([...(a.match.accountSuffixes ?? []), ...a.cards.map((c) => c.suffix)]),
              ],
            }
          : {}),
      },
      fundingAccountId: a.fundingAccountId,
    }));
    config.bankFeesCategoryId = settings.bankFeesCategoryId;
    config.eligibleCategories = categories.filter((c) =>
      settings.eligibleCategoryIds.includes(c.id),
    );
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      createHash('sha256').update(this.secret).digest(),
      iv,
    );
    return Buffer.concat([
      iv,
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
  }
  decrypt(value: string) {
    const b = Buffer.from(value, 'base64');
    const cipher = createDecipheriv(
      'aes-256-gcm',
      createHash('sha256').update(this.secret).digest(),
      b.subarray(0, 12),
    );
    cipher.setAuthTag(b.subarray(-16));
    return Buffer.concat([cipher.update(b.subarray(12, -16)), cipher.final()]).toString('utf8');
  }
  ai(): AiSettings {
    const settings = this.get<AiSettings>('ai');
    return settings
      ? { ...settings, apiKey: settings.apiKey ? this.decrypt(settings.apiKey) : undefined }
      : { provider: 'disabled', model: '', minConfidence: 0.7 };
  }
  saveAi(settings: AiSettings) {
    const previous = this.ai();
    const apiKey =
      settings.apiKey || (previous.provider === settings.provider ? previous.apiKey : undefined);
    if (settings.provider !== 'disabled' && !apiKey)
      throw new Error('Enter an API key for this provider');
    this.set('ai', { ...settings, apiKey: apiKey ? this.encrypt(apiKey) : undefined });
  }
  templates() {
    return this.get<MessageTemplate[]>('templates') ?? [];
  }
}

const fields: Record<string, string> = {
  amount: '(?<amount>[\\d٠-٩][\\d٠-٩,.٬٫]{0,31})',
  merchant: '(?<merchant>.{1,300}?)',
  suffix: '(?<suffix>[\\d٠-٩]{3,6})',
  balance: '(?<balance>[\\d٠-٩][\\d٠-٩,.٬٫]{0,31})',
  fee: '(?<fee>[\\d٠-٩][\\d٠-٩,.٬٫]{0,31})',
  to: '(?<to>[\\d٠-٩]{3,6})',
  date: '(?<date>.{1,80}?)',
};
export function compileMessageTemplate(pattern: string) {
  if (/\}\s*\{/.test(pattern)) throw new Error('Separate fields with fixed wording or punctuation');
  const used = new Set<string>();
  let source = '';
  for (const part of pattern.split(/(\{[a-z]+\})/g)) {
    if (part.startsWith('{')) {
      const key = part.slice(1, -1);
      if (!fields[key] || used.has(key)) throw new Error(`Unknown or repeated field: ${part}`);
      used.add(key);
      source += fields[key];
    } else source += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  }
  if (!used.has('amount')) throw new Error('A template must include {amount}');
  return new RegExp(`^${source}$`, 'iu');
}
export function matchMessageTemplate(
  template: MessageTemplate,
  message: string,
  receivedAt: string,
  bank: string,
) {
  if (!template.enabled || template.bank !== bank) return undefined;
  const groups = compileMessageTemplate(template.pattern).exec(message.trim())?.groups;
  if (!groups) return undefined;
  const cents = (value: string) =>
    Math.round(
      Number(
        value
          .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
          .replace(/[,٬]/g, '')
          .replace('٫', '.'),
      ) * 100,
    );
  const amount = cents(groups.amount!);
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error('Template amount must be positive');
  const positive = ['refund', 'transfer_in', 'deposit'].includes(template.kind);
  const balance = groups.balance ? cents(groups.balance) : undefined;
  const fee = groups.fee ? cents(groups.fee) : 0;
  if ((balance !== undefined && !Number.isSafeInteger(balance)) || !Number.isSafeInteger(fee))
    throw new Error('Invalid template balance or fee');
  let occurredAt = receivedAt;
  if (groups.date) {
    const date = DateTime.fromISO(groups.date.trim().replace(' ', 'T'), {
      setZone: true,
      zone: 'Asia/Riyadh',
    });
    if (!date.isValid) throw new Error('Template date is invalid; use an ISO date');
    occurredAt = date.toISO()!;
  }
  return {
    bank,
    kind: template.kind as TxKind,
    accountAlias: groups.suffix?.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632)),
    amountCents: positive
      ? amount
      : -(
          amount + (template.kind === 'transfer_out' || template.kind === 'card_payment' ? fee : 0)
        ),
    principalCents: ['transfer_in', 'transfer_out', 'card_payment'].includes(template.kind)
      ? positive
        ? amount
        : -amount
      : undefined,
    feeCents: fee,
    payee: groups.merchant ?? template.name,
    occurredAt,
    balanceCents: balance,
    transferCounterpartyAlias: groups.to?.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632)),
    note: `Template: ${template.name}`,
  };
}
