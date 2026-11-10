<script lang="ts">
  import { modal } from './modal.js';
  import { onMount } from 'svelte';
  import { api, money, when, actions, localDateInput, localDateIso } from './api.js';
  import Icon from './Icon.svelte';
  import LearnFormat from './LearnFormat.svelte';
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
  let deletion = $state<any>(null),
    deletionPlan = $state<any>(null),
    deletionLoading = $state(false),
    deletionBusy = $state(false),
    deletionError = $state(''),
    deleteChoice = $state('keep');
  let deleteDialog = $state<HTMLDialogElement>();
  let deletionRequest = 0;
  async function prepareDelete(event?: any) {
    if (deletionBusy) return;
    if (event) deletion = event;
    const request = ++deletionRequest,
      id = deletion.id;
    deletionPlan = null;
    deletionError = '';
    deleteChoice = 'keep';
    deletionLoading = true;
    try {
      const plan = await api('/api/console/events/' + encodeURIComponent(id) + '/deletion');
      if (request === deletionRequest && deletion?.id === id) deletionPlan = plan;
    } catch (e) {
      if (request === deletionRequest) deletionError = (e as Error).message;
    } finally {
      if (request === deletionRequest) deletionLoading = false;
    }
  }
  async function deleteMessage(event: SubmitEvent) {
    event.preventDefault();
    if (!deletionPlan || deletionBusy) return;
    deletionBusy = true;
    deletionError = '';
    const id = deletion.id;
    try {
      const result = await api(
        '/api/console/events/' + encodeURIComponent(id),
        {
          confirmation: 'DELETE',
          deleteActual: deleteChoice === 'delete',
          eventRevision: deletionPlan.eventRevision,
          actualRevision: deleteChoice === 'delete' ? deletionPlan.revision : undefined,
        },
        'DELETE',
      );
      if (selected?.id === id) selected = null;
      deletionBusy = false;
      deletion = null;
      notify(
        result.deletedActual
          ? 'SMS and linked Actual entries deleted.'
          : 'SMS deleted. Actual transactions kept.',
      );
      if (data?.events?.length === 1 && page > 1) page--;
      await load();
    } catch (e) {
      deletionError = (e as Error).message;
    } finally {
      deletionBusy = false;
    }
  }
  let searchTimer: ReturnType<typeof setTimeout>;
  const transfer = $derived(['transfer_in', 'transfer_out', 'card_payment'].includes(form.kind));
  const linkedTransfer = $derived(transfer && Boolean(form.targetAccountId));
  const imported = $derived(
    selected &&
      (selected.status === 'imported' ||
        selected.status === 'imported_review' ||
        selected.actual_transaction_id),
  );
  const statuses = [
    'all',
    'needs_review',
    'unsupported_format',
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
      const tx = selected.parsed ?? selected.reviewDraft;
      form = {
        kind: tx?.kind ?? '',
        accountId: selected.sourceAccountId ?? '',
        amount:
          tx?.principalCents != null || tx?.amountCents != null
            ? Math.abs(tx.principalCents ?? tx.amountCents) / 100
            : '',
        fee: (tx?.feeCents ?? 0) / 100,
        payee: tx?.payee ?? '',
        categoryId: selected.categoryId ?? '',
        targetAccountId: selected.targetAccountId ?? '',
        date: localDateInput(tx?.occurredAt ?? selected.input.receivedAt),
        notes: selected.notes,
      };
      if (selected.actualSync?.form) {
        const current = selected.actualSync.form;
        form = {
          ...form,
          kind: current.kind,
          accountId: current.accountId,
          amount: current.amountCents / 100,
          fee: current.feeCents / 100,
          payee: current.payee,
          categoryId: current.categoryId ?? '',
          targetAccountId: current.targetAccountId ?? '',
          date: localDateInput(current.occurredAt),
          notes: current.notes,
        };
      }
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    try {
      const saved = await api(
        '/api/console/events/' + encodeURIComponent(selected.id) + '/action',
        {
          kind: form.kind,
          accountId: form.accountId,
          amountCents: Math.round(Number(form.amount) * 100),
          feeCents: transfer ? Math.round(Number(form.fee) * 100) : 0,
          payee: form.payee,
          categoryId: !linkedTransfer && form.categoryId ? form.categoryId : undefined,
          targetAccountId: transfer && form.targetAccountId ? form.targetAccountId : undefined,
          occurredAt: localDateIso(form.date),
          notes: form.notes,
          actualRevision: selected.actualSync?.revision,
        },
      );
      selected = null;
      notify(
        saved.updated
          ? 'Transaction updated in Actual.'
          : 'Review saved. Message queued for import.',
      );
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
        categoryId: linkedTransfer ? '' : form.categoryId,
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
            ><td
              ><span
                class={'status status-' +
                  (event.categoryNeedsAttention ? 'imported_review' : event.status)}
                >{event.deletionPending
                  ? 'Deletion pending'
                  : event.categoryNeedsAttention
                    ? 'Imported · category needs review'
                    : label(event.status)}</span
              ></td
            ><td class="number" class:positive={(event.parsed?.amountCents ?? 0) > 0}
              >{money(event.parsed?.amountCents)}</td
            ><td
              ><button
                class="icon-button"
                aria-label={'Review message from ' + (event.input?.sender ?? 'unknown sender')}
                onclick={() => void open(event.id)}><Icon name="chevron" size={17} /></button
              ><button
                class="icon-button danger"
                aria-label={'Delete message from ' + (event.input?.sender ?? 'unknown sender')}
                disabled={event.status === 'processing' || deletionBusy}
                onclick={() => void prepareDelete(event)}><Icon name="trash" size={17} /></button
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
      <button
        class="danger"
        disabled={selected.status === 'processing' || deletionBusy}
        onclick={() => void prepareDelete(selected)}
        ><Icon name="trash" size={16} />Delete SMS</button
      >
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
        <span
          class={'status status-' +
            (selected.categoryNeedsAttention ? 'imported_review' : selected.status)}
          >{selected.categoryNeedsAttention
            ? 'Imported · category needs review'
            : label(selected.status)}</span
        ><span class="muted"
          >{selected.parser_reason
            ? label(selected.parser_reason)
            : 'Parser result available below'}</span
        >
      </div>
      {#if selected.error}<div class="error">{selected.error}</div>{/if}
      {#if selected.deletionPending}<div class="info-box">
          A previous Actual deletion did not finish. Use Delete SMS to refresh linked entries and
          retry, or remove only the SMS.
        </div>{/if}
      {#if imported}<div class="info-box">
          Changes saved here update the linked transaction in Actual.
          {#if selected.actualSync?.error}<p class="error-text">{selected.actualSync.error}</p>{/if}
        </div>{/if}
      {#if selected.categoryNeedsAttention}<div class="info-box">
          No category was sent on the original import. Select the correct category below and save to
          Actual.
          {#if selected.categorySuggestion && !selected.categorySuggestion.applied}
            AI suggested {catalog.categories.find(
              (category: any) => category.id === selected.categorySuggestion.categoryId,
            )?.name ?? 'a category'}
            at {Math.round(selected.categorySuggestion.confidence * 100)}% confidence{#if selected.categorySuggestion.threshold != null},
              below the {Math.round(selected.categorySuggestion.threshold * 100)}% threshold{/if}.
            {selected.categorySuggestion.reason}
          {:else if selected.enrichment_status?.startsWith('llm_')}
            Categorization: {label(selected.enrichment_status.replace('llm_', ''))}.
          {/if}
        </div>{/if}
      {#if selected.status === 'needs_review'}<div class="info-box">
          {#if selected.sourceBank}Source bank: {selected.sourceBank}.
          {/if}Check the suggested details and fill any missing fields before approving.
        </div>{/if}
      {#if selected.status === 'unsupported_format'}
        <LearnFormat
          event={selected}
          {catalog}
          onlearned={() => {
            selected = null;
            notify(
              'Format learned. This SMS is queued for import; future matching messages will use it.',
            );
            void load();
          }}
        />
      {/if}
      <details open={selected.status !== 'unsupported_format'}>
        <summary
          >{selected.status === 'unsupported_format'
            ? 'Approve just this message without learning'
            : 'Transaction details'}</summary
        >
        <form onsubmit={submit}>
          <div class="form-grid">
            <label
              >Action<select
                bind:value={form.kind}
                required
                onchange={(event) => {
                  if (
                    !['transfer_in', 'transfer_out', 'card_payment'].includes(
                      event.currentTarget.value,
                    )
                  )
                    form.fee = 0;
                }}
                ><option value="" disabled>Select action</option
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
              />{#if transfer}<small
                  >{linkedTransfer
                    ? 'Fees use your Bank Fees category.'
                    : 'Fees use the same category as this transaction.'}</small
                >{/if}</label
            ><label class="full"
              >Payee / merchant<input bind:value={form.payee} maxlength="100" required /></label
            >{#if transfer}<label class="full"
                >Counterparty account<select bind:value={form.targetAccountId}
                  ><option value="">External / unknown account</option
                  >{#each catalog.accounts.filter((a: any) => a.id !== form.accountId) as account (account.id)}<option
                      value={account.id}>{account.name}</option
                    >{/each}</select
                ><small>An Actual account creates a linked transfer.</small></label
              >{/if}{#if !linkedTransfer}<label class="full"
                >Category{imported ? ' in Actual' : ''}<select bind:value={form.categoryId}
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
            <label class="full"
              >Notes<textarea bind:value={form.notes} maxlength="4000" rows="3"></textarea></label
            >
          </div>
          <div class="form-actions">
            <button type="button" onclick={makeTemplate}
              ><Icon name="templates" size={16} />Save as template</button
            ><button
              class="primary"
              disabled={busy ||
                selected.deletionPending ||
                Boolean(imported && !selected.actualSync?.revision)}
              >{busy ? 'Saving…' : imported ? 'Save to Actual' : 'Approve & import'}<Icon
                name="check"
                size={16}
              /></button
            >
          </div>
        </form>
      </details>
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

{#if deletion}<dialog
    class="modal"
    use:modal
    bind:this={deleteDialog}
    aria-label="Delete SMS"
    oncancel={(event) => {
      if (deletionBusy) event.preventDefault();
    }}
    onclose={() => {
      if (deletionBusy) deleteDialog?.showModal();
      else deletion = null;
    }}
  >
    <div class="drawer-heading">
      <h2>Delete this SMS?</h2>
      <button
        class="icon-button"
        aria-label="Close deletion confirmation"
        disabled={deletionBusy}
        onclick={() => (deletion = null)}><Icon name="close" /></button
      >
    </div>
    <form class="panel-body" onsubmit={deleteMessage}>
      <p>
        This removes the SMS and its processing logs from sms2actual. Your phone’s inbox is
        unchanged. To restore this SMS later, move the sync checkpoint before it and resync Tasker.
      </p>
      <div class="sms-original">
        <strong>{deletion.input?.sender ?? 'Unknown sender'}</strong>
        <p dir="auto">{deletion.input?.message}</p>
      </div>
      {#if deletionLoading}<p role="status">Checking linked Actual entries…</p>{/if}
      {#if deletionPlan?.error}<div class="info-box">
          Could not check Actual: {deletionPlan.error} You can still delete only the SMS.
        </div>{/if}
      {#if deletionPlan?.transactionIds?.length}
        <label
          >Also delete the associated Actual transaction?<select
            bind:value={deleteChoice}
            disabled={deletionBusy}
          >
            <option value="keep">No — keep Actual entries</option><option
              value="delete"
              disabled={!deletionPlan.canDeleteActual}
              >Yes — delete linked Actual entries too</option
            >
          </select></label
        >
        {#if !deletionPlan.canDeleteActual}<p class="muted small">
            Actual deletion is unavailable. You can keep the entries and delete the SMS.
          </p>{/if}
        <div class="parse-result">
          {#each deletionPlan.transactions as transaction (transaction.id)}<p>
              <strong>{transaction.payee ?? 'Linked transaction'}</strong> · {money(
                transaction.amount,
              )}{#if transaction.accountName}
                · {transaction.accountName}{/if}
            </p>{/each}
        </div>
        {#if deletionPlan.linkedTransfer}<p class="muted small">
            This includes both sides of the linked transfer and any associated fees.
          </p>{:else}<p class="muted small">Any associated fee entry is included.</p>{/if}
        {#if deletionPlan.includesSplits}<p class="muted small">
            Deleting the Actual transaction also removes its split lines.
          </p>{/if}
      {:else if deletionPlan && !deletionPlan.error}<p>
          No linked Actual entries were found. Only the SMS will be removed.
        </p>{/if}
      {#if deletionError}<div class="error" role="alert">{deletionError}</div>{/if}
      <div class="form-actions">
        <button type="button" disabled={deletionBusy} onclick={() => (deletion = null)}
          >Cancel</button
        ><button
          type="button"
          disabled={deletionBusy || deletionLoading}
          onclick={() => void prepareDelete()}>Refresh linked entries</button
        >
        <button class="danger" disabled={deletionBusy || deletionLoading || !deletionPlan}
          >{deletionBusy
            ? 'Deleting…'
            : deleteChoice === 'delete'
              ? 'Delete SMS & Actual entries'
              : 'Delete SMS only'}</button
        >
      </div>
    </form>
  </dialog>{/if}
