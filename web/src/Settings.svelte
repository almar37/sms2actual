<script lang="ts">
  import { untrack } from 'svelte';
  import { api, when, localDateInput } from './api.js';
  import Icon from './Icon.svelte';
  import ActualConnection from './ActualConnection.svelte';
  import { modal } from './modal.js';
  let {
    catalog,
    notify,
    tasker,
    refresh,
  }: {
    catalog: any;
    notify: (message: string) => void;
    tasker: boolean;
    refresh: () => Promise<void>;
  } = $props();
  let url = $state(untrack(() => catalog.publicUrl)),
    busy = $state(false),
    error = $state(''),
    sessions = $state<any[]>([]),
    currentPassword = $state(''),
    newPassword = $state(''),
    taskerApiKey = $state(''),
    revealingKey = $state(false);
  let checkpoint = $state<{ date: number; rowId: number } | null>(null),
    checkpointMode = $state('now'),
    checkpointDate = $state(localDateInput(new Date().toISOString(), true)),
    checkpointLoading = $state(true),
    checkpointLoaded = $state(false),
    checkpointBusy = $state(false);
  let resetOpen = $state(false),
    resetConfirmation = $state(''),
    resetBusy = $state(false),
    resetError = $state('');
  function closeReset() {
    resetOpen = false;
    resetConfirmation = '';
    resetError = '';
  }
  async function resetSmsData(event: SubmitEvent) {
    event.preventDefault();
    if (resetConfirmation !== 'RESET' || resetBusy) return;
    resetBusy = true;
    resetError = '';
    try {
      const result = await api('/api/console/data/reset', { confirmation: resetConfirmation });
      closeReset();
      await refresh().catch(() => {});
      notify(
        `Cleared ${result.deletedMessages} messages and their logs. Tasker now starts from the reset time.`,
      );
    } catch (e) {
      resetError = (e as Error).message;
    } finally {
      resetBusy = false;
    }
  }
  async function loadCheckpoint() {
    checkpointLoading = true;
    checkpointLoaded = false;
    try {
      checkpoint = (await api('/api/console/tasker/checkpoint')).checkpoint;
      checkpointLoaded = true;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      checkpointLoading = false;
    }
  }
  async function saveCheckpoint(event: SubmitEvent) {
    event.preventDefault();
    if (!checkpointLoaded || checkpointBusy) return;
    checkpointBusy = true;
    error = '';
    try {
      const date = checkpointMode === 'now' ? 'now' : new Date(checkpointDate).getTime();
      if (date !== 'now' && !Number.isFinite(date))
        throw new Error('Choose a valid checkpoint date and time');
      const result = await api(
        '/api/console/tasker/checkpoint',
        { date, expected: checkpoint },
        'PUT',
      );
      checkpoint = result.checkpoint;
      notify('Inbox checkpoint saved. Tasker will use it on its next sync.');
    } catch (e) {
      error = (e as Error).message;
      await loadCheckpoint();
    } finally {
      checkpointBusy = false;
    }
  }
  async function toggleTaskerKey() {
    if (taskerApiKey) {
      taskerApiKey = '';
      return;
    }
    revealingKey = true;
    error = '';
    try {
      const credentials = await api('/api/console/tasker/credentials', {});
      taskerApiKey = credentials.apiKey;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      revealingKey = false;
    }
  }
  async function download() {
    busy = true;
    error = '';
    try {
      const response = await fetch('/api/console/tasker/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = 'sms2actual.prj.xml';
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      notify('Your Tasker project is ready to import.');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function rotate() {
    busy = true;
    error = '';
    try {
      await api('/api/console/tasker/rotate', {});
      taskerApiKey = '';
      notify('New Tasker credential created. Download and reimport the project.');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function loadSessions() {
    try {
      sessions = await api('/api/auth/list-sessions');
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function revoke(token: string) {
    try {
      await api('/api/auth/revoke-session', { token });
      await loadSessions();
      notify('Session revoked.');
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function changePassword(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await api('/api/auth/change-password', {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      currentPassword = '';
      newPassword = '';
      notify('Password updated. Other sessions have been signed out.');
      await loadSessions();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  $effect(() => {
    if (tasker) {
      void loadCheckpoint();
    } else {
      taskerApiKey = '';
      void loadSessions();
    }
  });
</script>

<div class="page-heading">
  <div>
    <span class="eyebrow">{tasker ? 'YOUR PHONE, MEET YOUR BUDGET' : 'MAKE YOURSELF AT HOME'}</span>
    <h1>{tasker ? 'Tasker connection' : 'Workspace settings'}<span class="green">.</span></h1>
    <p>
      {tasker
        ? 'A ready-to-import project. A direct line from SMS to Actual.'
        : 'Manage access, sessions, and your Actual server connection.'}
    </p>
  </div>
  <span class="tag"
    ><Icon name={tasker ? 'tasker' : 'shield'} size={15} />{tasker
      ? 'Android + Tasker'
      : 'Better Auth'}</span
  >
</div>
{#if error}<div class="error" role="alert">{error}</div>{/if}
{#if tasker}<div class="settings-columns">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <h2>Connect in a few minutes.</h2>
          <p>Your service URL and credential are included in the XML.</p>
        </div>
        <Icon name="tasker" />
      </div>
      <div class="panel-body">
        <label
          >Public service URL<input
            type="url"
            bind:value={url}
            placeholder="https://sms.example.com"
          /><small
            >Use this service’s HTTPS origin, without a path. Tasker routes to <code>/api/v1</code
            >.</small
          ></label
        >
        <label
          >Tasker SMS API key
          <div class="input-button">
            <input
              type={taskerApiKey ? 'text' : 'password'}
              value={taskerApiKey}
              readonly
              autocomplete="off"
              placeholder="Reveal the key when you need it"
            /><button type="button" onclick={toggleTaskerKey} disabled={revealingKey}
              >{revealingKey ? 'Loading…' : taskerApiKey ? 'Hide API key' : 'Show API key'}</button
            >
          </div>
          <small
            >Use this key in Tasker’s X-API-Key header. It is also included in the downloaded XML.</small
          >
        </label>
        <div class="subsection-heading"><h3>Inbox checkpoint</h3></div>
        <p class="muted small">
          {#if checkpointLoading}Loading checkpoint…
          {:else if checkpoint}Current checkpoint: {new Date(checkpoint.date).toLocaleString()}
          {:else if checkpointLoaded}Your first sync will start from now.{/if}
        </p>
        <form onsubmit={saveCheckpoint}>
          <div class="form-grid">
            <label
              >Start syncing from<select bind:value={checkpointMode} disabled={checkpointBusy}>
                <option value="now">Now</option>
                <option value="custom">Choose a date and time</option>
              </select></label
            >
            {#if checkpointMode === 'custom'}<label
                >Checkpoint date and time<input
                  type="datetime-local"
                  step="1"
                  bind:value={checkpointDate}
                  required
                  disabled={checkpointBusy}
                /><small>Uses your device’s time zone.</small></label
              >{/if}
          </div>
          <p class="muted small">
            Save an earlier time to recheck older SMS, or a later time to skip unread messages
            before it. Existing imports stay deduplicated. Your current checkpoint is kept until you
            save a change.
          </p>
          <div class="form-actions">
            <button
              type="button"
              onclick={() => {
                error = '';
                void loadCheckpoint();
              }}
              disabled={checkpointLoading || checkpointBusy}>Refresh checkpoint</button
            >
            <button class="primary" disabled={!checkpointLoaded || checkpointBusy}
              >{checkpointBusy ? 'Saving…' : 'Save checkpoint'}</button
            >
          </div>
        </form>
        <div class="endpoint-preview">
          <span class="method-badge">POST</span><code
            >{url.replace(/\/$/, '')}/api/v1/inbox-sync/batch</code
          ><Icon name="shield" size={16} />
        </div>
        <button class="primary wide" onclick={download} disabled={busy}
          ><Icon name="down" size={18} />{busy ? 'Preparing…' : 'Download Tasker project'}</button
        >
        <ol class="setup-steps">
          <li>
            <strong>Import into Tasker</strong>
            <p>
              On Android, press and hold the home / project tab in Tasker, choose Import Project,
              and select sms2actual.prj.xml. When updating, disable or remove the old sms2actual /
              Actual SMS Inbox project first so its scheduled task cannot keep uploading messages.
            </p>
          </li>
          <li>
            <strong>Allow SMS access</strong>
            <p>
              Grant Tasker permission to read SMS. Allow background activity so the scheduled sync
              can run.
            </p>
          </li>
          <li>
            <strong>Run the inbox sync</strong>
            <p>
              Run “Sync SMS Inbox To Actual Budget” once. The project then syncs every five minutes.
              It only sends SMS from the bank sender aliases configured for your accounts. Reimport
              the latest project to apply phone-side filtering. It continues from your saved
              checkpoint. New checkpoints default to now; choose an earlier date above to include
              older messages.
            </p>
          </li>
          <li>
            <strong>Make it yours</strong>
            <p>
              Check the SMS inbox and map account or card suffixes. Review unfamiliar messages or
              turn them into templates.
            </p>
          </li>
        </ol>
      </div>
    </section>
    <aside>
      <section class="connection-card">
        <Icon name="shield" size={30} />
        <h3>One phone. One private route.</h3>
        <p>
          The project contains a dedicated credential that can submit messages and sync the inbox.
          Your browser session stays separate.
        </p>
        <div class="info-box">Treat the downloaded XML and Tasker backups as secrets.</div>
      </section>
      <section class="panel">
        <div class="panel-body">
          <h3>Replace Tasker credential</h3>
          <p class="muted">
            This immediately disconnects existing Tasker projects. Download and import a fresh XML
            after replacing it.
          </p>
          <button class="danger" disabled={busy} onclick={rotate}
            ><Icon name="refresh" size={16} />Replace credential</button
          >
        </div>
      </section>
    </aside>
  </div>
{:else}<div class="settings-columns">
    <div>
      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Change password</h2>
            <p>Keep access to your budget personal.</p>
          </div>
          <Icon name="shield" />
        </div>
        <form class="panel-body" onsubmit={changePassword}>
          <label
            >Current password<input
              type="password"
              bind:value={currentPassword}
              autocomplete="current-password"
              required
            /></label
          ><label
            >New password<input
              type="password"
              bind:value={newPassword}
              autocomplete="new-password"
              minlength="8"
              maxlength="200"
              required
            /><small>At least 8 characters. Updating your password signs out other sessions.</small
            ></label
          >
          <div class="form-actions">
            <button class="primary" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button
            >
          </div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Active sessions</h2>
            <p>Devices currently signed in to this workspace.</p>
          </div>
        </div>
        <div class="panel-body">
          {#each sessions as session (session.id)}<div class="session-row">
              <Icon name="shield" size={20} />
              <div>
                <strong
                  >{session.userAgent?.includes('Mobile')
                    ? 'Mobile browser'
                    : 'Web browser'}</strong
                ><small
                  >{session.ipAddress || 'Private connection'} · Last active {when(
                    session.updatedAt,
                  )}<br />Expires {when(session.expiresAt)}</small
                >
              </div>
              <button onclick={() => void revoke(session.token)}>Sign out</button>
            </div>{/each}{#if !sessions.length}<p class="muted">
              No active sessions to display.
            </p>{/if}
        </div>
      </section>
    </div>
    <aside>
      <ActualConnection {catalog} {notify} {refresh} />
      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Hard reset SMS &amp; logs</h2>
            <p>Clear the local inbox and processing history.</p>
          </div>
        </div>
        <div class="panel-body">
          <p class="muted">
            Deletes all stored SMS, queued messages, processing history, AI logs, and
            message-derived balance and transfer data. The Tasker checkpoint moves to now.
          </p>
          <p class="muted small">
            Your password, connections, account mappings, templates, merchant rules, and
            transactions in Actual are retained.
          </p>
          <button class="danger" onclick={() => (resetOpen = true)}
            >Hard reset SMS &amp; logs</button
          >
        </div>
      </section>
    </aside>
  </div>{/if}
{#if resetOpen}<dialog
    class="modal"
    use:modal
    aria-label="Reset SMS and logs"
    onclose={closeReset}
    oncancel={(event) => {
      if (resetBusy) event.preventDefault();
    }}
  >
    <div class="drawer-heading">
      <h2>Reset SMS and logs</h2>
      <button
        class="icon-button"
        aria-label="Close reset dialog"
        disabled={resetBusy}
        onclick={closeReset}><Icon name="close" /></button
      >
    </div>
    <form class="panel-body" onsubmit={resetSmsData}>
      <p>
        This permanently clears sms2actual’s SMS records and processing logs. Tasker will continue
        from the reset time. Your settings and Actual transactions are retained.
      </p>
      {#if resetError}<div class="error" role="alert">{resetError}</div>{/if}
      <label
        >Type RESET to confirm<input
          bind:value={resetConfirmation}
          pattern="RESET"
          required
          autocomplete="off"
          spellcheck={false}
          disabled={resetBusy}
        /></label
      >
      <div class="form-actions">
        <button type="button" onclick={closeReset} disabled={resetBusy}>Cancel</button>
        <button class="danger" disabled={resetBusy || resetConfirmation !== 'RESET'}
          >{resetBusy ? 'Resetting…' : 'Permanently reset SMS and logs'}</button
        >
      </div>
    </form>
  </dialog>{/if}
