<script lang="ts">
  import { onMount } from 'svelte';
  import { api, when } from './api.js';
  import Icon from './Icon.svelte';
  let { catalog, notify }: { catalog: any; notify: (message: string) => void } = $props();
  let form = $state<any>({
      provider: 'disabled',
      model: '',
      apiKey: '',
      minConfidence: 0.7,
      hasKey: false,
    }),
    logs = $state<any[]>([]),
    models = $state<string[]>([]),
    loaded = $state(false),
    busy = $state(false),
    error = $state(''),
    merchant = $state(''),
    result = $state<any>(null),
    tab = $state('settings');
  async function load() {
    try {
      const [settings, history] = await Promise.all([
        api('/api/console/ai'),
        api('/api/console/ai/logs'),
      ]);
      form = { ...settings, apiKey: '' };
      logs = history.logs;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loaded = true;
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await api(
        '/api/console/ai',
        {
          provider: form.provider,
          model: form.model || 'disabled',
          apiKey: form.apiKey || undefined,
          minConfidence: Number(form.minConfidence),
        },
        'PUT',
      );
      form.apiKey = '';
      notify('AI settings saved. The helper is ready.');
      await load();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function loadModels() {
    busy = true;
    try {
      models = (await api('/api/console/ai/models')).models;
      notify(
        models.length
          ? 'Available models loaded.'
          : 'No models returned. You can enter a model ID.',
      );
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function test(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      result = await api('/api/console/ai/test', { merchant });
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void load();
  });
</script>

<div class="page-heading">
  <div>
    <span class="eyebrow">A HELPER, WITH YOUR RULES</span>
    <h1>AI categorization<span class="green">.</span></h1>
    <p>For unfamiliar merchants, a little context can go a long way.</p>
  </div>
  <span class="tag"><Icon name="ai" size={14} />Optional by design</span>
</div>
<div class="tabs">
  <button class:chosen={tab === 'settings'} onclick={() => (tab = 'settings')}
    >Provider & model</button
  ><button
    class:chosen={tab === 'logs'}
    onclick={() => {
      tab = 'logs';
      void api('/api/console/ai/logs')
        .then((d) => (logs = d.logs))
        .catch((e) => notify(e.message));
    }}>Category support logs <span class="count">{logs.length}</span></button
  >
</div>
{#if error}<div class="error" role="alert">{error}</div>{/if}
{#if tab === 'settings'}<div class="settings-columns">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <h2>Your categorization helper</h2>
          <p>Existing merchant history always gets the first word.</p>
        </div>
        <Icon name="ai" />
      </div>
      <form class="panel-body" onsubmit={save}>
        <label
          >Provider<select
            disabled={!loaded || busy}
            bind:value={form.provider}
            onchange={() => {
              form.model = '';
              form.apiKey = '';
              models = [];
            }}
            ><option value="disabled">Disabled · merchant history only</option><option
              value="opencode">OpenCode Go</option
            ><option value="anthropic">Anthropic · Claude</option><option value="openai"
              >OpenAI · ChatGPT models</option
            ></select
          ></label
        >{#if form.provider !== 'disabled'}<label
            >API key<input
              type="password"
              bind:value={form.apiKey}
              autocomplete="off"
              placeholder={form.hasKey
                ? 'Key saved · leave blank to keep it'
                : 'Paste your provider API key'}
            /><small
              >Your key is encrypted in the service database and never returned to the browser.</small
            ></label
          ><label
            >Model ID
            <div class="input-button">
              <input
                bind:value={form.model}
                list="provider-models"
                maxlength="120"
                placeholder="Enter a model ID from your provider"
                required
              /><button type="button" disabled={busy || !loaded} onclick={loadModels}
                >Load models</button
              >
            </div>
            <datalist id="provider-models"
              >{#each models as model (model)}<option value={model}></option>{/each}</datalist
            ><small
              >Save your provider and key before loading models. You can enter any supported model
              ID.</small
            ></label
          ><label
            >Minimum confidence <strong>{Math.round(form.minConfidence * 100)}%</strong><input
              type="range"
              min="0"
              max="1"
              step="0.05"
              bind:value={form.minConfidence}
            /><small>Suggestions below this threshold leave the category for review.</small></label
          >{/if}
        <div class="form-actions">
          <button class="primary" disabled={busy || !loaded}
            >{busy ? 'Saving…' : 'Save helper settings'}<Icon name="check" size={16} /></button
          >
        </div>
      </form>
    </section>
    <aside>
      <section class="tip-card">
        <span class="tip-icon">✳</span>
        <h3>You’re still in charge.</h3>
        <p>
          The helper only chooses from the categories you allow in Accounts & cards. Merchant
          history comes first, so familiar names don’t need another AI request.
        </p>
        <div class="info-box">
          OpenAI and Claude use provider API keys and API billing. Enter the key from the provider’s
          developer console.
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <div>
            <h3>Try a merchant</h3>
            <p>A real provider request using your saved settings.</p>
          </div>
        </div>
        <form class="panel-body" onsubmit={test}>
          <label
            >Merchant name<input
              bind:value={merchant}
              required
              maxlength="100"
              placeholder="A merchant you want help with"
            /></label
          ><small class="muted"
            >{catalog.settings.eligibleCategoryIds.length} eligible categories · This test does not import
            a transaction.</small
          ><button class="wide" disabled={busy || !merchant}
            >Test helper<Icon name="ai" size={16} /></button
          >{#if result}<div class={result.status === 'success' ? 'success-box' : 'info-box'}>
              <strong>{result.status.replaceAll('_', ' ')}</strong>{#if result.suggestion}<p>
                  {result.suggestion.payee} → {catalog.categories.find(
                    (c: any) => c.id === result.suggestion.categoryId,
                  )?.name ?? result.suggestion.categoryId}
                </p>
                <small
                  >{Math.round(result.suggestion.confidence * 100)}% confidence · {result.suggestion
                    .reason}</small
                >{:else}<p>
                  {result.error ?? 'Enable and save a provider to use AI categorization.'}
                </p>{/if}
            </div>{/if}
        </form>
      </section>
    </aside>
  </div>
{:else}<section class="panel">
    <div class="panel-heading">
      <div>
        <h2>Category support logs</h2>
        <p>The latest 100 decisions, including history hits, provider outcomes, and confidence.</p>
      </div>
    </div>
    {#each logs as log (log.id)}<details class="log-detail">
        <summary
          ><span
            class={'status ' +
              (log.status.includes('success') || log.status === 'history_hit'
                ? 'status-imported'
                : 'status-needs_review')}>{log.status.replaceAll('_', ' ')}</span
          ><span class="truncate"
            >{log.details?.merchant ?? log.details?.request?.merchant ?? log.event_id}</span
          ><small class="muted">{when(log.created_at)}</small></summary
        >
        <pre>{JSON.stringify(log.details, null, 2)}</pre>
      </details>{/each}{#if !logs.length}<div class="empty">
        <Icon name="ai" size={32} />
        <h3>Every decision leaves a trail.</h3>
        <p>Category decisions will appear here when messages are processed.</p>
      </div>{/if}
  </section>{/if}
