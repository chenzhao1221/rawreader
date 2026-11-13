<script lang="ts">
  import type { Config } from '../../../shared/config/schema'
  import type { Backend } from '../../../shared/config/schema'
  import type { ServerRole } from '../../../shared/ipc/contract'
  import { shouldOfferVulkanFallback } from '../../../shared/llama/fallback'
  import { cudaLabel, formatBytes, label, zhCN as t } from '../i18n/zh-CN'
  import { controlServer, cudaDownload, saveConfig, store } from '../state.svelte'

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
  /** The user picked CUDA in the radio group but it is not installed yet. */
  let wantsCuda = $state(false)

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
    if (next === 'cuda' && !cuda?.installed) {
      wantsCuda = true
      return
    }
    if (next === 'custom') {
      if (customDir.trim() === '') return
      const ok = await saveConfig({ llama: { backend: 'custom', binDirs: { custom: customDir.trim() } } })
      message = { text: ok ? t.settings.saved : t.settings.invalid, ok }
      return
    }
    const ok = await saveConfig({ llama: { backend: next } })
    message = { text: ok ? t.settings.saved : t.settings.invalid, ok }
  }

  async function switchToVulkan(): Promise<void> {
    await saveConfig({ llama: { backend: 'vulkan' } })
  }

  function cudaPercent(): number {
    if (!cuda || cuda.totalBytes === 0) return 0
    return Math.min(100, Math.round((cuda.receivedBytes / cuda.totalBytes) * 100))
  }
</script>

<h2>{t.servers.backend.heading}</h2>

{#if offerFallback}
  <div class="row banner">
    <span class="bad">{t.servers.backend.fallbackOffer}</span>
    <button type="button" class="btn primary" onclick={switchToVulkan}>{t.servers.backend.switchToVulkan}</button>
  </div>
{/if}

<div class="row">
  {#each ['vulkan', 'cuda', 'custom'] as const as option (option)}
    <label class="radio">
      <input type="radio" name="backend" value={option} checked={backend === option && !wantsCuda} onchange={() => chooseBackend(option)} />
      {t.servers.backend[option]}
    </label>
  {/each}
</div>

{#if backend === 'custom' || store.config?.llama.backend === 'custom'}
  <label class="field wide">
    <span>{t.servers.backend.customDir}</span>
    <input type="text" bind:value={customDir} />
  </label>
  <div class="row"><button type="button" class="btn" onclick={() => chooseBackend('custom')}>{t.settings.apply}</button></div>
{/if}

{#if wantsCuda || backend === 'cuda' || cudaBusy || cuda?.state === 'error'}
  <div class="cuda">
    <div class="row">
      <strong>CUDA</strong>
      <span class={cuda?.installed ? 'good' : 'muted'}>{cuda ? cudaLabel.state(cuda.state) : ''}</span>
      {#if cuda?.installed}<span class="muted">{t.servers.backend.cudaInstalled}</span>{/if}
    </div>
    {#if !cuda?.installed}
      <p class="warn">{t.servers.backend.cudaNote}</p>
    {/if}
    {#if cudaBusy && cuda}
      <div class="bar"><div class="fill" style="width: {cudaPercent()}%"></div></div>
      <div class="small muted">{formatBytes(cuda.receivedBytes)} / {formatBytes(cuda.totalBytes)} ({cudaPercent()}%)</div>
    {/if}
    {#if cuda?.state === 'error'}
      <p class="bad">{cudaLabel.error(cuda.errorCode)}</p>
      {#if cuda.message}<p class="muted small">{cuda.message}</p>{/if}
    {/if}
    <div class="row">
      {#if cudaBusy}
        <button type="button" class="btn" onclick={() => cudaDownload('cancel')}>{t.servers.backend.cudaCancel}</button>
      {:else if !cuda?.installed}
        <button type="button" class="btn primary" onclick={() => cudaDownload('start')}>{t.servers.backend.cudaDownload}</button>
      {/if}
    </div>
  </div>
{/if}

{#if message}
  <p class={message.ok ? 'good' : 'bad'} role="status">{message.text}</p>
{/if}

<h2>{t.servers.heading}</h2>

{#if forms}
  {#each roles as role (role)}
    {@const form = forms[role]}
    {@const status = store.llama[role]}
    <fieldset>
      <legend>{label.serverRole(role)}</legend>
      <div class="row">
        <span class={status?.state === 'ready' ? 'good' : status?.state === 'error' ? 'bad' : 'muted'}>
          {status ? (status.errorCode ? label.llamaError(status.errorCode) : label.serverState(status.state)) : '—'}
        </span>
        {#if status?.port}<span class="muted small">:{status.port}</span>{/if}
        <button type="button" class="btn" onclick={() => controlServer(role, 'start')}>{t.servers.start}</button>
        <button type="button" class="btn" onclick={() => controlServer(role, 'stop')}>{t.servers.stop}</button>
        <button type="button" class="btn" onclick={() => controlServer(role, 'restart')}>{t.servers.restart}</button>
      </div>
      <div class="grid">
        <label class="field"><span>{t.servers.fields.port}</span><input type="number" min="1024" max="65535" bind:value={form.port} /></label>
        <label class="field"><span>{t.servers.fields.ctxSize}</span><input type="number" min="256" bind:value={form.ctxSize} /></label>
        <label class="field"><span>{t.servers.fields.nGpuLayers}</span><input type="number" min="0" bind:value={form.nGpuLayers} /></label>
        <label class="field"><span>{t.servers.fields.parallel}</span><input type="number" min="1" bind:value={form.parallel} /></label>
        <label class="field">
          <span>{t.servers.fields.flashAttn}</span>
          <select bind:value={form.flashAttn}>
            <option value="auto">{t.servers.flashAttn.auto}</option>
            <option value="on">{t.servers.flashAttn.on}</option>
            <option value="off">{t.servers.flashAttn.off}</option>
          </select>
        </label>
        <label class="field"><span>{t.servers.fields.alias}</span><input type="text" bind:value={form.alias} /></label>
        {#if role === 'translate'}
          <label class="field"><span>{t.servers.fields.temp}</span><input type="number" min="0" max="2" step="0.1" bind:value={form.temp} /></label>
          <label class="field">
            <span>{t.servers.fields.reasoning}</span>
            <select bind:value={form.reasoning}>
              <option value="off">{t.servers.reasoning.off}</option>
              <option value="on">{t.servers.reasoning.on}</option>
            </select>
          </label>
        {/if}
        <label class="field wide"><span>{t.servers.fields.extraArgs}</span><input type="text" bind:value={form.extraArgs} /></label>
      </div>
      <div class="row">
        <label class="radio"><input type="checkbox" bind:checked={form.autostart} />{t.servers.fields.autostart}</label>
        <button type="button" class="btn primary" onclick={() => save(role)}>{t.settings.apply}</button>
      </div>
    </fieldset>
  {/each}
{/if}

<style>
  fieldset {
    margin: 0 0 14px;
    padding: 8px 14px 6px;
    border: 1px solid #393b40;
    border-radius: 8px;
  }
  legend {
    padding: 0 6px;
    font-weight: 600;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 10px 14px;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .radio {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-right: 12px;
  }
  .banner {
    padding: 8px 12px;
    background: #402a2a;
    border-radius: 8px;
  }
  .cuda {
    margin: 8px 0 14px;
    padding: 8px 14px;
    background: #25272b;
    border-radius: 8px;
  }
  .cuda p {
    margin: 4px 0;
  }
  .small {
    font-size: 12px;
  }
  .bar {
    width: 320px;
    height: 6px;
    background: #393b40;
    border-radius: 3px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: #57c27a;
  }
</style>
