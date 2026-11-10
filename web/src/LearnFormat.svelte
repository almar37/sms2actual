<script lang="ts">
  import { api, actions } from './api.js';
  import {
    patternFromSelections,
    selectionError,
    selectionFields,
    templateDateFormats,
    type TemplateDateFormat,
    type TemplateSelections,
    type SelectionField,
  } from '../../src/template-selection.js';
  let { event, catalog, onlearned }: { event: any; catalog: any; onlearned: () => void } = $props();
  let name = $state(''),
    kind = $state(''),
    categoryId = $state(''),
    dateFormat = $state<TemplateDateFormat>('iso'),
    values = $state<TemplateSelections>({}),
    field = $state<SelectionField>('amount'),
    selectedText = $state<{ value: string; start: number } | null>(null),
    busy = $state(false),
    error = $state('');
  const labels: Record<SelectionField, string> = {
    amount: 'Amount',
    merchant: 'Merchant identifier',
    suffix: 'Account / card suffix',
    balance: 'Balance',
    fee: 'Fee',
    to: 'Counterparty suffix',
    date: 'Date and time',
  };
  const draft = $derived.by(() => {
    try {
      return { pattern: patternFromSelections(event.input.message, values), error: '' };
    } catch (e) {
      return { pattern: '', error: (e as Error).message };
    }
  });
  const pattern = $derived(draft.pattern);
  function capture(e: Event) {
    const input = e.currentTarget as HTMLTextAreaElement;
    selectedText =
      input.selectionEnd > input.selectionStart
        ? {
            value: input.value.slice(input.selectionStart, input.selectionEnd),
            start: input.selectionStart,
          }
        : null;
  }
  function useSelection() {
    if (selectedText) values[field] = { ...selectedText };
    error = '';
  }
  function update(key: SelectionField, value: string) {
    if (value) values[key] = { value };
    else delete values[key];
    error = '';
  }
  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      await api('/api/console/events/' + encodeURIComponent(event.id) + '/learn', {
        name,
        kind,
        categoryId: categoryId || undefined,
        selections: values,
        dateFormat,
      });
      onlearned();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="learn-format">
  <h3>Teach this format</h3>
  <p class="muted small">
    Select the values in the received SMS, or copy them exactly into the boxes below. Keep currency
    symbols and labels outside the selection. All unmarked text stays fixed in future messages.
  </p>
  <label
    >Received SMS — select a value<textarea
      rows="6"
      readonly
      value={event.input.message}
      onselect={capture}
      dir="auto"></textarea></label
  >
  <div class="field-inserter">
    <select aria-label="Selected SMS field" bind:value={field}
      >{#each selectionFields as key (key)}<option value={key}>{labels[key]}</option>{/each}</select
    >
    <button type="button" disabled={!selectedText} onclick={useSelection}>Use selected text</button>
  </div>
  <form onsubmit={save}>
    <div class="form-grid">
      <label
        >Format name<input
          bind:value={name}
          maxlength="100"
          required
          placeholder="e.g. Card purchases"
        /></label
      >
      <label
        >Format action<select bind:value={kind} required
          ><option value="" disabled>Select action</option
          >{#each actions as [value, label] (value)}<option {value}>{label}</option>{/each}</select
        ></label
      >
      {#each selectionFields as key (key)}
        {@const invalid = values[key]
          ? selectionError(event.input.message, values[key]!)
          : undefined}
        <label
          >{labels[key]}{key !== 'amount' &&
          !(key === 'merchant' && ['purchase', 'refund'].includes(kind))
            ? ' (optional)'
            : ''}
          <input
            value={values[key]?.value ?? ''}
            aria-invalid={Boolean(invalid)}
            aria-describedby={invalid ? 'learn-error-' + key : undefined}
            required={key === 'amount' ||
              (key === 'merchant' && ['purchase', 'refund'].includes(kind))}
            oninput={(e) => update(key, e.currentTarget.value)}
          />
          {#if invalid}<small id={'learn-error-' + key} class="error-text">{invalid}</small>{/if}
        </label>
      {/each}
      {#if values.date?.value}<label class="full"
          >Date format<select bind:value={dateFormat}
            >{#each Object.entries(templateDateFormats) as [value, label] (value)}<option {value}
                >{label}</option
              >{/each}</select
          ><small>Match the order used in the SMS. Arabic digits are supported.</small></label
        >{/if}
      <label class="full"
        >Format category<select bind:value={categoryId}
          ><option value="">Use merchant mapping / AI</option
          >{#each catalog.categories as category (category.id)}<option value={category.id}
              >{category.name}</option
            >{/each}</select
        ></label
      >
    </div>
    {#if pattern}<div class="parse-result">
        <strong>Future message pattern</strong>
        <pre dir="auto">{pattern}</pre>
      </div>{/if}
    <p class="muted small">
      Select the positive SAR amount. Leave the date empty to use the SMS received time. Select
      every value that changes, including the balance, fees, and account suffix when present. Saving
      validates the format and account route, then queues this SMS for import.
    </p>
    {#if draft.error && values.amount?.value}<div class="error" role="alert">
        {draft.error}
      </div>{/if}
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    <div class="form-actions">
      <button class="primary" disabled={busy || !pattern || !kind || !name}
        >{busy ? 'Validating…' : 'Learn format & import'}</button
      >
    </div>
  </form>
</section>
