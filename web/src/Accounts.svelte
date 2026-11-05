<script lang="ts">
  import { untrack } from 'svelte';
  import { api, money, when } from './api.js';
  import Icon from './Icon.svelte';
  let {
    catalog,
    notify,
    refresh,
  }: { catalog: any; notify: (message: string) => void; refresh: () => Promise<void> } = $props();
  let settings = $state<any>(untrack(() => structuredClone($state.snapshot(catalog.settings)))),
    busy = $state(false),
    error = $state(''),
    dirty = $state(false);
  let suffixText = $state<Record<string, string>>(
    untrack(() =>
      Object.fromEntries(
        settings.accounts.map((a: any) => [a.id, (a.match.accountSuffixes ?? []).join(', ')]),
      ),
    ),
  );
  let target = $state('');
  const available = $derived(
    catalog.accounts.filter((a: any) => !settings.accounts.some((s: any) => s.id === a.id)),
  );
  function add() {
    const account = catalog.accounts.find((a: any) => a.id === target);
    if (!account) return;
    settings.accounts.push({
      id: account.id,
      name: account.name,
      type: 'checking',
      match: {
        bank: catalog.banks.find((b: any) => b.disposition === 'import')?.id ?? '',
        accountSuffixes: [],
      },
      cards: [],
    });
    suffixText[account.id] = '';
    target = '';
    dirty = true;
  }
  const csv = (text: string) =>
    text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  async function save() {
    busy = true;
    error = '';
    try {
      const body = structuredClone($state.snapshot(settings));
      for (const a of body.accounts) {
        const suffixes = csv(suffixText[a.id] ?? '');
        a.match.accountSuffixes = suffixes.length ? suffixes : undefined;
        if (!a.fundingAccountId) delete a.fundingAccountId;
      }
      await api('/api/console/settings', body, 'PUT');
      await refresh();
      settings = structuredClone($state.snapshot(catalog.settings));
      dirty = false;
      notify('Accounts and cards saved. Routing is active.');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="page-heading">
  <div>
    <span class="eyebrow">A PLACE FOR EVERY PAYMENT</span>
    <h1>Accounts & cards<span class="green">.</span></h1>
    <p>Connect the last digits in your messages to the right Actual account.</p>
  </div>
  <button class="primary" disabled={busy || !dirty} onclick={save}
    ><Icon name="check" size={16} />{busy ? 'Saving…' : 'Save changes'}</button
  >
</div>
{#if error}<div class="error" role="alert">{error}</div>{/if}{#if dirty}<div class="info-box">
    You have unsaved changes. Save to update routing for new messages.
  </div>{/if}
<div class="info-box subtle">
  <Icon name="accounts" size={20} /><span
    >One Actual account can have several cards. Use 3–6 trailing digits for account and card
    suffixes. All accounts and categories come from your existing budget.</span
  >
</div>
<div class="account-editor-list">
  {#each settings.accounts as account, i (account.id)}<section class="panel account-editor">
      <div class="panel-heading">
        <div class="account-editor-name">
          <span class="account-icon"><Icon name="accounts" size={21} /></span>
          <div>
            <h2>{account.name}</h2>
            <small class="muted">Linked to Actual Budget</small>
          </div>
        </div>
        <button
          class="text-button danger"
          onclick={() => {
            settings.accounts.splice(i, 1);
            dirty = true;
          }}>Remove mapping</button
        >
      </div>
      <div
        class="panel-body"
        oninput={() => (dirty = true)}
        onchange={() => (dirty = true)}
        role="group"
        aria-label={account.name + ' configuration'}
      >
        <div class="form-grid three">
          <label
            >Bank<select bind:value={account.match.bank}
              >{#each catalog.banks.filter((b: any) => b.disposition === 'import') as bank (bank.id)}<option
                  value={bank.id}>{bank.name}</option
                >{/each}</select
            ></label
          ><label
            >Account type<select bind:value={account.type}
              ><option value="checking">Current / checking</option><option value="savings"
                >Savings</option
              ><option value="credit">Credit card account</option></select
            ></label
          ><label
            >Account suffixes<input
              bind:value={suffixText[account.id]}
              placeholder="e.g. 1234, 5678"
            /><small>Separate multiple suffixes with commas.</small></label
          >
        </div>
        {#if account.type === 'credit'}{@const detected = catalog.limits?.[account.id]}
          <div class="credit-config">
            <div class="form-grid">
              <label
                >Credit limit (SAR)<input
                  type="number"
                  min="0"
                  step="0.01"
                  value={account.creditLimitCents == null ? '' : account.creditLimitCents / 100}
                  oninput={(e) => {
                    account.creditLimitCents = e.currentTarget.value
                      ? Math.round(Number(e.currentTarget.value) * 100)
                      : undefined;
                    dirty = true;
                  }}
                  placeholder="Detect from SMS when available"
                />{#if detected}<small
                    >Detected {money(detected.cents)} · {when(detected.observedAt)}
                    <button
                      class="text-button"
                      onclick={() => {
                        account.creditLimitCents = detected.cents;
                        dirty = true;
                      }}>Use detected limit</button
                    ></small
                  >{:else}<small
                    >An explicit credit limit in a matching SMS is detected automatically.</small
                  >{/if}</label
              ><label
                >Default repayment account<select bind:value={account.fundingAccountId}
                  ><option value="">No default</option
                  >{#each catalog.accounts.filter((a: any) => a.id !== account.id) as a (a.id)}<option
                      value={a.id}>{a.name}</option
                    >{/each}</select
                ><small>The source account used when a repayment SMS does not name one.</small
                ></label
              >
            </div>
          </div>{/if}
        <div class="subsection-heading">
          <h3>Associated cards <span class="count">{account.cards.length}</span></h3>
          <button
            onclick={() => {
              account.cards.push({
                name: '',
                suffix: '',
                type: account.type === 'credit' ? 'credit' : 'debit',
              });
              dirty = true;
            }}><Icon name="plus" size={15} />Add card</button
          >
        </div>
        {#each account.cards as card, j (card)}<div class="card-editor-row">
            <Icon name="accounts" /><label
              >Card name<input
                bind:value={card.name}
                placeholder="e.g. Travel Visa"
                maxlength="80"
              /></label
            ><label
              >Last digits<input
                bind:value={card.suffix}
                placeholder="1234"
                pattern={'[0-9]{3,6}'}
                maxlength="6"
              /></label
            ><label
              >Card type<select bind:value={card.type}
                ><option value="debit">Debit</option><option value="credit">Credit</option></select
              ></label
            ><button
              class="icon-button danger"
              aria-label="Remove card"
              onclick={() => {
                account.cards.splice(j, 1);
                dirty = true;
              }}><Icon name="close" size={18} /></button
            >
          </div>{/each}{#if !account.cards.length}<p class="muted small">
            No cards added. Add debit cards here, or group multiple credit cards under this account.
          </p>{/if}
        <details>
          <summary>Transfer and bill payment identifiers</summary>
          <p class="muted small">
            These optional references help recognize transfers between your own accounts. Account
            and card suffixes are already checked automatically. Leave these blank unless an SMS
            uses a different reference for this account. A match creates a linked transfer in
            Actual.
          </p>
          <div class="form-grid">
            <label
              >Transfer destination suffixes<input
                value={(account.match.transferIdentifiers ?? []).join(', ')}
                onchange={(e) => {
                  const values = csv(e.currentTarget.value);
                  account.match.transferIdentifiers = values.length ? values : undefined;
                  dirty = true;
                }}
                placeholder="e.g. 9876"
              /><small
                >Example: transfers to this account show an IBAN ending in 9876 instead of its usual
                suffix. Add 9876 here.</small
              ></label
            ><label
              >Bill payment identifiers<input
                value={(account.match.billPaymentIdentifiers ?? []).join(', ')}
                onchange={(e) => {
                  const values = csv(e.currentTarget.value);
                  account.match.billPaymentIdentifiers = values.length ? values : undefined;
                  dirty = true;
                }}
                placeholder="e.g. 5678"
              /><small
                >Example: a repayment to this credit account shows “Biller: 5678” or “مفوتر: 5678”.
                Add 5678 here.</small
              ></label
            >
          </div>
          {#if account.match.transactionKinds}<p class="muted small">
              Existing action filter: {account.match.transactionKinds.join(', ')}
              <button
                class="text-button"
                onclick={() => {
                  delete account.match.transactionKinds;
                  dirty = true;
                }}>Clear filter</button
              >
            </p>{/if}{#if account.match.hasBalance !== undefined}<p class="muted small">
              Existing balance filter: {String(account.match.hasBalance)}
              <button
                class="text-button"
                onclick={() => {
                  delete account.match.hasBalance;
                  dirty = true;
                }}>Clear filter</button
              >
            </p>{/if}
        </details>
      </div>
    </section>{/each}
</div>
<section class="panel add-account">
  <div>
    <h3>Bring another account into the picture.</h3>
    <p>Choose an existing open account from Actual.</p>
  </div>
  <select aria-label="Actual account to add" bind:value={target}
    ><option value="">Choose an account</option>{#each available as a (a.id)}<option value={a.id}
        >{a.name}</option
      >{/each}</select
  ><button disabled={!target} onclick={add}><Icon name="plus" size={16} />Add account</button>
</section>
<section class="panel">
  <div class="panel-heading">
    <div>
      <h2>Fees & merchant categories</h2>
      <p>A little guidance for automatic categorization.</p>
    </div>
    <Icon name="filter" />
  </div>
  <div class="panel-body">
    <label
      >Bank Fees category<select
        bind:value={settings.bankFeesCategoryId}
        onchange={() => (dirty = true)}
        >{#each catalog.categories.filter((c: any) => !c.isIncome) as category (category.id)}<option
            value={category.id}>{category.name}</option
          >{/each}</select
      ><small>Used for transfer fees and messages mapped to a bank fee.</small></label
    >
    <div class="subsection-heading">
      <h3>Categories available to merchant enrichment</h3>
      <button
        class="text-button"
        onclick={() => {
          settings.eligibleCategoryIds = catalog.categories
            .filter((c: any) => !c.isIncome)
            .map((c: any) => c.id);
          dirty = true;
        }}>Select all</button
      >
    </div>
    <div class="category-grid">
      {#each catalog.categories.filter((c: any) => !c.isIncome) as category (category.id)}<label
          class="checkbox-label"
          ><input
            type="checkbox"
            value={category.id}
            bind:group={settings.eligibleCategoryIds}
            onchange={() => (dirty = true)}
          />{category.name}</label
        >{/each}
    </div>
    <div class="form-actions">
      <button class="primary" onclick={save} disabled={busy || !dirty}
        >{busy ? 'Saving…' : 'Save changes'}<Icon name="check" size={16} /></button
      >
    </div>
  </div>
</section>
