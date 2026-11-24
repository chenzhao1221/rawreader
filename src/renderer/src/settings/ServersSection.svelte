<script lang="ts">
  import type { Config } from '../../../shared/config/schema'
  import type { Backend } from '../../../shared/config/schema'
  import type { ServerRole } from '../../../shared/ipc/contract'
  import { shouldOfferVulkanFallback } from '../../../shared/llama/fallback'
  import { cudaLabel, formatBytes, label, zhCN as t } from '../i18n/zh-CN'
  import { controlServer, cudaDownload, saveConfig, store } from '../state.svelte'
  import Group from '../ui/Group.svelte'
  import Row from '../ui/Row.svelte'
  import Segmented from '../ui/Segmented.svelte'
  import Toggle from '../ui/Toggle.svelte'

  interface ServerForm {
    port: number
    ctxSize: number
    nGpuLayers: number
    parallel: number
    flashAttn: 'on' | 'off' | 'auto'
    alias: string
    extraArgs: string
    autostart: boolean
    temp: number
    reasoning: 'on' | 'off'
  }

  function toForm(config: Config, role: ServerRole): ServerForm {
    const server = config.llama[role]
    return {
      port: server.port,
      ctxSize: server.ctxSize,
      nGpuLayers: server.nGpuLayers,
      parallel: server.parallel,
      flashAttn: server.flashAttn,
      alias: server.alias,
      extraArgs: server.extraArgs.join(' '),
      autostart: server.autostart,
      temp: config.llama.translate.temp,
      reasoning: config.llama.translate.reasoning,
    }
  }

  const roles = ['ocr', 'translate'] as const
  let forms = $state<Record<ServerRole, ServerForm> | null>(null)
  let customDir = $state('')
  let message = $state<{ text: string; ok: boolean } | null>(null)

  // Reload the form whenever the stored config changes (including after our own save).
  $effect(() => {
    const config = store.config
    if (!config) return
    forms = { ocr: toForm(config, 'ocr'), translate: toForm(config, 'translate') }
    customDir = config.llama.binDirs.custom ?? ''
  })

  const backend = $derived(store.config?.llama.backend ?? 'vulkan')
  const statuses = $derived(roles.map((r) => store.llama[r]).filter((s) => s !== null))
  const offerFallback = $derived(shouldOfferVulkanFallback(backend, statuses))
  const cuda = $derived(store.cuda)
  const cudaBusy = $derived(cuda !== null && ['checking', 'downloading', 'extracting'].includes(cuda.state))
  /** The user picked CUDA but it is not installed yet. */
  let wantsCuda = $state(false)
  let wantsCustom = $state(false)
  const shownBackend = $derived<Backend>(wantsCuda ? 'cuda' : wantsCustom ? 'custom' : backend)

  async function save(role: ServerRole): Promise<void> {
    const form = forms?.[role]
    if (!form) return
    const common = {
      port: form.port,
      ctxSize: form.ctxSize,
      nGpuLayers: form.nGpuLayers,
      parallel: form.parallel,
      flashAttn: form.flashAttn,
      alias: form.alias,
      extraArgs: form.extraArgs.split(/\s+/).filter((a) => a.length > 0),
      autostart: form.autostart,
    }
    const patch = role === 'ocr' ? { llama: { ocr: common } } : { llama: { translate: { ...common, temp: form.temp, reasoning: form.reasoning } } }
    const ok = await saveConfig(patch)
    message = { text: ok ? t.settings.saved : t.settings.invalid, ok }
  }

  async function chooseBackend(next: Backend): Promise<void> {
    wantsCuda = false
    wantsCustom = false
    if (next === 'cuda' && !cuda?.installed) {
      wantsCuda = true
      return
    }
    if (next === 'custom') {
      if (customDir.trim() === '') {
        wantsCustom = true
        return
      }
      const ok = await saveConfig({ llama: { backend: 'custom', binDirs: { custom: customDir.trim() } } })
      message = ok ? null : { text: t.settings.invalid, ok }
      return
    }
    const ok = await saveConfig({ llama: { backend: next } })
    message = ok ? null : { text: t.settings.invalid, ok }
  }

  function cudaPercent(): number {
    if (!cuda || cuda.totalBytes === 0) return 0
    return Math.min(100, Math.round((cuda.receivedBytes / cuda.totalBytes) * 100))
  }

  function statusText(role: ServerRole): string {
    const status = store.llama[role]
    if (!status) return '—'
    const text = status.errorCode ? label.llamaError(status.errorCode) : label.serverState(status.state)
    return status.port ? `${text} · :${status.port}` : text
  }
  function statusDot(role: ServerRole): string {
    const state = store.llama[role]?.state
    return state === 'ready' ? 'good' : state === 'error' ? 'bad' : state === 'starting' ? 'busy' : ''
  }
</script>

{#if offerFallback}
  <div class="banner" role="alert">
    <span>{t.servers.backend.fallbackOffer}</span>
    <button type="button" class="ui-btn small primary" onclick={() => saveConfig({ llama: { backend: 'vulkan' } })}>{t.servers.backend.switchToVulkan}</button>
  </div>
{/if}

<Group>
  <Row label={t.servers.backend.heading}>
    <Segmented
      label={t.servers.backend.heading}
      value={shownBackend}
      options={[
        { value: 'vulkan', label: 'Vulkan' },
        { value: 'cuda', label: 'CUDA' },
        { value: 'custom', label: t.servers.backend.custom },
      ]}
      onchange={chooseBackend}
    />
  </Row>
  {#if shownBackend === 'custom'}
    <Row label={t.servers.backend.customDir}>
      <input class="ui-input mono path-input" bind:value={customDir} spellcheck="false" placeholder="D:\llama.cpp\bin" />
      <button type="button" class="ui-btn small" onclick={() => chooseBackend('custom')}>{t.settings.apply}</button>
    </Row>
  {/if}
  {#if shownBackend === 'cuda' || cudaBusy || cuda?.state === 'error'}
    <Row
      label="CUDA"
      detail={cuda?.state === 'error'
        ? cudaLabel.error(cuda.errorCode)
        : cudaBusy && cuda
          ? `${formatBytes(cuda.receivedBytes)} / ${formatBytes(cuda.totalBytes)}`
          : cuda?.installed
            ? undefined
            : t.servers.backend.cudaSize}
      tone={cuda?.state === 'error' ? 'bad' : undefined}
    >
      {#if cudaBusy}
        <div class="ui-bar cuda-bar"><div style="width: {cudaPercent()}%"></div></div>
        <button type="button" class="ui-btn small ghost" onclick={() => cudaDownload('cancel')}>{t.servers.backend.cudaCancel}</button>
      {:else if cuda?.installed}
        <span class="ui-chip good">{cudaLabel.state(cuda.state)}</span>
      {:else}
        <button type="button" class="ui-btn small primary" onclick={() => cudaDownload('start')}>{t.servers.backend.cudaDownload}</button>
      {/if}
    </Row>
  {/if}
</Group>

{#if forms}
  {#each roles as role (role)}
    {@const form = forms[role]}
    <Group title={label.serverRole(role)}>
      {#snippet actions()}
        <button type="button" class="ui-btn small ghost" onclick={() => controlServer(role, 'start')}>{t.servers.start}</button>
        <button type="button" class="ui-btn small ghost" onclick={() => controlServer(role, 'stop')}>{t.servers.stop}</button>
        <button type="button" class="ui-btn small ghost" onclick={() => controlServer(role, 'restart')}>{t.servers.restart}</button>
      {/snippet}
      <div class="status">
        <span class="ui-dot {statusDot(role)}"></span>
        <span>{statusText(role)}</span>
        <span class="spacer"></span>
        <span class="auto">{t.servers.fields.autostart}</span>
        <Toggle label={t.servers.fields.autostart} checked={form.autostart} onchange={(v) => (form.autostart = v)} />
      </div>
      <div class="fields">
        <label><span>{t.servers.fields.port}</span><input class="ui-input" type="number" min="1024" max="65535" bind:value={form.port} /></label>
        <label><span>{t.servers.fields.ctxSize}</span><input class="ui-input" type="number" min="256" bind:value={form.ctxSize} /></label>
        <label><span>{t.servers.fields.nGpuLayers}</span><input class="ui-input" type="number" min="0" bind:value={form.nGpuLayers} /></label>
        <label><span>{t.servers.fields.parallel}</span><input class="ui-input" type="number" min="1" bind:value={form.parallel} /></label>
        <label>
          <span>{t.servers.fields.flashAttn}</span>
          <select class="ui-select" bind:value={form.flashAttn}>
            <option value="auto">{t.servers.flashAttn.auto}</option>
            <option value="on">{t.servers.flashAttn.on}</option>
            <option value="off">{t.servers.flashAttn.off}</option>
          </select>
        </label>
        <label><span>{t.servers.fields.alias}</span><input class="ui-input" bind:value={form.alias} /></label>
        {#if role === 'translate'}
          <label><span>{t.servers.fields.temp}</span><input class="ui-input" type="number" min="0" max="2" step="0.1" bind:value={form.temp} /></label>
          <label>
            <span>{t.servers.fields.reasoning}</span>
            <select class="ui-select" bind:value={form.reasoning}>
              <option value="off">{t.servers.reasoning.off}</option>
              <option value="on">{t.servers.reasoning.on}</option>
            </select>
          </label>
        {/if}
        <label class="wide"><span>{t.servers.fields.extraArgs}</span><input class="ui-input mono" bind:value={form.extraArgs} spellcheck="false" /></label>
      </div>
      <div class="apply">
        <button type="button" class="ui-btn primary small" onclick={() => save(role)}>{t.servers.applyRestart}</button>
      </div>
    </Group>
  {/each}
{/if}

{#if message}<p class={message.ok ? 'ok' : 'error'} role="status">{message.text}</p>{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: var(--gap);
    margin-bottom: var(--gap-l);
    padding: 10px 16px;
    color: var(--bad);
    background: var(--bad-soft);
    border-radius: var(--radius);
  }
  .banner span {
    flex: 1;
  }
  .path-input {
    width: 260px;
  }
  .cuda-bar {
    width: 160px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--gap-s);
    padding: 12px 16px;
  }
  .spacer {
    flex: 1;
  }
  .auto {
    color: var(--text-dim);
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--gap) var(--gap);
    padding: 14px 16px;
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .fields label > span {
    color: var(--text-dim);
    font-size: var(--text-s);
  }
  .fields .ui-input,
  .fields .ui-select {
    width: 100%;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .apply {
    display: flex;
    justify-content: flex-end;
    padding: 10px 16px;
  }
  .ok {
    color: var(--good);
  }
  .error {
    color: var(--bad);
  }
</style>
