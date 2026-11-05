<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from './api.js';
  import Icon from './Icon.svelte';
  let {
    catalog,
    notify,
    refresh,
  }: {
    catalog: any;
    notify: (message: string) => void;
    refresh: () => Promise<void>;
  } = $props();
  let serverURL = $state(
      untrack(() => catalog.connection?.serverURL ?? catalog.actualServerUrl ?? ''),
    ),
    syncId = $state(untrack(() => catalog.connection?.syncId ?? '')),
    password = $state(''),
    encryptionPassword = $state(''),
    busy = $state(false),
    error = $state('');
  async function connect(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await api('/api/console/actual', {
        serverURL,
        syncId,
        password,
        encryptionPassword: encryptionPassword || undefined,
      });
      password = '';
      encryptionPassword = '';
      await refresh();
      notify(
        'Actual connected. Map your accounts and choose a Bank Fees category to start importing.',
      );
    } catch (e) {
      error = (e as Error).message;
      await refresh().catch(() => {});
    } finally {
      busy = false;
    }
  }
  async function reconnect() {
    busy = true;
    error = '';
    try {
      await api('/api/console/actual/reconnect', {});
      await refresh();
      notify('Actual connection restored.');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="panel">
  <div class="panel-heading">
    <div>
      <h2>Actual server connection</h2>
      <p>
        {catalog.connection?.connected
          ? 'Your budget is connected.'
          : 'Connect your existing Actual budget to continue.'}
      </p>
    </div>
    <Icon name="accounts" />
  </div>
  <form class="panel-body" onsubmit={connect}>
    {#if error || catalog.connection?.error}<div class="error" role="alert">
        {error || catalog.connection.error}
      </div>{/if}
    {#if catalog.connection?.connecting}<div class="info-box">
        Connecting to Actual… This may take a moment while your budget downloads.
      </div>{/if}
    <label
      >Actual server URL<input
        type="url"
        bind:value={serverURL}
        placeholder="https://actual.example.com"
        required
      />
      <small
        >Use an address reachable from this service. Inside Docker, localhost refers to this
        container. You can use an Actual container name on a shared network.</small
      >
    </label>
    <label
      >Actual server password<input
        type="password"
        bind:value={password}
        autocomplete="off"
        required
        maxlength="1000"
      /></label
    >
    <label
      >Budget Sync ID<input bind:value={syncId} required maxlength="200" autocomplete="off" />
      <small>In Actual, open Settings → Show advanced settings → Sync ID.</small>
    </label>
    <label
      >Budget encryption password <span class="muted">(optional)</span><input
        type="password"
        bind:value={encryptionPassword}
        autocomplete="off"
        maxlength="1000"
      />
      <small
        >Only needed if end-to-end encryption is enabled for this budget. Enter it again when
        changing the connection.</small
      >
    </label>
    <p class="muted small">
      Credentials are encrypted and saved in the data volume. Use Actual 26.9.0 to match the bundled
      API.
    </p>
    <div class="form-actions">
      {#if catalog.connection?.configured}<button
          type="button"
          onclick={reconnect}
          disabled={busy || catalog.connection?.connecting}>Reconnect saved connection</button
        >{/if}
      <button class="primary" disabled={busy || catalog.connection?.connecting}
        >{busy ? 'Connecting…' : 'Connect Actual'}<Icon name="arrow" size={16} /></button
      >
    </div>
  </form>
</section>
