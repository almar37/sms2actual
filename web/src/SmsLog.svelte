<script lang="ts">
  import { modal } from './modal.js';
  import { onMount } from 'svelte';
  import { api, money, when, actions, localDateInput, localDateIso } from './api.js';
  import Icon from './Icon.svelte';
  let {
    catalog,
    notify,
    navigate,
  }: { catalog: any; notify: (message: string) => void; navigate: (page: string) => void } =
    $props();
  let data = $state<any>(null),
    search = $state(''),
    status = $state('all'),
    sort = $state('created_at'),
    direction = $state('desc'),
    page = $state(1),
    error = $state(''),
    busy = $state(false),
    selected = $state<any>(null),
    form = $state<any>({});
  let searchTimer: ReturnType<typeof setTimeout>;
  const transfer = $derived(['transfer_in', 'transfer_out', 'card_payment'].includes(form.kind));
  const imported = $derived(
    selected &&
      (selected.status === 'imported' ||
        selected.status === 'imported_review' ||
        selected.actual_transaction_id),
  );
  const statuses = [
    'all',
    'needs_review',
    'failed',
    'imported',
    'imported_review',
    'queued',
    'processing',
    'ignored',
  ];
  const label = (s: string) => s.replaceAll('_', ' ');
  async function load() {
    busy = true;
    try {
      data = await api(
        '/api/console/events?' +
          new URLSearchParams({ search, status, sort, direction, page: String(page) }),
      );
      error = '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  function filter() {
    page = 1;
    void load();
  }
  function searchChanged() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(filter, 250);
  }
  function order(column: string) {
    direction = sort === column && direction === 'desc' ? 'asc' : 'desc';
    sort = column;
    void load();
  }
  async function open(id: string) {
    try {
      selected = await api('/api/console/events/' + encodeURIComponent(id));
      const tx = selected.parsed;
      form = {
        kind: tx?.kind ?? 'purchase',
        accountId:
          catalog.settings.accounts.find(
            (a: any) =>
              a.match.bank === tx?.bank &&
              (!tx?.accountAlias ||
                a.match.accountSuffixes?.includes(tx.accountAlias) ||
                a.cards.some((c: any) => c.suffix === tx.accountAlias)),
          )?.id ??
          catalog.settings.accounts[0]?.id ??
          '',
        amount: Math.abs(tx?.principalCents ?? tx?.amountCents ?? 0) / 100,
        fee: (tx?.feeCents ?? 0) / 100,
        payee: tx?.payee ?? '',
        categoryId: selected.suggestion?.categoryId ?? '',
        targetAccountId: selected.targetAccountId ?? '',
        date: localDateInput(tx?.occurredAt ?? selected.input.receivedAt),
      };
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    try {
      await api('/api/console/events/' + encodeURIComponent(selected.id) + '/action', {
        kind: form.kind,
        accountId: form.accountId,
        amountCents: Math.round(Number(form.amount) * 100),
        feeCents: transfer ? Math.round(Number(form.fee) * 100) : 0,
        payee: form.payee,
        categoryId: !transfer && form.categoryId ? form.categoryId : undefined,
        targetAccountId: transfer && form.targetAccountId ? form.targetAccountId : undefined,
        occurredAt: localDateIso(form.date),
      });
      selected = null;
      notify('Review saved. Message queued for import.');
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      busy = false;
    }
  }
  function makeTemplate() {
    sessionStorage.setItem(
      'sms2actual-template-draft',
      JSON.stringify({
        message: selected.input.message,
        sender: selected.input.sender ?? '',
        kind: form.kind,
        bank: catalog.settings.accounts.find((a: any) => a.id === form.accountId)?.match.bank ?? '',
        receivedAt: selected.input.receivedAt,
        categoryId: form.categoryId,
      }),
    );
    navigate('templates');
  }
  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      clearInterval(timer);
      clearTimeout(searchTimer);
    };
  });
</script>

<div class="page-heading">
  <div>
    <span class="eyebrow">EVERY MESSAGE HAS A STORY</span>
    <h1>SMS inbox<span class="green">.</span></h1>
    <p>See what arrived, where it went, and what needs a little help.</p>
  </div>
  <button onclick={() => void load()} disabled={busy}
    ><Icon name="refresh" size={16} />Refresh</button
  >
</div>
<div class="inbox-summary">
  <span
    ><span class="connection-dot"></span>Last Tasker contact
    <strong>{when(data?.lastTaskerSync)}</strong></span
  ><span
    >{data?.total ?? 0} messages{search || status !== 'all'
      ? ' matching filters'
      : ' in your inbox'}</span
  >
</div>
{#if error}<div class="error" role="alert">{error}</div>{/if}
<section class="panel">
  <div class="table-toolbar">
    <div class="search-field">
      <Icon name="search" size={18} /><input
        aria-label="Search messages"
        placeholder="Search messages, senders, or IDs…"
        bind:value={search}
        oninput={searchChanged}
      />
    </div>
    <select aria-label="Filter by status" bind:value={status} onchange={filter}
      >{#each statuses as state (state)}<option value={state}
          >{state === 'all' ? 'All statuses' : label(state)}</option
        >{/each}</select
    >
  </div>
  <div class="table-scroll">
    <table class="sms-table">
      <thead
        ><tr
          ><th
            ><button onclick={() => order('received_at')}
              >Received {sort === 'received_at' ? (direction === 'desc' ? '↓' : '↑') : ''}</button
            ></th
          ><th
            ><button onclick={() => order('sender')}
              >Sender {sort === 'sender' ? (direction === 'desc' ? '↓' : '↑') : ''}</button
            ></th
          ><th>Message</th><th
            ><button onclick={() => order('status')}
              >Status {sort === 'status' ? (direction === 'desc' ? '↓' : '↑') : ''}</button
            ></th
          ><th class="number">Amount</th><th><span class="sr-only">Review</span></th></tr
        ></thead
      ><tbody
        >{#each data?.events ?? [] as event (event.id)}<tr
            ><td class="nowrap muted">{when(event.input?.receivedAt ?? event.created_at)}</td><td
              ><strong>{event.input?.sender ?? 'Unknown sender'}</strong></td
            ><td
              ><button class="message-preview" onclick={() => void open(event.id)}
                >{event.input?.message ?? 'Message unavailable'}</button
              >{#if event.error}<small class="error-text">{event.error}</small>{/if}</td
            ><td><span class={'status status-' + event.status}>{label(event.status)}</span></td><td
              class="number"
              class:positive={(event.parsed?.amountCents ?? 0) > 0}
              >{money(event.parsed?.amountCents)}</td
            ><td
              ><button
                class="icon-button"
                aria-label={'Review message from ' + (event.input?.sender ?? 'unknown sender')}
                onclick={() => void open(event.id)}><Icon name="chevron" size={17} /></button
              ></td
            ></tr
          >{/each}</tbody
      >
    </table>
  </div>
  {#if !data?.events?.length}<div class="empty">
      <Icon name="sms" size={34} />
      <h3>
        {search || status !== 'all' ? 'No messages match your filters.' : 'Your inbox is ready.'}
      </h3>
      <p>
        {search || status !== 'all'
          ? 'Try another search or status.'
          : 'Connect Tasker to start receiving bank messages.'}
      </p>
      {#if !search && status === 'all'}<button onclick={() => navigate('tasker')}
          >Connect Tasker<Icon name="arrow" size={16} /></button
        >{/if}
    </div>{/if}
  <div class="pagination">
    <span
      >{data?.total ?? 0} messages · Page {page} of {Math.max(
        1,
        Math.ceil((data?.total ?? 0) / 50),
      )}</span
    >
    <div>
      <button
        disabled={page === 1 || busy}
        onclick={() => {
          page--;
          void load();
        }}>Previous</button
      ><button
        disabled={page * 50 >= (data?.total ?? 0) || busy}
        onclick={() => {
          page++;
          void load();
        }}>Next</button
      >
    </div>
  </div>
</section>
{#if selected}<dialog
    class="drawer"
    use:modal
    onclose={() => (selected = null)}
    aria-label="Review message"
  >
    <div class="drawer-heading">
      <div>
        <span class="eyebrow">A CLOSER LOOK</span>
        <h2>Review message</h2>
      </div>
      <button class="icon-button" aria-label="Close review" onclick={() => (selected = null)}
        ><Icon name="close" /></button
      >
    </div>
    <div class="drawer-body">
      <div class="sms-original">
        <div>
          <strong>{selected.input?.sender ?? 'Unknown sender'}</strong><small
            >{when(selected.input?.receivedAt)}</small
          >
        </div>
        <p dir="auto">{selected.input?.message}</p>
      </div>
      <div class="detail-meta">
        <span class={'status status-' + selected.status}>{label(selected.status)}</span><span
          class="muted"
          >{selected.parser_reason
            ? label(selected.parser_reason)
            : 'Parser result available below'}</span
        >
      </div>
      {#if selected.error}<div class="error">{selected.error}</div>{/if}
      {#if imported}<div class="info-box">
          This message has already reached Actual. Edit its transaction there. Save a template below
          to teach future messages.
        </div>{/if}
      <form onsubmit={submit}>
        <div class="form-grid">
          <label
            >Action<select
              bind:value={form.kind}
              onchange={(event) => {
                if (
                  !['transfer_in', 'transfer_out', 'card_payment'].includes(
                    event.currentTarget.value,
                  )
                )
                  form.fee = 0;
              }}
              >{#each actions as [value, text] (value)}<option {value}>{text}</option
                >{/each}</select
            ></label
          ><label
            >Account<select bind:value={form.accountId} required
              ><option value="" disabled>Select account</option
              >{#each catalog.settings.accounts as account (account.id)}<option value={account.id}
                  >{account.name}</option
                >{/each}</select
            ></label
          ><label
            >Amount (SAR)<input
              type="number"
              min="0.01"
              step="0.01"
              bind:value={form.amount}
              required
            /></label
          ><label
            >Fees (SAR)<input
              type="number"
              min="0"
              step="0.01"
              bind:value={form.fee}
              disabled={!transfer}
            /></label
          ><label class="full"
            >Payee / merchant<input bind:value={form.payee} maxlength="100" required /></label
          >{#if transfer}<label class="full"
              >Counterparty account<select bind:value={form.targetAccountId}
                ><option value="">External / unknown account</option
                >{#each catalog.accounts.filter((a: any) => a.id !== form.accountId) as account (account.id)}<option
                    value={account.id}>{account.name}</option
                  >{/each}</select
              ><small>An Actual account creates a linked transfer.</small></label
            >{:else}<label class="full"
              >Category<select bind:value={form.categoryId}
                ><option value="">Use merchant mapping / AI</option
                >{#each catalog.categories as category (category.id)}<option value={category.id}
                    >{category.name}</option
                  >{/each}</select
              ></label
            >{/if}<label class="full"
            >Transaction date and time<input
              type="datetime-local"
              bind:value={form.date}
              required
            /><small>Uses your device’s time zone.</small></label
          >
        </div>
        <div class="form-actions">
          <button type="button" onclick={makeTemplate}
            ><Icon name="templates" size={16} />Save as template</button
          ><button class="primary" disabled={busy || Boolean(imported)}
            >{busy ? 'Saving…' : 'Approve & import'}<Icon name="check" size={16} /></button
          >
        </div>
      </form>
      <details>
        <summary>Processing & category support history</summary
        >{#each selected.history ?? [] as entry (entry.id)}<div class="audit-entry">
            <strong>{label(entry.to_status)}</strong><small>{when(entry.created_at)}</small>
            <pre>{JSON.stringify(JSON.parse(entry.details), null, 2)}</pre>
          </div>{/each}{#each selected.enrichmentAttempts ?? [] as attempt (attempt.id)}<div
            class="audit-entry"
          >
            <strong>{label(attempt.status)}</strong><small>{when(attempt.created_at)}</small>
            <pre>{JSON.stringify(JSON.parse(attempt.details), null, 2)}</pre>
          </div>{/each}
      </details>
    </div>
  </dialog>{/if}
