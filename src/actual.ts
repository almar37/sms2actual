import { loadActualApi } from './actual-sdk.js';
import { currentBudgetDate } from './budget-date.js';
import type { ActualAdapter, ActualTransaction, ActualTransactionUpdate } from './types.js';

export class ActualApiAdapter implements ActualAdapter {
  constructor(
    private options: {
      serverURL: string;
      password: string;
      syncId: string;
      encryptionPassword?: string;
      dataDir: string;
    },
  ) {}
  async initialize() {
    const actual = await loadActualApi();
    await actual.init({
      serverURL: this.options.serverURL,
      password: this.options.password,
      dataDir: this.options.dataDir,
    });
    await actual.downloadBudget(this.options.syncId, { password: this.options.encryptionPassword });
  }
  async serverVersion() {
    const actual = await loadActualApi();
    const result = await actual.getServerVersion();
    if ('version' in result) return result.version;
    throw new Error(result.error);
  }
  async shutdown() {
    const actual = await loadActualApi();
    await actual.shutdown();
  }
  async sync() {
    const actual = await loadActualApi();
    await actual.sync();
  }
  async accounts() {
    const actual = await loadActualApi();
    return (await actual.getAccounts())
      .filter((a) => !a.closed)
      .map((a) => ({ id: a.id, name: a.name }));
  }
  async accountBalance(accountId: string, throughDate = currentBudgetDate()) {
    const actual = await loadActualApi();
    // The SDK extracts the host-local calendar day from its Date cutoff.
    // Construct that day explicitly so UTC hosts include today's Riyadh transactions.
    return actual.getAccountBalance(accountId, new Date(`${throughDate}T00:00:00`));
  }
  async categories() {
    const actual = await loadActualApi();
    const groups = await actual.getCategories();
    return groups.map((c) => ({
      id: c.id,
      name: c.name,
      groupName: (c as any).group?.name,
      isIncome: Boolean((c as any).is_income),
      hidden: Boolean((c as any).hidden),
    }));
  }
  async transactions(accountId: string, startDate: string, endDate: string, limit?: number) {
    const actual = await loadActualApi();
    const payees = new Map((await actual.getPayees()).map((payee) => [payee.id, payee]));
    const rows = limit
      ? (
          (await actual.aqlQuery(
            actual
              .q('transactions')
              .filter({ account: accountId, date: { $gte: startDate, $lte: endDate } })
              .select('*')
              .options({ splits: 'grouped' })
              .orderBy([{ date: 'desc' }, { id: 'desc' }])
              .limit(limit),
          )) as { data: Awaited<ReturnType<typeof actual.getTransactions>> }
        ).data
      : await actual.getTransactions(accountId, startDate, endDate);
    return rows.map((transaction) => ({
      id: transaction.id,
      amount: transaction.amount,
      accountId: transaction.account,
      date: transaction.date,
      payeeName: transaction.payee ? payees.get(transaction.payee)?.name : undefined,
      importedPayee: transaction.imported_payee,
      categoryId: transaction.category,
      importedId: transaction.imported_id,
      transferId: transaction.transfer_id,
      transferAccountId: transaction.payee
        ? (payees.get(transaction.payee)?.transfer_acct ?? undefined)
        : undefined,
      notes: transaction.notes ?? '',
      isSplit: Boolean(transaction.is_parent || transaction.parent_id),
    }));
  }
  async deleteTransactions(transactionIds: string[]) {
    const actual = await loadActualApi();
    await actual.batchBudgetUpdates(async () => {
      // Actual owns removal of split lines and the linked transfer side. Missing IDs are idempotent.
      for (const id of new Set(transactionIds)) await actual.deleteTransaction(id);
    });
  }
  async updatePayees(transactionIds: string[], payeeName: string) {
    if (!transactionIds.length) return;
    const actual = await loadActualApi();
    const payees = await actual.getPayees();
    const payee =
      payees.find((p) => !p.transfer_acct && p.name === payeeName)?.id ??
      (await actual.createPayee({ name: payeeName }));
    await actual.batchBudgetUpdates(async () => {
      for (const id of transactionIds) await actual.updateTransaction(id, { payee });
    });
  }
  async updateTransactions(updates: ActualTransactionUpdate[]) {
    const actual = await loadActualApi();
    const payees = await actual.getPayees();
    // Resolve every payee before changing transactions. Never rename a shared payee.
    const resolved: { update: ActualTransactionUpdate; payee: string }[] = [];
    for (const update of updates) {
      let payee = update.transferAccountId
        ? payees.find((p) => p.transfer_acct === update.transferAccountId)?.id
        : payees.find((p) => !p.transfer_acct && p.name === update.payeeName)?.id;
      if (update.transferAccountId && !payee)
        throw new Error('Destination account has no Actual transfer payee');
      if (!payee) {
        payee = await actual.createPayee({ name: update.payeeName });
        payees.push({ id: payee, name: update.payeeName, transfer_acct: undefined });
      }
      resolved.push({ update, payee });
    }
    await actual.batchBudgetUpdates(async () => {
      for (const { update, payee } of resolved) {
        await actual.updateTransaction(update.id, {
          account: update.accountId,
          date: update.date,
          amount: update.amount,
          payee,
          category: update.transferAccountId ? null : update.categoryId,
          notes: update.notes,
        } as any);
      }
    });
  }
  async transferPayee(accountId: string) {
    const actual = await loadActualApi();
    const payee = (await actual.getPayees()).find((p) => p.transfer_acct === accountId);
    if (!payee) throw new Error(`No Actual transfer payee for account ${accountId}`);
    return payee.id;
  }
  async importTransactions(accountId: string, transactions: ActualTransaction[]) {
    const actual = await loadActualApi();
    return actual.importTransactions(accountId, transactions as any, { defaultCleared: true });
  }
}
