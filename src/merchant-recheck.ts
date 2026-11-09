import type { EventStore, MerchantMapping, StoredEvent } from './db.js';
import { merchantKey, merchantReviewReason } from './merchant-identity.js';
import { parseSms, PARSER_REVISION } from './parser.js';
import { resolveAccount } from './routing.js';
import type { ParsedTransaction, ResolvedConfig, SmsInput } from './types.js';

export interface MerchantRecheckResult {
  checked: number;
  repaired: number;
  needsReview: number;
  unavailable: number;
}
interface Evidence {
  eventId: string;
  status: StoredEvent['status'];
  merchant?: string;
  reason?: string;
}
interface Proposal {
  accountId: string;
  originalKey: string;
  evidence: Evidence[];
  needsRepair: boolean;
}

/** Repair identity keys only. Parsed events remain immutable so legacy import IDs still resolve. */
export function recheckMerchants(store: EventStore, config: ResolvedConfig): MerchantRecheckResult {
  const result: MerchantRecheckResult = { checked: 0, repaired: 0, needsReview: 0, unavailable: 0 };
  const events = store.db
    .prepare(
      "SELECT * FROM events WHERE payload IS NOT NULL AND parsed IS NOT NULL AND status IN ('imported','imported_review')",
    )
    .all() as StoredEvent[];
  const proposals = new Map<string, Proposal>();
  const needsReview = new Set<string>();
  const hasOverrides = Boolean(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='console_overrides'")
      .get(),
  );
  for (const event of events) {
    const original = JSON.parse(event.parsed!) as ParsedTransaction;
    if (original.bank !== 'alrajhi' || !['purchase', 'refund'].includes(original.kind)) continue;
    const input = JSON.parse(event.payload!) as SmsInput;
    const overrideRow = hasOverrides
      ? (store.db.prepare('SELECT value FROM console_overrides WHERE event_id=?').get(event.id) as
          { value: string } | undefined)
      : undefined;
    const override = overrideRow
      ? (JSON.parse(overrideRow.value) as { accountId: string; merchant?: string })
      : undefined;
    let accountId = override?.accountId;
    if (!accountId) {
      const observed = store.db
        .prepare(
          `SELECT account_id FROM local_mapping_observations WHERE source_ref IN (?,?)
        UNION SELECT account_id FROM actual_mapping_observations WHERE actual_transaction_id=?`,
        )
        .all(event.id, `console-review:${event.id}`, event.actual_transaction_id) as {
        account_id: string;
      }[];
      const ids = [...new Set(observed.map((row) => row.account_id))];
      if (ids.length === 1) accountId = ids[0];
      else if (ids.length > 1) continue;
      else {
        try {
          accountId = resolveAccount(config.accounts, original)?.id;
        } catch {
          continue;
        }
      }
    }
    if (
      !accountId ||
      !config.accounts.some(
        (account) => account.id === accountId && account.match.bank === 'alrajhi',
      )
    )
      continue;
    result.checked++;
    const parsed = parseSms(
      input.message,
      input.receivedAt,
      config.banks,
      input.sender,
      config.parsing,
    );
    const merchant =
      parsed.type === 'transaction' &&
      parsed.transaction.bank === 'alrajhi' &&
      parsed.transaction.kind === original.kind
        ? parsed.transaction.payee
        : undefined;
    const reason =
      merchant === undefined
        ? 'Original SMS could not be reparsed safely'
        : merchantReviewReason(merchant);
    const observedKeys = store.db
      .prepare(
        'SELECT merchant_key FROM local_mapping_observations WHERE source_ref IN (?,?) AND account_id=?',
      )
      .all(event.id, `console-review:${event.id}`, accountId) as { merchant_key: string }[];
    const manuallyEdited =
      Boolean(override) ||
      store.enrichmentAttempts(event.id).some((attempt) => attempt.status === 'user_actual_update');
    const keys = new Set(
      [override?.merchant ?? original.payee, ...observedKeys.map((row) => row.merchant_key)]
        .filter((name) => name && (!manuallyEdited || merchantReviewReason(name)))
        .map(merchantKey),
    );
    for (const originalKey of keys) {
      const key = JSON.stringify([accountId, originalKey]);
      const proposal = proposals.get(key) ?? {
        accountId,
        originalKey,
        evidence: [],
        needsRepair: false,
      };
      proposal.needsRepair ||=
        Boolean(merchantReviewReason(originalKey)) ||
        Boolean(merchant && merchantKey(merchant) !== originalKey);
      proposal.evidence.push({
        eventId: event.id,
        status: event.status,
        merchant: reason ? undefined : merchant,
        reason,
      });
      proposals.set(key, proposal);
    }
  }
  store.db.transaction(() => {
    const now = new Date().toISOString();
    for (const proposal of proposals.values()) {
      if (!proposal.needsRepair) continue;
      const targets = new Map(
        proposal.evidence
          .filter((e) => e.merchant)
          .map((e) => [merchantKey(e.merchant!), e.merchant!]),
      );
      const [key, merchant] = targets.size === 1 ? [...targets][0]! : [null, null];
      const reason =
        targets.size > 1
          ? 'Original description matches multiple merchants'
          : targets.size === 0
            ? 'Original SMS could not be reparsed safely'
            : null;
      // Any failed parse for the same old key makes the group uncertain.
      const uncertain = proposal.evidence.some((e) => e.reason) || Boolean(reason);
      const merchantKeyValue = uncertain ? null : key;
      const merchantValue = uncertain ? null : merchant;
      const reviewReason = reason ?? (uncertain ? 'Some original messages need review' : null);
      if (uncertain) needsReview.add(JSON.stringify([proposal.accountId, proposal.originalKey]));
      else result.repaired++;
      const previous = store.merchantRepair(proposal.accountId, proposal.originalKey);
      if (
        previous?.merchant_key === merchantKeyValue &&
        previous?.merchant === merchantValue &&
        previous?.reason === reviewReason
      )
        continue;
      const originals = store.db
        .prepare('SELECT * FROM merchant_mappings WHERE account_id=? AND merchant_key=?')
        .all(proposal.accountId, proposal.originalKey) as MerchantMapping[];
      store.db
        .prepare(
          `INSERT INTO merchant_key_repairs(account_id,original_key,merchant_key,merchant,reason,evidence,original_mappings,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,original_key) DO UPDATE SET merchant_key=excluded.merchant_key,merchant=excluded.merchant,reason=excluded.reason,evidence=excluded.evidence,updated_at=excluded.updated_at`,
        )
        .run(
          proposal.accountId,
          proposal.originalKey,
          merchantKeyValue,
          merchantValue,
          reviewReason,
          JSON.stringify({ parserRevision: PARSER_REVISION, messages: proposal.evidence }),
          JSON.stringify(originals),
          now,
        );
      // Old Actual observations may be unconfirmed service imports. Keep their
      // suggestions visible even when the next history refresh removes that evidence.
      if (merchantKeyValue && merchantValue)
        for (const original of originals.filter((mapping) => mapping.source === 'actual'))
          store.putLocalMapping({
            account_id: proposal.accountId,
            merchant_key: merchantKeyValue,
            payee: merchantReviewReason(original.payee) ? merchantValue : original.payee,
            category_id: original.category_id,
            source: 'ai',
            source_ref: `merchant-recheck:${proposal.accountId}:${proposal.originalKey}`,
            decision_at: original.decision_at,
          });
      // Retain original observations; rebuilding applies the evidence-backed key repair.
      for (const evidence of proposal.evidence)
        store.db
          .prepare(
            'INSERT INTO event_history(event_id,from_status,to_status,details,created_at) VALUES(?,?,?,?,?)',
          )
          .run(
            evidence.eventId,
            evidence.status,
            evidence.status,
            JSON.stringify({
              merchantRecheck: {
                originalKey: proposal.originalKey,
                merchantKey: merchantKeyValue,
                merchant: merchantValue,
                reason: reviewReason,
                parserRevision: PARSER_REVISION,
              },
            }),
            now,
          );
    }
    store.rebuildMerchantMappings();
    const mappings = store.db.prepare('SELECT * FROM merchant_mappings').all() as MerchantMapping[];
    const alrajhiIds = new Set(
      config.accounts
        .filter((account) => account.match.bank === 'alrajhi')
        .map((account) => account.id),
    );
    for (const mapping of mappings) {
      if (!alrajhiIds.has(mapping.account_id)) continue;
      if (mapping.review_reason)
        needsReview.add(JSON.stringify([mapping.account_id, mapping.merchant_key]));
      if (
        merchantReviewReason(mapping.merchant_key) &&
        !store.merchantRepair(mapping.account_id, mapping.merchant_key)
      )
        result.unavailable++;
    }
  })();
  result.needsReview = needsReview.size;
  return result;
}
