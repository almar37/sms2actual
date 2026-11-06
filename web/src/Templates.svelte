<script lang="ts">
  import { onMount } from 'svelte';
  import { api, actions } from './api.js';
  import Icon from './Icon.svelte';
  let { catalog, notify }: { catalog: any; notify: (message: string) => void } = $props();
  let data = $state<any>({ templates: [], grammar: [], bankTemplates: [] }),
    editor = $state(false),
    form = $state<any>({}),
    sample = $state(''),
    sender = $state(''),
    receivedAt = $state(new Date().toISOString()),
    preview = $state<any>(null),
    parsedSample = $state<any>(null),
    busy = $state(false),
    error = $state(''),
    selectedField = $state('amount');
  let patternElement = $state<HTMLTextAreaElement>();
  const fields = ['amount', 'merchant', 'suffix', 'balance', 'fee', 'to', 'date'];
  async function load() {
    try {
      data = await api('/api/console/templates');
    } catch (e) {
      error = (e as Error).message;
    }
  }
  function open(template?: any) {
    form = template
      ? JSON.parse(JSON.stringify(template))
      : {
          id: crypto.randomUUID(),
          name: '',
          bank: catalog.banks.find((b: any) => b.disposition === 'import')?.id ?? '',
          kind: 'purchase',
          pattern: '',
          categoryId: '',
          enabled: true,
        };
    sample = template?.sample ?? '';
    sender = template?.sender ?? '';
    preview = null;
    parsedSample = null;
    error = '';
    editor = true;
  }
  function insertField() {
    const start = patternElement!.selectionStart,
      end = patternElement!.selectionEnd;
    form.pattern =
      form.pattern.slice(0, start) + '{' + selectedField + '}' + form.pattern.slice(end);
    preview = null;
    patternElement!.focus();
  }
  function inferBank() {
    const bank = catalog.banks.find((b: any) =>
      b.senders.some((s: string) => s.toLowerCase().trim() === sender.toLowerCase().trim()),
    );
    if (bank) form.bank = bank.id;
    preview = null;
  }
  async function readSample() {
    busy = true;
    error = '';
    try {
      parsedSample = await api('/api/console/parse', { message: sample, sender, receivedAt });
      if (parsedSample.type === 'transaction') {
        form.kind = parsedSample.transaction.kind;
        form.bank = parsedSample.transaction.bank;
        notify('Message parsed. Review the extracted fields below.');
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  function useFields() {
    let pattern = sample;
    const tx = parsedSample?.transaction;
    if (tx) {
      if (tx.payee && pattern.includes(tx.payee)) pattern = pattern.replace(tx.payee, '{merchant}');
      if (tx.accountAlias) pattern = pattern.replace(tx.accountAlias, '{suffix}');
      const numbers = [...pattern.matchAll(/[\d٠-٩][\d٠-٩,.]*/g)];
      const match = numbers.find(
        (m) =>
          Math.round(
            Number(
              m[0].replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632)).replaceAll(',', ''),
            ) * 100,
          ) === Math.abs(tx.amountCents ?? 0),
      );
      if (match?.index !== undefined)
        pattern =
          pattern.slice(0, match.index) + '{amount}' + pattern.slice(match.index + match[0].length);
    }
    form.pattern = pattern;
    preview = null;
  }
  function payload() {
    return { ...form, categoryId: form.categoryId || undefined, sample, sender };
  }
  async function test() {
    busy = true;
    error = '';
    try {
      preview = await api('/api/console/parse', {
        message: sample,
        sender,
        receivedAt,
        template: payload(),
      });
    } catch (e) {
      error = (e as Error).message;
      preview = null;
    } finally {
      busy = false;
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (preview?.type !== 'transaction') return;
    busy = true;
    try {
      await api('/api/console/templates', payload(), 'PUT');
      editor = false;
      notify('Template saved. Future matching messages will use it.');
      await load();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function toggle(template: any) {
    try {
      await api('/api/console/templates', { ...template, enabled: !template.enabled }, 'PUT');
      await load();
      notify(template.enabled ? 'Template paused.' : 'Template enabled.');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  onMount(() => {
    void load();
    const draft = sessionStorage.getItem('sms2actual-template-draft');
    if (draft) {
      sessionStorage.removeItem('sms2actual-template-draft');
      try {
        const d = JSON.parse(draft);
        open();
        sample = d.message;
        sender = d.sender;
        form.pattern = d.message;
        form.bank = d.bank || form.bank;
        form.kind = d.kind;
        form.categoryId = d.categoryId || '';
        receivedAt = d.receivedAt;
      } catch {
        notify('Could not restore the draft. Paste a message to begin.');
      }
    }
  });
</script>

<div class="page-heading">
  <div>
    <span class="eyebrow">TEACH IT ONCE</span>
    <h1>Message templates<span class="green">.</span></h1>
    <p>Turn a familiar bank message into a rule that remembers.</p>
  </div>
  <button class="primary" onclick={() => open()}
    ><Icon name="plus" size={16} />Create template</button
  >
</div>
{#if error && !editor}<div class="error" role="alert">{error}</div>{/if}
{#if editor}<section class="panel template-builder">
    <div class="panel-heading">
      <div>
        <h2>{form.name || 'A new message template'}</h2>
        <p>1. Paste a message · 2. Mark its fields · 3. Test and save</p>
      </div>
      <button
        class="icon-button"
        aria-label="Close template builder"
        onclick={() => (editor = false)}><Icon name="close" /></button
      >
    </div>
    <form class="panel-body" onsubmit={save}>
      <div class="template-columns">
        <div>
          <span class="step-label">01 / YOUR EXAMPLE</span><label
            >SMS sender<input
              bind:value={sender}
              onchange={inferBank}
              required
              placeholder="The exact bank sender name"
            /></label
          ><label
            >Paste a reference message<textarea
              rows="7"
              bind:value={sample}
              oninput={() => {
                preview = null;
                parsedSample = null;
              }}
              dir="auto"
              placeholder="Paste a real bank message here…"
              required></textarea></label
          >
          <div class="button-row">
            <button type="button" disabled={busy || !sample || !sender} onclick={readSample}
              ><Icon name="search" size={16} />Read message</button
            ><button
              type="button"
              disabled={parsedSample?.type !== 'transaction'}
              onclick={useFields}>Use parsed fields<Icon name="arrow" size={15} /></button
            >
          </div>
          {#if parsedSample}<div class="parse-result">
              <strong
                >{parsedSample.type === 'transaction'
                  ? 'Here’s what we found'
                  : 'Needs a custom template'}</strong
              >{#if parsedSample.transaction}<div class="field-chips">
                  {#each Object.entries(parsedSample.transaction).filter(([key, value]) => ['kind', 'accountAlias', 'amountCents', 'payee', 'balanceCents'].includes(key) && value != null) as [key, value] (key)}<span
                      ><small>{key}</small>{String(value)}</span
                    >{/each}
                </div>{:else}<p>{parsedSample.reason?.replaceAll('_', ' ')}</p>{/if}
            </div>{/if}
        </div>
        <div>
          <span class="step-label">02 / WHAT CHANGES?</span><label
            >Template name<input
              bind:value={form.name}
              maxlength="100"
              placeholder="e.g. Everyday card purchases"
              required
              oninput={() => (preview = null)}
            /></label
          ><label
            >Message pattern<textarea
              rows="7"
              bind:this={patternElement}
              bind:value={form.pattern}
              oninput={() => (preview = null)}
              dir="auto"
              required
              placeholder={'Purchase SAR {amount} at {merchant} card {suffix}'}></textarea></label
          >
          <div class="field-inserter">
            <select aria-label="Field to insert" bind:value={selectedField}
              >{#each fields as field (field)}<option value={field}>{'{' + field + '}'}</option
                >{/each}</select
            ><button type="button" onclick={insertField}>Replace selection</button>
          </div>
          <small class="muted"
            >Select a value in the pattern and replace it with a field. Include {'{amount}'}. Keep
            the bank’s fixed wording.</small
          >
        </div>
      </div>
      <div class="form-grid three">
        <label
          >Bank<select bind:value={form.bank} onchange={() => (preview = null)}
            >{#each catalog.banks.filter((b: any) => b.disposition === 'import') as bank (bank.id)}<option
                value={bank.id}>{bank.name}</option
              >{/each}</select
          ></label
        ><label
          >Action<select bind:value={form.kind} onchange={() => (preview = null)}
            >{#each actions as [value, text] (value)}<option {value}>{text}</option>{/each}</select
          ></label
        ><label
          >Category<select bind:value={form.categoryId} onchange={() => (preview = null)}
            ><option value="">Use merchant mapping / AI</option
            >{#each catalog.categories as c (c.id)}<option value={c.id}>{c.name}</option
              >{/each}</select
          >{#if ['transfer_in', 'transfer_out', 'card_payment'].includes(form.kind)}<small
              >Applies to external counterparties. Transfers between your accounts stay linked.</small
            >{/if}</label
        >
      </div>
      {#if error}<div class="error" role="alert">{error}</div>{/if}{#if preview}<div
          class={preview.type === 'transaction' ? 'success-box' : 'error'}
        >
          <strong
            >{preview.type === 'transaction'
              ? 'It matches. Your template is ready.'
              : 'This example doesn’t match yet.'}</strong
          >
          <pre>{JSON.stringify(preview.transaction ?? preview.reason, null, 2)}</pre>
        </div>{/if}
      <div class="form-actions">
        <button
          type="button"
          disabled={busy || !sample || !sender || !form.pattern || !form.name}
          onclick={test}>Test this example<Icon name="search" size={16} /></button
        ><button class="primary" disabled={busy || preview?.type !== 'transaction'}
          >{busy ? 'Working…' : 'Save template'}<Icon name="check" size={16} /></button
        >
      </div>
    </form>
  </section>{/if}
<div class="section-heading">
  <div>
    <h2>Your templates <span class="count">{data.templates.length}</span></h2>
    <p>Your own rules run before the shared grammar.</p>
  </div>
</div>
<div class="template-grid">
  {#each data.templates as t (t.id)}<section class="panel template-card">
      <div class="template-card-top">
        <span class="account-icon"><Icon name="templates" /></span><span
          class={'status ' + (t.enabled ? 'status-imported' : 'status-ignored')}
          >{t.enabled ? 'Active' : 'Paused'}</span
        >
      </div>
      <h3>{t.name}</h3>
      <p class="muted small">
        {catalog.banks.find((b: any) => b.id === t.bank)?.name ?? t.bank} · {actions.find(
          ([key]) => key === t.kind,
        )?.[1]}
      </p>
      <pre>{t.pattern}</pre>
      <div class="button-row">
        <button onclick={() => open(t)}>Edit template</button><button
          class="text-button"
          onclick={() => void toggle(t)}>{t.enabled ? 'Pause' : 'Enable'}</button
        >
      </div>
    </section>{/each}
</div>
{#if !data.templates.length && !editor}<section class="panel empty">
    <Icon name="templates" size={36} />
    <h3>Your next message can teach the system.</h3>
    <p>
      Paste an SMS, mark the values that change, and test your first template.<br />You can also
      start from any message in the inbox.
    </p>
    <button onclick={() => open()}>Create your first template<Icon name="arrow" size={16} /></button
    >
  </section>{/if}
<div class="section-heading">
  <div>
    <h2>Shared recognition rules</h2>
    <p>The English and Arabic grammar already working behind the scenes.</p>
  </div>
  <span class="tag">Built in</span>
</div>
<div class="grammar-grid">
  {#each data.grammar as rule, i (i)}<details class="panel grammar-card">
      <summary
        >{actions.find(([key]) => key === rule.kind)?.[1] ?? rule.kind}<span class="muted small"
          >{rule.patterns.length} recognition patterns</span
        ></summary
      >
      <pre>{rule.patterns.join('\n\n')}</pre>
    </details>{/each}
</div>
{#if data.bankTemplates.length}<div class="section-heading">
    <div>
      <h2>Bank message templates</h2>
      <p>Existing bank-specific extraction rules from your parser configuration.</p>
    </div>
  </div>
  <div class="grammar-grid">
    {#each data.bankTemplates as t (t.id)}<details class="panel grammar-card">
        <summary
          >{t.id}<span class="muted small"
            >{t.banks.join(', ') || 'No bank selected'} · {actions.find(
              ([key]) => key === t.kind,
            )?.[1] ?? t.kind}</span
          ></summary
        >
        <p class="muted small">Fields: {t.fields.join(', ')}</p>
        <pre>{t.patterns.join('\n\n')}</pre>
        <button
          onclick={() => {
            open();
            form.name = t.id + ' reference';
            form.kind = t.kind;
          }}>Create a custom reference</button
        >
      </details>{/each}
  </div>{/if}
