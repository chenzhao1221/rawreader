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
  })

  async function save(patch: Parameters<typeof saveConfig>[0]): Promise<void> {
    error = (await saveConfig(patch)) ? null : t.settings.invalid
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
    <Row label={t.bridge.startHidden} detail={t.bridge.startHiddenDetail}>
      <Toggle label={t.bridge.startHidden} checked={config.bridge.startHidden} onchange={(v) => save({ bridge: { startHidden: v } })} />
    </Row>
  </Group>

  <Group>
    <Row label={t.bridge.status} detail={status?.state === 'error' ? `${status.error ?? ''} ${t.bridge.errorDetail}` : undefined} tone={status?.state === 'error' ? 'bad' : undefined}>
      <span class="state">{status ? stateLabel(status) : ''}</span>
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
  .state {
    color: var(--text-dim);
  }
  .error {
    color: var(--bad);
  }
</style>