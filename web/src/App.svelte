<script lang="ts">
  import { onMount } from 'svelte';
  import { api, setUnauthorizedHandler } from './api.js';
  import Icon from './Icon.svelte';
  import { modal } from './modal.js';
  let menuOpen = $state(false);
  import Overview from './Overview.svelte';
  import SmsLog from './SmsLog.svelte';
  import Accounts from './Accounts.svelte';
  import Merchants from './Merchants.svelte';
  import Templates from './Templates.svelte';
  import AiSettings from './AiSettings.svelte';
  import Settings from './Settings.svelte';
  import ActualConnection from './ActualConnection.svelte';
  let loading = $state(true),
    signedIn = $state(false),
    setup = $state(false),
    requiresApiKey = $state(true),
    busy = $state(false),
    error = $state('');
  let password = $state(''),
    apiKey = $state('');
  let page = $state(location.hash.slice(1) || 'overview'),
    catalog = $state<any>(null),
    toast = $state('');
  let theme = $state(
    localStorage.getItem('sms2actual-theme') ??
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );
  const navigation = [
    { id: 'overview', label: 'Overview', icon: 'overview' },
    { id: 'sms', label: 'SMS inbox', icon: 'sms' },
    { id: 'accounts', label: 'Accounts & cards', icon: 'accounts' },
    { id: 'merchants', label: 'Merchants', icon: 'merchants' },
    { id: 'templates', label: 'Message templates', icon: 'templates' },
    { id: 'ai', label: 'AI categorization', icon: 'ai' },
    { id: 'tasker', label: 'Tasker connection', icon: 'tasker' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];
  const current = $derived(navigation.find((n) => n.id === page) ?? navigation[0]!);
  $effect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('sms2actual-theme', theme);
  });
  let toastTimer: ReturnType<typeof setTimeout>;
  function notify(message: string) {
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 4500);
  }
  function navigate(id: string) {
    menuOpen = false;
    page = id;
    location.hash = id;
  }
  async function refreshCatalog() {
    catalog = await api('/api/console/settings');
  }
  async function initialize() {
    try {
      const status = await api('/api/console/setup');
      setup = status.needsSetup;
      requiresApiKey = status.requiresApiKey !== false;
      if (!setup) {
        const session = await api('/api/auth/get-session');
        signedIn = Boolean(session?.user);
        if (signedIn) await refreshCatalog();
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  async function login(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      if (setup) {
        await api('/api/console/setup', { password, apiKey });
        setup = false;
        apiKey = '';
      }
      await api('/api/auth/sign-in/password', { password });
      signedIn = true;
      password = '';
      await refreshCatalog();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function logout() {
    try {
      await api('/api/auth/sign-out', {});
      menuOpen = false;
      signedIn = false;
      catalog = null;
    } catch (e) {
      notify((e as Error).message);
    }
  }
  onMount(() => {
    setUnauthorizedHandler(() => {
      menuOpen = false;
      signedIn = false;
    });
    void initialize();
    const connectionTimer = setInterval(() => {
      if (signedIn && catalog?.connection?.connecting) void refreshCatalog().catch(() => {});
    }, 2000);
    const desktop = matchMedia('(min-width: 721px)');
    const closeMobileMenu = () => {
      if (desktop.matches) menuOpen = false;
    };
    desktop.addEventListener('change', closeMobileMenu);
    const hash = () => (page = location.hash.slice(1) || 'overview');
    window.addEventListener('hashchange', hash);
    return () => {
      desktop.removeEventListener('change', closeMobileMenu);
      clearTimeout(toastTimer);
      clearInterval(connectionTimer);
      window.removeEventListener('hashchange', hash);
    };
  });
</script>

<svelte:head
  ><title>{signedIn ? current.label : setup ? 'Welcome' : 'Sign in'} · sms2actual</title
  ></svelte:head
>
{#if loading}
  <main class="auth-page">
    <img src="/logo.svg" alt="" width="56" height="56" />
    <p>Getting everything in sync…</p>
  </main>
{:else if !signedIn}
  <main class="auth-page">
    <button
      class="theme-toggle auth-theme"
      aria-label="Toggle color theme"
      onclick={() => (theme = theme === 'dark' ? 'light' : 'dark')}
      ><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button
    >
    <div class="auth-brand">
      <img src="/logo.svg" alt="" width="52" height="52" /><span
        >sms<span class="brand-two">2</span>actual</span
      >
    </div>
    <form class="auth-card" onsubmit={login}>
      <span class="eyebrow">YOUR MONEY, IN SYNC</span>
      <h1>{setup ? 'Make yourself at home.' : 'Welcome back.'}</h1>
      <p class="muted">
        {setup
          ? 'Choose a password for your private workspace.'
          : 'Enter your password to open your workspace.'}
      </p>
      {#if error}<div class="error" role="alert">{error}</div>{/if}
      <label
        >Password<input
          type="password"
          bind:value={password}
          autocomplete={setup ? 'new-password' : 'current-password'}
          minlength="8"
          maxlength="200"
          required
        /></label
      >
      {#if setup && requiresApiKey}<label
          >API key<input type="password" bind:value={apiKey} autocomplete="off" required /><small
            >The API_KEY in your service’s .env file. Used once to create the owner.</small
          ></label
        >{/if}
      <button class="primary wide" disabled={busy}
        >{busy ? 'Connecting…' : setup ? 'Create workspace' : 'Sign in'}<Icon
          name="arrow"
          size={18}
        /></button
      >
      <div class="auth-foot">
        <Icon name="shield" size={15} /> Private by design. Connected to your own Actual Budget.
      </div>
    </form>
    <p class="auth-tagline">A little less admin. A little more life.</p>
  </main>
{:else}
  <div class="app-shell">
    {#snippet sidebarContent()}
      <a class="brand" href="#overview" onclick={() => navigate('overview')}
        ><img src="/logo.svg" alt="" width="35" height="35" /><span
          >sms<span class="brand-two">2</span>actual</span
        ></a
      >
      <div class="workspace-label">
        <span class="workspace-avatar">P</span>
        <div>
          Personal workspace<small
            >{catalog?.connection?.connected === false
              ? 'Setup in progress'
              : 'Actual Budget connected'}</small
          >
        </div>
        <span class="connection-dot"></span>
      </div>
      <div class="nav-caption">WORKSPACE</div>
      <nav aria-label="Main navigation">
        {#each navigation.slice(0, 6) as item (item.id)}<a
            href={'#' + item.id}
            class:active={page === item.id}
            onclick={() => navigate(item.id)}
            ><Icon name={item.icon} /><span>{item.label}</span>{#if page === item.id}<span
                class="nav-dot"
              ></span>{/if}</a
          >{/each}
      </nav>
      <div class="nav-caption connections-label">CONNECTIONS</div>
      <nav aria-label="Connections">
        {#each navigation.slice(6) as item (item.id)}<a
            href={'#' + item.id}
            class:active={page === item.id}
            onclick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span></a
          >{/each}
      </nav>
      <div class="sidebar-bottom">
        <div class="sync-note">
          <span class="connection-dot"></span><span
            >Made for your Actual life.<small>sms2actual · v1.0</small></span
          >
        </div>
        <div class="sidebar-actions">
          <button onclick={() => (theme = theme === 'dark' ? 'light' : 'dark')}
            ><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />{theme === 'dark'
              ? 'Light mode'
              : 'Dark mode'}</button
          ><button class="icon-button" aria-label="Sign out" onclick={logout}
            ><Icon name="logout" size={18} /></button
          >
        </div>
      </div>
    {/snippet}
    <aside class="sidebar">{@render sidebarContent()}</aside>
    {#if menuOpen}
      <dialog
        class="mobile-sidebar"
        aria-label="Workspace navigation"
        use:modal
        onclose={() => (menuOpen = false)}
      >
        <button
          class="menu-close icon-button"
          aria-label="Close menu"
          onclick={() => (menuOpen = false)}><Icon name="close" /></button
        >
        {@render sidebarContent()}
      </dialog>
    {/if}
    <div class="main-shell">
      <main class="content">
        <button
          class="mobile-menu"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onclick={() => (menuOpen = true)}><Icon name="menu" size={18} /> Menu</button
        >
        {#if error}<div class="error" role="alert">
            {error}<button
              onclick={() => {
                error = '';
                void refreshCatalog();
              }}>Try again</button
            >
          </div>{/if}
        {#if catalog}
          {#if catalog.connection && !catalog.connection.connected && !['settings', 'tasker'].includes(page)}
            <div class="page-heading">
              <div>
                <span class="eyebrow">LET’S CONNECT YOUR BUDGET</span>
                <h1>Welcome to your workspace<span class="green">.</span></h1>
                <p>Connect Actual, map your accounts, then download your Tasker project.</p>
              </div>
            </div>
            <ActualConnection {catalog} {notify} refresh={refreshCatalog} />
            <button onclick={() => refreshCatalog().catch((e) => (error = e.message))}
              >Refresh connection status</button
            >
          {:else}
            {#if catalog.connection && !catalog.connection.connected}<div class="info-box">
                Actual is not connected. Messages stay queued until you connect your budget in
                Settings.
              </div>
            {:else if catalog.connection && !catalog.connection.ready}<div class="info-box">
                Your budget is connected. Choose an account and a Bank Fees category in <button
                  class="text-button"
                  onclick={() => navigate('accounts')}>Accounts &amp; cards</button
                > to start importing. Messages stay queued until setup is complete.
              </div>{/if}
            {#if page === 'overview'}<Overview
                {catalog}
                {navigate}
                {notify}
                refresh={refreshCatalog}
              />
            {:else if page === 'sms'}<SmsLog {catalog} {notify} {navigate} />
            {:else if page === 'accounts'}<Accounts {catalog} {notify} refresh={refreshCatalog} />
            {:else if page === 'merchants'}<Merchants {catalog} {notify} />
            {:else if page === 'templates'}<Templates {catalog} {notify} />
            {:else if page === 'ai'}<AiSettings {catalog} {notify} />
            {:else}<Settings
                {catalog}
                {notify}
                refresh={refreshCatalog}
                tasker={page === 'tasker'}
              />{/if}
          {/if}
        {:else}<div class="empty">
            <Icon name="refresh" size={32} />
            <h2>Connecting to your budget</h2>
            <p>Loading accounts and categories from Actual.</p>
            <button onclick={() => refreshCatalog().catch((e) => (error = e.message))}
              >Retry connection</button
            >
          </div>{/if}
      </main>
      <footer class="page-footer">
        <span>From a message to a little peace of mind.</span><span
          >sms2actual <span class="footer-star">✳</span></span
        >
      </footer>
    </div>
  </div>
{/if}
{#if toast}<div class="toast" role="status">
    <Icon name="check" size={18} />{toast}<button
      class="icon-button"
      aria-label="Dismiss notification"
      onclick={() => (toast = '')}><Icon name="close" size={16} /></button
    >
  </div>{/if}
