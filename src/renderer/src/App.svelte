<script lang="ts">
  import { onMount } from 'svelte'
  import { label, zhCN as t } from './i18n/zh-CN'
  import { go, initStore, navigate, setToggle, store } from './state.svelte'

  let address = $state('')
  let focused = $state(false)
  let addressError = $state<string | null>(null)
  let input: HTMLInputElement | undefined

  const roles = ['ocr', 'translate'] as const

  // Follow the browse view's URL unless the user is typing.
  $effect(() => {
    if (!focused) address = store.browse.url
  })

  onMount(() => initStore())

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    addressError = await navigate(address)
    if (addressError === null) input?.blur()
  }

  const autoTranslate = $derived(store.config?.ui.autoTranslate ?? false)
  const overlayVisible = $derived(store.config?.ui.overlayVisible ?? true)
</script>

<div class="shell">
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
  </form>

  <!-- The browse view is a native view laid over this area by the main process. -->
  <main class="content">
    {#if store.browse.url === ''}
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
      <span class="note">{t.status.pipelinePlaceholder}</span>
    {/if}
    <span class="spacer"></span>
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

  /* Row heights must match TOOLBAR_HEIGHT and STATUS_HEIGHT in src/shared/constants.ts. */
  .shell {
    display: grid;
    grid-template-rows: 48px 1fr 24px;
    height: 100%;
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
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40vw;
  }
  .message {
    color: #e8c46a;
  }
</style>
