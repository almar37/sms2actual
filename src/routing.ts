import type { Bank, ParsedTransaction, ResolvedAccount } from './types.js';

export function resolveAccount(
  accounts: ResolvedAccount[],
  transaction: Pick<ParsedTransaction, 'bank' | 'kind' | 'accountAlias' | 'balanceCents'>,
): ResolvedAccount | undefined {
  const matches = accounts.filter((account) => {
    const { accountSuffixes, bank, hasBalance, transactionKinds } = account.match;
    return (
      bank === transaction.bank &&
      (!accountSuffixes ||
        (transaction.accountAlias !== undefined &&
          accountSuffixes.includes(transaction.accountAlias))) &&
      (!transactionKinds || transactionKinds.includes(transaction.kind)) &&
      (hasBalance === undefined || hasBalance === (transaction.balanceCents !== undefined))
    );
  });
  return oneAccount(matches, 'Ambiguous account route');
}

function oneAccount(matches: ResolvedAccount[], message: string): ResolvedAccount | undefined {
  const unique = [...new Map(matches.map((account) => [account.key, account])).values()];
  if (unique.length > 1) throw new Error(message);
  return unique[0];
}

/**
 * Resolves a recipient identifier independently of the sender bank. Account
 * suffixes remain valid transfer identifiers; `transferIdentifiers` add
 * destination-only identifiers without making them normal SMS routing
 * conditions.
 */
export function resolveTransferAccount(
  accounts: ResolvedAccount[],
  identifier: string,
): ResolvedAccount | undefined {
  const matches = accounts.filter((account) =>
    [account.match.accountSuffixes, account.match.transferIdentifiers].some((identifiers) =>
      identifiers?.includes(identifier),
    ),
  );
  return oneAccount(matches, `Ambiguous transfer account identifier: ${identifier}`);
}

/** Resolves a destination from a biller's identifier only. */
export function resolveBillPaymentAccount(
  accounts: ResolvedAccount[],
  identifier: string,
): ResolvedAccount | undefined {
  const matches = accounts.filter((account) =>
    account.match.billPaymentIdentifiers?.includes(identifier),
  );
  return oneAccount(matches, `Ambiguous bill payment account identifier: ${identifier}`);
}

/** @deprecated Use resolveTransferAccount for cross-bank transfer lookup. */
export function resolveAccountBySuffix(
  accounts: ResolvedAccount[],
  bank: Bank,
  suffix: string,
): ResolvedAccount | undefined {
  return resolveTransferAccount(
    accounts.filter((account) => account.match.bank === bank),
    suffix,
  );
}

/** Shared destination routing for imports and the message details panel. */
export function resolveTransferTarget(
  accounts: ResolvedAccount[],
  tx: ParsedTransaction,
): Pick<ResolvedAccount, 'id' | 'key'> | undefined {
  if (tx.explicitTransferAccountId)
    return (
      accounts.find((a) => a.id === tx.explicitTransferAccountId) ?? {
        id: tx.explicitTransferAccountId,
        key: tx.explicitTransferAccountId,
      }
    );
  if (tx.billPaymentIdentifier)
    return resolveBillPaymentAccount(accounts, tx.billPaymentIdentifier);
  if (tx.transferCounterpartyAlias)
    return resolveTransferAccount(accounts, tx.transferCounterpartyAlias);
  if (tx.kind === 'transfer_in' && tx.cardPaymentReceived && tx.assumedFundingAccountId)
    return (
      accounts.find((account) => account.id === tx.assumedFundingAccountId) ?? {
        key: tx.assumedFundingAccountId,
        id: tx.assumedFundingAccountId,
      }
    );
  return undefined;
}
