<script lang="ts">
  import { onMount } from 'svelte';
  import { api, money, when } from './api.js';
  import Icon from './Icon.svelte';
  let {
    catalog,
    navigate,
    notify,
    refresh,
  }: {
    catalog: any;
    navigate: (page: string) => void;
    notify: (message: string) => void;
    refresh: () => Promise<void>;
  } = $props();
  let data = $state<any>(null),
    busy = $state(false),
    error = $state('');
  const counts = $derived(
    Object.fromEntries((data?.counts ?? []).map((c: any) => [c.status, c.count])) as Record<
      string,
      number
    >,
  );
  const total = $derived(Object.values(counts).reduce((a, b) => a + b, 0));
  const imported = $derived((counts.imported ?? 0) + (counts.imported_review ?? 0));
  const review = $derived(
    (counts.needs_review ?? 0) + (counts.imported_review ?? 0) + (counts.failed ?? 0),
  );
  const holdings = $derived(
    (data?.accounts ?? [])
      .filter((a: any) => a.balanceCents != null)
      .reduce((sum: number, a: any) => sum + a.balanceCents, 0),
  );
  const date = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  async function load(manual = false) {
    if (busy) return;
    busy = true;
    try {
      const summary = await api('/api/console/summary');
      await refresh();
      data = summary;
      error = '';
      if (manual) notify('Budget refreshed from Actual');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void load();
    const interval = setInterval(() => void load(), 30000);
    return () => clearInterval(interval);
  });
  function accountType(id: string) {
    return catalog.settings.accounts.find((a: any) => a.id === id)?.type ?? 'Actual account';
  }
</script>

<div class="page-heading">
  <div>
    <div class="eyebrow">THE BIG PICTURE</div>
    <h1>Everything, in sync<span class="green">.</span></h1>
    <p>Your bank messages, turned into a budget that keeps up.</p>
  </div>
  <div class="button-row">
    {#if catalog.actualUrl}<a
        class="button"
        href={catalog.actualUrl}
        target="_blank"
        rel="noreferrer">Open Actual<Icon name="external" size={15} /></a
      >{/if}<button disabled={busy} onclick={() => void load(true)}
      ><Icon name="refresh" size={16} />{busy ? 'Refreshing…' : 'Refresh'}</button
    >
  </div>
</div>
<div class="welcome-strip">
  <div>
    <span class="connection-dot"></span><strong>Your money has a new routine.</strong><span
      >SMS → sms2actual → Actual Budget</span
    >
  </div>
  <span class="muted">{date}</span>
</div>
{#if error}<div class="error" role="alert">{error}</div>{/if}
<div class="stats-grid">
  <div class="stat-card">
    <span>Total holdings<Icon name="accounts" size={19} /></span><strong
      >{data ? money(holdings) : '—'}</strong
    ><small>Across all open Actual accounts</small>
  </div>
  <div class="stat-card">
    <span>Messages received<Icon name="sms" size={19} /></span><strong
      >{data ? total.toLocaleString() : '—'}</strong
    ><small>Safely stored in your inbox</small>
  </div>
  <div class="stat-card">
    <span>Transactions imported<Icon name="check" size={19} /></span><strong
      >{data ? imported.toLocaleString() : '—'}</strong
    ><small
      ><span class="green">{total ? Math.round((imported / total) * 100) : 0}%</span> of received messages</small
    >
  </div>
  <button class="stat-card review-stat" onclick={() => navigate('sms')}
    ><span>Needs your attention<Icon name="filter" size={19} /></span><strong
      >{data ? review : '—'}<Icon name="arrow" size={24} /></strong
    ><small>{review ? 'A quick review goes a long way' : 'You’re all caught up'}</small></button
  >
</div>
<div class="section-heading">
  <div>
    <h2>Your accounts <span class="count">{data?.accounts?.length ?? 0}</span></h2>
    <p>A small window into your bigger picture.</p>
  </div>
  <button class="text-button" onclick={() => navigate('accounts')}
    >Manage accounts<Icon name="arrow" size={16} /></button
  >
</div>
<div class="holdings-grid">
  {#each data?.accounts ?? [] as account, i (account.id)}<div
      class="holding-card"
      class:credit={accountType(account.id) === 'credit'}
    >
      <div class="holding-top">
        <span class="account-icon"><Icon name="accounts" size={21} /></span><span class="tag"
          >{accountType(account.id)}</span
        ><span class="account-index">0{i + 1}</span>
      </div>
      <h3>{account.name}</h3>
      <strong>{money(account.balanceCents)}</strong>
      <div class="holding-bottom">
        <span
          >{catalog.settings.accounts
            .find((a: any) => a.id === account.id)
            ?.match.accountSuffixes?.map((s: string) => '•• ' + s)
            .join(' · ') ?? 'Connected to Actual'}</span
        ><Icon name="check" size={15} />
      </div>
      {#if accountType(account.id) === 'credit'}{@const config = catalog.settings.accounts.find(
          (a: any) => a.id === account.id,
        )}{@const limit =
          config?.creditLimitCents ?? catalog.limits?.[account.id]?.cents}{#if limit}<div
            class="credit-meter"
          >
            <div
              style:width={Math.min(
                100,
                (Math.abs(Math.min(0, account.balanceCents ?? 0)) / limit) * 100,
              ) + '%'}
            ></div>
          </div>
          <small>{money(limit)} credit limit</small>{/if}{/if}
    </div>{/each}{#if data && !data.accounts.length}<div class="empty compact">
      <p>No open accounts in Actual yet.</p>
    </div>{/if}
</div>
<div class="dashboard-bottom">
  <section class="panel transactions-panel">
    <div class="panel-heading">
      <div>
        <h2>Latest transactions</h2>
        <p>Your last ten, across all accounts.</p>
      </div>
      <span class="tag">All accounts</span>
    </div>
    <div class="table-scroll">
      <table>
        <thead
          ><tr
            ><th>Payee / transaction</th><th>Account</th><th>Date</th><th class="number">Amount</th
            ></tr
          ></thead
        ><tbody
          >{#each data?.transactions ?? [] as tx (tx.id)}<tr
              ><td
                ><div class="payee-cell">
                  <span class="merchant-avatar"
                    >{(tx.payeeName ?? tx.importedPayee ?? '?').slice(0, 1).toUpperCase()}</span
                  >
                  <div>
                    <strong>{tx.payeeName ?? tx.importedPayee ?? 'Unspecified payee'}</strong><small
                      >{catalog.categories.find((c: any) => c.id === tx.categoryId)?.name ??
                        (tx.transferId ? 'Transfer' : 'Uncategorized')}</small
                    ><small class="mobile-transaction-detail">{tx.accountName} · {tx.date}</small>
                  </div>
                </div></td
              ><td>{tx.accountName}</td><td class="muted">{tx.date}</td><td
                class="number"
                class:positive={(tx.amount ?? 0) > 0}>{money(tx.amount)}</td
              ></tr
            >{/each}</tbody
        >
      </table>
    </div>
    {#if !data?.transactions?.length}<div class="empty compact">
        <Icon name="accounts" size={28} />
        <h3>{data ? 'Your next chapter starts here.' : 'Loading transactions…'}</h3>
        <p>
          {data
            ? 'Transactions from Actual will appear here.'
            : 'Fetching the latest from your budget.'}
        </p>
      </div>{/if}
  </section>
  <aside class="dashboard-aside">
    <section class="connection-card">
      <div class="section-kicker"><Icon name="tasker" size={19} /> TASKER CONNECTION</div>
      <div class="sync-orbit">
        <Icon name="tasker" size={30} /><span><Icon name="check" size={12} /></span>
      </div>
      <h3>{data?.lastTaskerSync ? 'Your phone is connected.' : 'Let’s connect your phone.'}</h3>
      <p>
        {data?.lastTaskerSync
          ? 'Your messages have a direct line to your budget.'
          : 'One Tasker project. A much simpler routine.'}
      </p>
      <div class="last-sync">
        <span>Last Tasker contact</span><strong>{when(data?.lastTaskerSync)}</strong>
      </div>
      <button class="wide" onclick={() => navigate('tasker')}
        >{data?.lastTaskerSync ? 'Connection settings' : 'Set up Tasker'}<Icon
          name="arrow"
          size={16}
        /></button
      >
    </section>
    <section class="tip-card">
      <span class="tip-icon">✳</span>
      <h3>Teach it once.<br />Let it remember.</h3>
      <p>Turn a bank message into a reusable template. Future messages find their own way.</p>
      <button class="text-button" onclick={() => navigate('templates')}
        >Explore templates<Icon name="arrow" size={16} /></button
      >
    </section>
  </aside>
</div>
