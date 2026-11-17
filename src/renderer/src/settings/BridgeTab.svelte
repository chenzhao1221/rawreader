<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { BridgeStatus } from '../../../shared/ipc/contract'
  import { zhCN as t } from '../i18n/zh-CN'
  import { saveConfig, store } from '../state.svelte'
  import Group from '../ui/Group.svelte'
  import Row from '../ui/Row.svelte'
  import Toggle from '../ui/Toggle.svelte'

  const config = $derived(store.config)
  let status = $state<BridgeStatus | null>(null)
  /** The pairing code is fetched only on request and dropped when hidden. */
  let code = $state<string | null>(null)
  let copied = $state(false)
  let confirmRegenerate = $state(false)
  let error = $state<string | null>(null)
  let timer: ReturnType<typeof setInterval> | undefined

  async function refresh(): Promise<void> {
    const result = await window.rawreader.invoke('bridge:status')
    if (result.ok) status = result.value
  }

  onMount(() => {
    void refresh()
    timer = setInterval(() => void refresh(), 2000)
  })
  onDestroy(() => {
    if (timer) clearInterval(timer)
    code = null
  })

  async function save(patch: Parameters<typeof saveConfig>[0]): Promise<void> {
    error = (await saveConfig(patch)) ? null : t.settings.invalid
    await refresh()
  }

  async function showCode(): Promise<void> {
    const result = await window.rawreader.invoke('bridge:code')
    if (result.ok) code = result.value.code
  }

  async function copyCode(): Promise<void> {
    if (!code) return
    await navigator.clipboard.writeText(code.replaceAll('-', ''))
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  async function regenerate(): Promise<void> {
    confirmRegenerate = false
    const result = await window.rawreader.invoke('bridge:regenerate')
    if (result.ok) code = result.value.code
    await refresh()
  }

  const stateLabel = (s: BridgeStatus): string => `${t.bridge.state[s.state]}${s.state === 'listening' ? ` 127.0.0.1:${s.port}` : ''}`
</script>

{#if config}
  <p class="intro">{t.bridge.intro}</p>

  <Group>
    <Row label={t.bridge.enable} detail={t.bridge.enableDetail}>
      <Toggle label={t.bridge.enable} checked={config.bridge.enabled} onchange={(v) => save({ bridge: { enabled: v } })} />
    </Row>
    <Row label={t.bridge.port} detail={t.bridge.portDetail}>
      <input
        class="ui-input number"
        type="number"
        min="1024"
        max="65535"
        value={config.bridge.port}
        onchange={(e) => save({ bridge: { port: Number(e.currentTarget.value) } })}
      />
    </Row>
    <Row label={t.bridge.startHidden} detail={t.bridge.startHiddenDetail}>
      <Toggle label={t.bridge.startHidden} checked={config.bridge.startHidden} onchange={(v) => save({ bridge: { startHidden: v } })} />
    </Row>
  </Group>

  <Group>
    <Row label={t.bridge.status} detail={status?.state === 'error' ? `${status.error ?? ''} ${t.bridge.errorDetail}` : undefined} tone={status?.state === 'error' ? 'bad' : undefined}>
      <span class="state">{status ? stateLabel(status) : ''}</span>
    </Row>
    <Row label={t.bridge.code} detail={code ? undefined : t.bridge.codeHidden}>
      {#if code}
        <code class="code">{code}</code>
        <button type="button" class="ui-btn" onclick={copyCode}>{copied ? t.bridge.copied : t.bridge.copy}</button>
        <button type="button" class="ui-btn ghost" onclick={() => (code = null)}>{t.bridge.hide}</button>
      {:else}
        <button type="button" class="ui-btn" onclick={showCode}>{t.bridge.show}</button>
      {/if}
    </Row>
    <Row label={t.bridge.regenerate} detail={t.bridge.regenerateDetail}>
      {#if confirmRegenerate}
        <button type="button" class="ui-btn ghost" onclick={() => (confirmRegenerate = false)}>{t.settings.no}</button>
        <button type="button" class="ui-btn danger" onclick={regenerate}>{t.bridge.regenerateConfirm}</button>
      {:else}
        <button type="button" class="ui-btn danger" onclick={() => (confirmRegenerate = true)}>{t.bridge.regenerate}</button>
      {/if}
    </Row>
    <Row label={t.bridge.extension} detail={config.bridge.extensionId ?? t.bridge.extensionNone}>
      {#if config.bridge.extensionId}<span class="mono">{config.bridge.extensionId.slice(0, 8)}…</span>{/if}
    </Row>
  </Group>

  <p class="how">{t.bridge.howTo}</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
{/if}

<style>
  .intro,
  .how {
    margin: 0 0 var(--gap-l);
    color: var(--text-dim);
    font-size: var(--text-s);
    line-height: 1.6;
  }
  .how {
    margin-top: var(--gap-l);
  }
  .number {
    width: 90px;
  }
  .code,
  .mono {
    font-family: var(--font-mono, monospace);
    letter-spacing: 0.05em;
  }
  .state {
    color: var(--text-dim);
  }
  .error {
    color: var(--bad);
  }
</style>
