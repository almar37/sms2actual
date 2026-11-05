<script lang="ts">
  import { untrack } from 'svelte';
  import { api, when } from './api.js';
  import Icon from './Icon.svelte';
  let {
    catalog,
    notify,
    tasker,
  }: { catalog: any; notify: (message: string) => void; tasker: boolean } = $props();
  let url = $state(untrack(() => catalog.publicUrl)),
    busy = $state(false),
    error = $state(''),
    sessions = $state<any[]>([]),
    currentPassword = $state(''),
    newPassword = $state(''),
    taskerApiKey = $state(''),
    revealingKey = $state(false);
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
    if (!tasker) {
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
              and select sms2actual.prj.xml.
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
              Your first sync starts with the last seven days.
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
      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Actual server connection</h2>
            <p>The address sms2actual uses to connect to Actual.</p>
          </div>
        </div>
        <div class="panel-body">
          <label for="actual-server-address">Local Actual server address</label>
          <input
            id="actual-server-address"
            type="url"
            value={catalog.actualServerUrl ?? ''}
            readonly
            aria-describedby="actual-server-help actual-server-config"
          />
          <p id="actual-server-help" class="muted">
            The sms2actual server must be able to reach Actual at this address. Docker addresses
            such as <code>http://actual:5006</code> work when both services share a network. Your browser
            does not need to reach this address.
          </p>
          <p id="actual-server-config" class="muted small">
            This is the configured connection address. To change it, update <code
              >ACTUAL_SERVER_URL</code
            >
            in the service’s <code>.env</code> file and recreate sms2actual.
          </p>
        </div>
      </section>
    </aside>
  </div>{/if}
