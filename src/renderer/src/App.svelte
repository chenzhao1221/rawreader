<script lang="ts">
  import { onMount } from 'svelte'
  import appIcon from './assets/app-icon.png'
  import { label, zhCN as t } from './i18n/zh-CN'
  import SettingsPanel from './settings/SettingsPanel.svelte'
  import SetupWizard from './setup/SetupWizard.svelte'
  import Toggle from './ui/Toggle.svelte'
  import { activateTab, closeSettings, closeTab, go, initStore, navigate, newTab, openLogs, openSettings, setToggle, store, webBarAction } from './state.svelte'

  let address = $state('')
  let focused = $state(false)
  let addressError = $state<string | null>(null)
  let input: HTMLInputElement | undefined

  const roles = ['ocr', 'translate'] as const
  const shortRole: Record<(typeof roles)[number], string> = { ocr: t.status.ocrShort, translate: t.status.translateShort }

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

  /** Colour of the small dot next to each server name. */
  function statusTone(role: (typeof roles)[number]): string {
    const state = store.llama[role]?.state
    if (state === 'ready') return 'good'
    if (state === 'error') return 'bad'
    if (state === 'starting' || state === 'stopping') return 'busy'
    return ''
  }

  /** The full "文字识别：就绪" wording lives in the tooltip; the bar itself stays short. */
  function statusTitle(role: (typeof roles)[number]): string {
    const status = store.llama[role]
    const name = label.serverRole(role)
    if (!status) return `${name}：…`
    const text = status.errorCode ? label.llamaError(status.errorCode) : label.serverState(status.state)
    return status.message ? `${name}：${text} · ${status.message}` : `${name}：${text}`
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
    <button
      type="button"
      class="icon-btn"
      disabled={!store.browse.canGoBack}
      onclick={() => go('back')}
      title={t.toolbar.back}
      aria-label={t.toolbar.back}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
    </button>
    <button
      type="button"
      class="icon-btn"
      disabled={!store.browse.canGoForward}
      onclick={() => go('forward')}
      title={t.toolbar.forward}
      aria-label={t.toolbar.forward}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
    </button>
    {#if store.browse.loading}
      <button type="button" class="icon-btn" onclick={() => go('stop')} title={t.toolbar.stop} aria-label={t.toolbar.stop}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    {:else}
      <button type="button" class="icon-btn" onclick={() => go('reload')} title={t.toolbar.reload} aria-label={t.toolbar.reload}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M12.9 6.4A5 5 0 1 0 13 8" />
          <path d="M12.9 2.9v3.5h-3.5" />
        </svg>
      </button>
    {/if}

    <input
      bind:this={input}
      class="ui-input address"
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

    <span class="switch">
      <span class="switch-label">{t.toolbar.autoTranslate}</span>
      <Toggle label={t.toolbar.autoTranslate} checked={autoTranslate} onchange={(next) => void setToggle('autoTranslate', next)} />
    </span>
    <span class="switch">
      <span class="switch-label">{t.toolbar.overlayVisible}</span>
      <Toggle label={t.toolbar.overlayVisible} checked={overlayVisible} onchange={(next) => void setToggle('overlayVisible', next)} />
    </span>
    <button
      type="button"
      class="icon-btn"
      class:active={store.panelOpen && store.tab === 'history'}
      title={t.toolbar.history}
      aria-label={t.toolbar.history}
      onclick={() => openSettings('history')}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2.2 1.3" /></svg>
    </button>
    <button
      type="button"
      class="icon-btn"
      class:active={store.panelOpen}
      aria-pressed={store.panelOpen}
      title={t.toolbar.settings}
      aria-label={t.toolbar.settings}
      onclick={() => (store.panelOpen ? closeSettings() : openSettings())}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3.2" />
        <path
          d="M12.4 8h1.2M3.6 8H2.4M8 3.6V2.4M8 12.4v1.2M11.11 4.89l.85-.85M4.89 11.11l-.85.85M4.89 4.89l-.85-.85M11.11 11.11l.85.85"
        />
      </svg>
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
        <button type="button" class="ui-btn small primary" onclick={() => webBarAction('translate')}>{t.webBar.translate}</button>
        <button type="button" class="ui-btn small ghost" onclick={() => webBarAction('always')}>{t.webBar.always(lang)}</button>
        <button type="button" class="ui-btn small ghost" onclick={() => webBarAction('never-lang')}>{t.webBar.neverLang(lang)}</button>
        <button type="button" class="ui-btn small ghost" onclick={() => webBarAction('never-site')}>{t.webBar.neverSite}</button>
      {:else if store.webBar.state === 'translating'}
        <span class="webbar-text">{t.webBar.translating}</span>
        <button type="button" class="ui-btn small ghost" onclick={() => webBarAction('restore')}>{t.webBar.showOriginal}</button>
      {:else if store.webBar.state === 'translated'}
        <span class="webbar-text">{t.webBar.translated}</span>
        <button type="button" class="ui-btn small ghost" onclick={() => webBarAction('restore')}>{t.webBar.showOriginal}</button>
        <button type="button" class="ui-btn small ghost" onclick={() => webBarAction('never-site')}>{t.webBar.neverSite}</button>
      {:else}
        <span class="webbar-text error">{t.webBar.error}</span>
        <button type="button" class="ui-btn small ghost" onclick={() => webBarAction('translate')}>{t.webBar.retry}</button>
      {/if}
      <span class="spacer"></span>
      <button type="button" class="ui-btn small ghost webbar-close" title={t.webBar.close} aria-label={t.webBar.close} onclick={() => webBarAction('dismiss')}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </div>
  {/if}
  </div>

  <!-- The browse view is a native view laid over this area by the main process. -->
  <main class="content">
    {#if store.panelOpen}
      {#if store.wizardOpen}
        <SetupWizard />
      {:else}
        <SettingsPanel />
      {/if}
    {:else if store.browse.url === ''}
      <p class="hint">{t.browse.emptyHint}</p>
    {/if}
  </main>

  <footer class="statusbar">
    <span class="servers">
      {#each roles as role (role)}
        <span class="server" title={statusTitle(role)}>
          <span class="ui-dot {statusTone(role)}"></span>
          {shortRole[role]}
        </span>
      {/each}
    </span>
    {#if autoTranslate}
      <span class="note">{t.status.progress}：{store.progress.done}/{store.progress.total}{#if store.progress.failed > 0}（{t.status.failed} {store.progress.failed}）{/if}</span>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="ui-btn small ghost link" onclick={openLogs}>{t.status.openLogs}</button>
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
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: var(--text-m);
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
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: var(--text-m);
  }

  svg {
    display: block;
    width: 16px;
    height: 16px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .webbar {
    display: flex;
    align-items: center;
    gap: var(--gap-s);
    height: 36px;
    box-sizing: border-box;
    padding: 0 10px;
    background: var(--accent-soft);
    color: var(--text);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
  }
  .webbar-icon {
    font-weight: 700;
    color: var(--accent);
  }
  .webbar-text.error {
    color: var(--bad);
  }
  .webbar .ui-btn.webbar-close {
    min-width: 26px;
    padding: 0;
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
    background: var(--bg);
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
    color: var(--text-dim);
    background: var(--surface-2);
    border-radius: var(--radius) var(--radius) 0 0;
    cursor: default;
    user-select: none;
  }
  .tab:hover {
    background: var(--surface-3);
  }
  .tab.active {
    color: var(--text);
    background: var(--surface);
  }
  .tab-title {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--text-s);
  }
  .tab-close {
    height: 20px;
    min-width: 20px;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: 50%;
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .tab-close:hover {
    background: var(--surface-3);
  }
  .tab-new {
    height: 26px;
    min-width: 26px;
    margin: 0 0 1px 2px;
    padding: 0;
    color: var(--text-dim);
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    font: inherit;
    cursor: pointer;
  }
  .tab-new:hover {
    color: var(--text);
    background: var(--surface-3);
  }
  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid var(--accent);
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
    padding: 0 var(--gap-s);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    min-width: 32px;
    padding: 0;
    color: var(--text-dim);
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-3);
  }
  .icon-btn.active {
    color: var(--text);
    background: var(--surface-3);
  }
  .icon-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toolbar .address {
    flex: 1;
    min-width: 120px;
    border-radius: var(--radius-l);
  }
  .toolbar .address.invalid {
    border-color: var(--bad);
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-s);
    white-space: nowrap;
  }
  .switch-label {
    color: var(--text-dim);
    font-size: var(--text-s);
  }

  .content {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }
  .hint {
    color: var(--text-faint);
  }
  .error {
    color: var(--bad);
  }
  .statusbar .error {
    font-weight: 600;
  }

  .statusbar {
    display: flex;
    align-items: center;
    gap: var(--gap);
    padding: 0 10px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    color: var(--text-dim);
    font-size: var(--text-s);
    white-space: nowrap;
    overflow: hidden;
  }
  .servers {
    display: flex;
    gap: var(--gap);
  }
  .server {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-xs);
  }
  .spacer {
    flex: 1;
  }
  .statusbar .ui-btn.link {
    height: 20px;
    min-width: 0;
    padding: 0 6px;
    font-size: var(--text-s);
    text-decoration: underline;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40vw;
  }
  .message {
    color: var(--warn);
  }
</style>
