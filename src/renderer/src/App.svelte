<script lang="ts">
  import { onMount } from 'svelte'
  import appIcon from './assets/app-icon.png'
  import { label, zhCN as t } from './i18n/zh-CN'
  import SettingsPanel from './settings/SettingsPanel.svelte'
  import { activateTab, closeSettings, closeTab, go, initStore, navigate, newTab, openLogs, openSettings, setToggle, store, webBarAction } from './state.svelte'

  let address = $state('')
  let focused = $state(false)
  let addressError = $state<string | null>(null)
  let input: HTMLInputElement | undefined

  const roles = ['ocr', 'translate'] as const

  // Follow the browse view's URL unless the user is typing.
  $effect(() => {
    if (!focused) address = store.browse.url
  })

  onMount(() =>
    initStore(() => {
      if (store.panelOpen) closeSettings()
      input?.focus()
      input?.select()
    }),
  )

  function tabLabel(tab: { title: string; url: string }): string {
    if (tab.title) return tab.title
    if (!tab.url) return t.tabs.untitled
    try {
      return new URL(tab.url).host
    } catch {
      return tab.url
    }
  }

  function onTabMouseDown(event: MouseEvent, id: number): void {
    // Middle click closes, like in a normal browser.
    if (event.button === 1) {
      event.preventDefault()
      closeTab(id)
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    addressError = await navigate(address)
    if (addressError === null) input?.blur()
  }

  const autoTranslate = $derived(store.config?.ui.autoTranslate ?? false)
  const overlayVisible = $derived(store.config?.ui.overlayVisible ?? true)
</script>

<div class="shell">
  <div class="tabstrip" role="tablist">
    <img class="app-icon" src={appIcon} alt="" aria-hidden="true" />
    {#each store.tabs.tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === store.tabs.activeId}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === store.tabs.activeId}
        title={tab.url || tabLabel(tab)}
        onclick={() => activateTab(tab.id)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') activateTab(tab.id)
        }}
        onmousedown={(e) => onTabMouseDown(e, tab.id)}
      >
        {#if tab.loading}<span class="spinner" aria-hidden="true"></span>{/if}
        <span class="tab-title">{tabLabel(tab)}</span>
        <button
          type="button"
          class="tab-close"
          title={t.tabs.close}
          aria-label={t.tabs.close}
          onclick={(e) => {
            e.stopPropagation()
            closeTab(tab.id)
          }}>×</button
        >
      </div>
    {/each}
    <button type="button" class="tab-new" title={t.tabs.newTab} aria-label={t.tabs.newTab} onclick={newTab}>＋</button>
  </div>

  <form class="toolbar" onsubmit={submit}>
    <button type="button" disabled={!store.browse.canGoBack} onclick={() => go('back')} title={t.toolbar.back} aria-label={t.toolbar.back}>←</button>
    <button type="button" disabled={!store.browse.canGoForward} onclick={() => go('forward')} title={t.toolbar.forward} aria-label={t.toolbar.forward}>→</button>
    {#if store.browse.loading}
      <button type="button" onclick={() => go('stop')} title={t.toolbar.stop} aria-label={t.toolbar.stop}>✕</button>
    {:else}
      <button type="button" onclick={() => go('reload')} title={t.toolbar.reload} aria-label={t.toolbar.reload}>⟳</button>
    {/if}

    <input
      bind:this={input}
      class="address"
      class:invalid={addressError !== null}
      type="text"
      spellcheck="false"
      autocomplete="off"
      aria-label={t.toolbar.addressLabel}
      placeholder={t.toolbar.addressPlaceholder}
      bind:value={address}
      onfocus={(e) => {
        focused = true
        addressError = null
        e.currentTarget.select()
      }}
      onblur={() => (focused = false)}
    />

    <button
      type="button"
      class="toggle"
      role="switch"
      aria-checked={autoTranslate}
      onclick={() => setToggle('autoTranslate', !autoTranslate)}
    >
      <span class="knob" class:on={autoTranslate}></span>{t.toolbar.autoTranslate}
    </button>
    <button
      type="button"
      class="toggle"
      role="switch"
      aria-checked={overlayVisible}
      onclick={() => setToggle('overlayVisible', !overlayVisible)}
    >
      <span class="knob" class:on={overlayVisible}></span>{t.toolbar.overlayVisible}
    </button>
    <button
      type="button"
      class="settings"
      aria-pressed={store.panelOpen}
      onclick={() => (store.panelOpen ? closeSettings() : openSettings())}
    >
      {t.toolbar.settings}
    </button>
  </form>

  <!-- Always present so the grid rows stay in place; empty while the bar is hidden. -->
  <div class="webbar-row">
  {#if store.webBar.state !== 'hidden'}
    {@const lang = label.language(store.webBar.lang)}
    <div class="webbar" role="status">
      <span class="webbar-icon" aria-hidden="true">文A</span>
      {#if store.webBar.state === 'offer'}
        <span class="webbar-text">{t.webBar.offer(lang)}</span>
        <button type="button" class="primary" onclick={() => webBarAction('translate')}>{t.webBar.translate}</button>
        <button type="button" onclick={() => webBarAction('always')}>{t.webBar.always(lang)}</button>
        <button type="button" onclick={() => webBarAction('never-lang')}>{t.webBar.neverLang(lang)}</button>
        <button type="button" onclick={() => webBarAction('never-site')}>{t.webBar.neverSite}</button>
      {:else if store.webBar.state === 'translating'}
        <span class="webbar-text">{t.webBar.translating}</span>
        <button type="button" onclick={() => webBarAction('restore')}>{t.webBar.showOriginal}</button>
      {:else if store.webBar.state === 'translated'}
        <span class="webbar-text">{t.webBar.translated}</span>
        <button type="button" onclick={() => webBarAction('restore')}>{t.webBar.showOriginal}</button>
        <button type="button" onclick={() => webBarAction('never-site')}>{t.webBar.neverSite}</button>
      {:else}
        <span class="webbar-text error">{t.webBar.error}</span>
        <button type="button" onclick={() => webBarAction('translate')}>{t.webBar.retry}</button>
      {/if}
      <span class="spacer"></span>
      <button type="button" class="webbar-close" title={t.webBar.close} aria-label={t.webBar.close} onclick={() => webBarAction('dismiss')}>×</button>
    </div>
  {/if}
  </div>

  <!-- The browse view is a native view laid over this area by the main process. -->
  <main class="content">
    {#if store.panelOpen}
      <SettingsPanel />
    {:else if store.browse.url === ''}
      <p class="hint">{t.browse.emptyHint}</p>
    {/if}
  </main>

  <footer class="statusbar">
    <span class="servers">
      {#each roles as role (role)}
        {@const status = store.llama[role]}
        <span class="server" class:ok={status?.state === 'ready'} class:bad={status?.state === 'error'} title={status?.message ?? ''}>
          {label.serverRole(role)}：{status ? (status.errorCode ? label.llamaError(status.errorCode) : label.serverState(status.state)) : '…'}
        </span>
      {/each}
    </span>
    {#if autoTranslate}
      <span class="note">{t.status.progress}：{store.progress.done}/{store.progress.total}{#if store.progress.failed > 0}（{t.status.failed} {store.progress.failed}）{/if}</span>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="link" onclick={openLogs}>{t.status.openLogs}</button>
    {#if addressError}
      <span class="error" role="alert">{addressError}</span>
    {:else if store.message}
      <span class="message">{store.message}</span>
    {:else if store.browse.loading}
      <span class="note">{t.browse.loading}</span>
    {:else}
      <span class="title">{store.browse.title}</span>
    {/if}
  </footer>
</div>

<style>
  :global(html, body) {
    height: 100%;
    margin: 0;
    background: #1e1f22;
    color: #dfe1e5;
    font-family: 'Microsoft YaHei UI', 'Segoe UI', sans-serif;
    font-size: 13px;
    overflow: hidden;
  }
  :global(#app) {
    height: 100%;
  }

  /* Row heights must match TAB_STRIP_HEIGHT, TOOLBAR_HEIGHT, INFOBAR_HEIGHT and STATUS_HEIGHT in src/shared/constants.ts. */
  .shell {
    display: grid;
    grid-template-rows: 34px 48px auto 1fr 24px;
    height: 100%;
  }

  .webbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    box-sizing: border-box;
    padding: 0 10px;
    background: #24324a;
    color: #dfe1e5;
    border-bottom: 1px solid #34486b;
    white-space: nowrap;
    overflow: hidden;
  }
  .webbar button {
    height: 26px;
  }
  .webbar .primary {
    background: #3d6fd8;
  }
  .webbar .primary:hover {
    background: #4a7de6;
  }
  .webbar-icon {
    font-weight: 700;
    color: #8fb4ff;
  }
  .webbar-text.error {
    color: #ff8f88;
  }
  .webbar-close {
    min-width: 26px;
    padding: 0;
    background: transparent;
    font-size: 16px;
  }

  .tabstrip {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    /* The strip is the window's title bar: drag it to move the window, double-click to maximise. */
    -webkit-app-region: drag;
    /* Leave room on the right for the minimise / maximise / close buttons Windows draws on top. */
    width: env(titlebar-area-width, calc(100vw - 140px));
    box-sizing: border-box;
    padding: 0 6px;
    background: #1e1f22;
    /* With many tabs the strip scrolls instead of pushing the new-tab button out of reach. */
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }
  .tab,
  .tab-new {
    -webkit-app-region: no-drag;
  }
  .app-icon {
    flex: none;
    width: 18px;
    height: 18px;
    margin: 0 6px 5px 2px;
    align-self: flex-end;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 220px;
    min-width: 40px;
    height: 26px;
    box-sizing: border-box;
    padding: 0 4px 0 10px;
    color: #a9acb2;
    background: #26282b;
    border-radius: 8px 8px 0 0;
    cursor: default;
    user-select: none;
  }
  .tab:hover {
    background: #303236;
  }
  .tab.active {
    color: #dfe1e5;
    background: #2b2d30;
  }
  .tab-title {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
  }
  .tab-close {
    height: 20px;
    min-width: 20px;
    padding: 0;
    background: transparent;
    border-radius: 50%;
    font-size: 14px;
    line-height: 1;
  }
  .tab-new {
    height: 26px;
    min-width: 26px;
    margin: 0 0 1px 2px;
    padding: 0;
    background: transparent;
  }
  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid #6b9eff;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex: none;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    background: #2b2d30;
    border-bottom: 1px solid #393b40;
  }
  button {
    height: 30px;
    min-width: 30px;
    padding: 0 8px;
    color: inherit;
    background: #393b40;
    border: 1px solid transparent;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: #45484e;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .address {
    flex: 1;
    min-width: 120px;
    height: 30px;
    box-sizing: border-box;
    padding: 0 10px;
    color: inherit;
    background: #1e1f22;
    border: 1px solid #4e5157;
    border-radius: 15px;
    font: inherit;
    outline: none;
  }
  .address:focus {
    border-color: #6b9eff;
  }
  .address.invalid {
    border-color: #e5534b;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .knob {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #6c6f75;
  }
  .knob.on {
    background: #57c27a;
  }

  .content {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }
  .hint {
    color: #8a8d93;
  }
  .error {
    color: #ff8f88;
  }
  .statusbar .error {
    font-weight: 600;
  }

  .statusbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 10px;
    background: #2b2d30;
    border-top: 1px solid #393b40;
    color: #a9acb2;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
  }
  .servers {
    display: flex;
    gap: 12px;
  }
  .server.ok {
    color: #57c27a;
  }
  .server.bad {
    color: #ff8f88;
  }
  .spacer {
    flex: 1;
  }
  .statusbar .link {
    height: 20px;
    min-width: 0;
    padding: 0 6px;
    color: #a9acb2;
    background: transparent;
    font-size: 12px;
    text-decoration: underline;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40vw;
  }
  .message {
    color: #e8c46a;
  }
</style>
