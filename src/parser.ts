import type { BankConfig, ParsedTransaction, TxKind } from './types.js';
import type { ParserConfig } from './parsing/config.js';
import {
  createExtractors,
  extractDisplayName,
  extractNumericReference,
  normalizeText,
} from './parsing/extractors.js';
import { resolveSmsSource } from './sms-source.js';

export { normalizeText } from './parsing/extractors.js';

/** Increment when a parser release should re-evaluate retained parser outcomes. */
export const PARSER_REVISION = 15;

export type ParserReason =
  | 'otp_or_login'
  | 'declined_or_insufficient_funds'
  | 'duplicate_fee_notification'
  | 'unsupported_sender'
  | 'unrecognized_template'
  | 'malformed_notification'
  | 'ambiguous_template';

export type ParseResult =
  | { type: 'transaction'; transaction: ParsedTransaction }
  | { type: 'ignored'; reason: ParserReason }
  | { type: 'needs_review'; reason: ParserReason };

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function classify<T>(
  text: string,
  rules: readonly { value: T; patterns: readonly RegExp[] }[],
): T | undefined {
  return rules.find((rule) => matches(text, rule.patterns))?.value;
}

function accountReferences(text: string, kind: TxKind, e: ReturnType<typeof createExtractors>) {
  const { extractLabelledValue, extractAccountAlias, extractAccountAliases } = e;
  const fromValue = extractLabelledValue(text, 'from');
  const toValue = extractLabelledValue(text, 'to');
  const ibanValue = extractLabelledValue(text, 'iban');
  const genericAlias = extractAccountAlias(text);
  const aliases = extractAccountAliases(text);
  const outgoing = kind === 'transfer_out' || kind === 'card_payment';
  const incoming = kind === 'transfer_in';
  const sourceAccountAlias = extractNumericReference(fromValue);
  const destinationAccountAlias = extractNumericReference(toValue);
  const accountAlias = outgoing
    ? (sourceAccountAlias ?? genericAlias)
    : incoming
      ? (destinationAccountAlias ?? genericAlias)
      : (sourceAccountAlias ?? genericAlias);

  // An explicit IBAN is a routing identifier, never a beneficiary name.
  const transferCounterpartyAlias = outgoing
    ? (extractNumericReference(ibanValue) ??
      destinationAccountAlias ??
      aliases.find((alias) => alias !== accountAlias))
    : incoming
      ? sourceAccountAlias
      : undefined;

  return {
    accountAlias,
    transferCounterpartyAlias,
    beneficiaryValue: extractLabelledValue(text, 'beneficiary'),
    fromValue,
    toValue,
    outgoing,
    incoming,
  };
}

export function parseSms(
  raw: string,
  receivedAt: string,
  banks: readonly BankConfig[],
  sender = '',
  config: ParserConfig,
): ParseResult {
  const text = normalizeText(raw);
  const ignoredReason = classify(text, config.shared.ignored);
  if (ignoredReason) return { type: 'ignored', reason: ignoredReason };

  const source = resolveSmsSource(sender, text, banks);
  if (source.type === 'unsupported')
    return { type: source.disposition, reason: 'unsupported_sender' };
  const { bank } = source;

  const templates = config.templates.filter(
    (t) => banks.find((b) => b.id === bank)?.templates?.includes(t.id) && matches(text, t.match),
  );
  if (templates.length > 1) return { type: 'needs_review', reason: 'ambiguous_template' };
  const template = templates[0];
  const e = createExtractors({ ...config.shared.fields, ...template?.fields });
  const {
    extractBiller,
    extractAmount,
    extractSarEquivalent,
    extractForeignAmount,
    extractMerchant,
    extractDate,
  } = e;
  for (const field of template?.required ?? []) {
    const raw = e.value(text, field);
    const valid =
      field === 'foreign'
        ? e.extractForeignAmount(text) !== undefined
        : field === 'accountAliases'
          ? e.extractAccountAliases(text).length > 0
          : field === 'cashback'
            ? e.isCashback(text)
            : ['total', 'principal', 'fee', 'balance', 'sarEquivalent'].includes(field)
              ? extractAmount(text, field) !== undefined
              : field === 'date'
                ? raw !== undefined && e.isValidDate(text)
                : raw !== undefined && raw !== '';
    if (!valid) return { type: 'needs_review', reason: 'malformed_notification' };
  }
  const kindRule = config.shared.kinds.find((rule) => matches(text, rule.patterns));
  const kind = template?.kind ?? kindRule?.value;
  if (!kind) return { type: 'needs_review', reason: 'unrecognized_template' };

  const biller = extractBiller(text);
  const references = accountReferences(text, kind, e);
  const total = extractAmount(text, 'total');
  const principal = extractAmount(text, 'principal') ?? extractSarEquivalent(text);
  const fee = extractAmount(text, 'fee') ?? 0;
  const foreign = extractForeignAmount(text);
  const sar = total ?? (principal === undefined ? undefined : principal + fee);
  if (sar === undefined && !foreign)
    return { type: 'needs_review', reason: 'malformed_notification' };

  const positive = kind === 'refund' || kind === 'deposit' || references.incoming;
  const merchant =
    kind.includes('transfer') || kind === 'card_payment'
      ? undefined
      : (biller.name ?? extractMerchant(text));
  const transferName =
    kind.includes('transfer') || kind === 'card_payment'
      ? (extractDisplayName(references.beneficiaryValue) ??
        extractDisplayName(references.outgoing ? references.toValue : references.fromValue))
      : undefined;
  const payee =
    merchant ??
    transferName ??
    (kind.includes('transfer') || kind === 'card_payment'
      ? 'Bank transfer'
      : kind === 'refund' && e.isCashback(text)
        ? 'Card cashback'
        : kind === 'withdrawal'
          ? 'ATM withdrawal'
          : 'Unknown merchant');
  const balance = extractAmount(text, 'balance');

  return {
    type: 'transaction',
    transaction: {
      bank,
      kind,
      accountAlias: references.accountAlias,
      amountCents: sar === undefined ? null : positive ? sar : -sar,
      principalCents: principal === undefined ? undefined : positive ? principal : -principal,
      feeCents: fee,
      payee,
      occurredAt: extractDate(text, receivedAt),
      balanceCents: balance,
      foreign,
      note: `Parsed ${bank} ${kind}`,
      transferCounterpartyAlias: references.transferCounterpartyAlias,
      billPaymentIdentifier: biller.identifier,
      ...((template ?? kindRule)?.cardPaymentReceived ? { cardPaymentReceived: true } : {}),
    },
  };
}

/** Partial suggestions for the review form only. Never used to authorize an import. */
export function extractReviewDraft(
  raw: string,
  receivedAt: string,
  banks: readonly BankConfig[],
  sender: string,
  config: ParserConfig,
): Partial<ParsedTransaction> {
  const text = normalizeText(raw);
  if (classify(text, config.shared.ignored)) return {};
  const source = resolveSmsSource(
    sender,
    text,
    banks.map((bank) => ({ ...bank, disposition: 'import' })),
  );
  const bank = source.type === 'supported' ? source.bank : undefined;
  const templates = config.templates.filter(
    (t) =>
      bank && banks.find((b) => b.id === bank)?.templates?.includes(t.id) && matches(text, t.match),
  );
  // Conflicting templates cannot safely supply template-specific hints.
  const template = templates.length === 1 ? templates[0] : undefined;
  const e = createExtractors({ ...config.shared.fields, ...template?.fields });
  const fallback = createExtractors({ ...config.shared.fields, ...config.shared.review?.fields });
  const kind =
    template?.kind ??
    classify(text, config.shared.kinds) ??
    classify(text, config.shared.review?.kinds ?? []);
  const references = accountReferences(text, kind ?? 'purchase', e);
  const reviewReferences = accountReferences(text, kind ?? 'purchase', fallback);
  const positive = ['refund', 'deposit', 'transfer_in'].includes(kind ?? '');
  const fee = e.extractAmount(text, 'fee');
  const total = e.extractAmount(text, 'total');
  const principal =
    e.extractAmount(text, 'principal') ??
    e.extractSarEquivalent(text) ??
    fallback.extractAmount(text, 'principal') ??
    (total !== undefined ? total - (fee ?? 0) : undefined);
  const safeMoney = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const amount = safeMoney(principal);
  const sign = positive ? 1 : -1;
  const transfer = ['transfer_in', 'transfer_out', 'card_payment'].includes(kind ?? '');
  const payee = transfer
    ? (extractDisplayName(
        references.beneficiaryValue ?? (positive ? references.fromValue : references.toValue),
      ) ??
      extractDisplayName(
        reviewReferences.beneficiaryValue ??
          (positive ? reviewReferences.fromValue : reviewReferences.toValue),
      ))
    : (e.extractBiller(text).name ?? e.extractMerchant(text));
  return {
    bank,
    kind,
    accountAlias: references.accountAlias ?? reviewReferences.accountAlias,
    principalCents: amount === undefined ? undefined : sign * amount,
    feeCents: safeMoney(fee),
    payee,
    occurredAt: e.value(text, 'date')
      ? e.extractDate(text, receivedAt)
      : fallback.extractDate(text, receivedAt),
  };
}
