<script lang="ts">
  import { modal } from './modal.js';
  import { onMount } from 'svelte';
  import { api, when } from './api.js';
  import Icon from './Icon.svelte';
  let { catalog, notify }: { catalog: any; notify: (message: string) => void } = $props();
  let merchants = $state<any[]>([]),
    search = $state(''),
    form = $state<any>(null),
    busy = $state(false),
    error = $state('');
  const filtered = $derived(
    merchants.filter((m) =>
      (m.payee + ' ' + m.merchant_key).toLowerCase().includes(search.toLowerCase()),
    ),
  );
  async function load() {
    try {
      merchants = (await api('/api/console/merchants')).merchants;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    try {
      await api(
        '/api/console/merchants',
        {
          accountId: form.accountId,
          merchant: form.merchant,
          payee: form.payee,
          categoryId: form.categoryId,
        },
        'PUT',
      );
      form = null;
      notify('Merchant mapping saved for future messages.');
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      busy = false;
    }
  }
  async function recheck() {
    busy = true;
    try {
      const result = await api('/api/console/merchants/recheck', {}, 'POST');
      await load();
      notify(
        `Checked ${result.checked} Al Rajhi messages: ${result.repaired} merchant keys repaired, ${result.needsReview} need review, ${result.unavailable} lack original messages.`,
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      busy = false;
    }
  }
  function edit(m?: any) {
    form = m
      ? {
          accountId: m.account_id,
          merchant: m.merchant_key,
          payee: m.payee,
          categoryId: m.review_reason ? '' : m.category_id,
          existing: true,
        }
      : {
          accountId: catalog.accounts[0]?.id ?? '',
          merchant: '',
          payee: '',
          categoryId: '',
          existing: false,
        };
  }
  onMount(() => {
    void load();
  });
</script>

<div class="page-heading">
  <div>
    <span class="eyebrow">FAMILIAR NAMES, FEWER DECISIONS</span>
    <h1>Your merchants<span class="green">.</span></h1>
    <p>Every remembered merchant is one less thing to categorize.</p>
  </div>
  <div class="button-row">
    <button disabled={busy} onclick={recheck}
      >{busy ? 'Rechecking…' : 'Recheck Al Rajhi merchants'}</button
    >
    <button class="primary" onclick={() => edit()}
      ><Icon name="plus" size={17} />Add merchant</button
    >
  </div>
</div>
<div class="info-box subtle">
  <Icon name="ai" size={20} /><span
    >Confirmed merchants are checked before AI. Suggestions marked for review are not reused until
    you confirm them. Your edits are remembered per account for future messages.</span
  >
</div>
{#if error}<div class="error" role="alert">{error}</div>{/if}
<section class="panel">
  <div class="table-toolbar">
    <div class="search-field">
      <Icon name="search" size={18} /><input
        bind:value={search}
        aria-label="Search merchants"
        placeholder="Find a merchant…"
      />
    </div>
    <span class="muted small">{filtered.length} merchants</span>
  </div>
  <div class="table-scroll">
    <table>
      <thead
        ><tr
          ><th>Merchant / payee</th><th>Account</th><th>Category</th><th>Learned from</th><th
            >Last updated</th
          ><th></th></tr
        ></thead
      ><tbody
        >{#each filtered as m (m.account_id + m.merchant_key)}<tr
            ><td
              ><div class="payee-cell">
                <span class="merchant-avatar">{m.payee.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{m.payee}</strong><small>{m.merchant_key}</small
                  >{#if m.reviewReason}<small>{m.reviewReason}</small>{/if}
                </div>
              </div></td
            ><td
              >{catalog.accounts.find((a: any) => a.id === m.account_id)?.name ?? m.account_id}</td
            ><td
              ><span class="tag"
                >{catalog.categories.find((c: any) => c.id === m.category_id)?.name ??
                  'Category unavailable'}</span
              ></td
            ><td
              >{m.source === 'local'
                ? 'Your edit'
                : m.source === 'actual'
                  ? 'Actual history'
                  : 'AI suggestion'}</td
            ><td class="muted">{when(m.updated_at)}</td><td
              ><button onclick={() => edit(m)}>{m.reviewReason ? 'Review' : 'Edit'}</button></td
            ></tr
          >{/each}</tbody
      >
    </table>
  </div>
  {#if !filtered.length}<div class="empty">
      <Icon name="merchants" size={34} />
      <h3>{search ? 'No matching merchants.' : 'Good habits start with one merchant.'}</h3>
      <p>
        {search
          ? 'Try searching by another name.'
          : 'Mappings appear here as categorized history is learned from Actual. You can add your own.'}
      </p>
    </div>{/if}
</section>
{#if form}<dialog class="modal" use:modal onclose={() => (form = null)} aria-label="Edit merchant">
    <div class="drawer-heading">
      <h2>{form.existing ? 'Edit merchant' : 'Remember a merchant'}</h2>
      <button class="icon-button" aria-label="Close merchant editor" onclick={() => (form = null)}
        ><Icon name="close" /></button
      >
    </div>
    <form class="panel-body" onsubmit={save}>
      <label
        >Merchant text from SMS<input
          bind:value={form.merchant}
          readonly={form.existing}
          maxlength="200"
          required
        /></label
      ><label>Display payee<input bind:value={form.payee} maxlength="100" required /></label>
      <div class="form-grid">
        <label
          >Account<select bind:value={form.accountId} disabled={form.existing} required
            >{#each catalog.accounts as a (a.id)}<option value={a.id}>{a.name}</option
              >{/each}</select
          ></label
        ><label
          >Category<select bind:value={form.categoryId} required
            ><option value="" disabled>Select category</option
            >{#each catalog.categories.filter((c: any) => !c.isIncome) as category (category.id)}<option
                value={category.id}>{category.name}</option
              >{/each}</select
          ></label
        >
      </div>
      <div class="form-actions">
        <button type="button" onclick={() => (form = null)}>Cancel</button><button
          class="primary"
          disabled={busy}
          >{busy ? 'Saving…' : 'Save merchant'}<Icon name="check" size={16} /></button
        >
      </div>
    </form>
  </dialog>{/if}
