<script lang="ts">
  import { formatBytes, zhCN as t } from '../i18n/zh-CN'
  import { clearCache, openLogs, saveConfig, store } from '../state.svelte'

  let ocrConcurrency = $state<number | null>(null)
  let translateConcurrency = $state<number | null>(null)
  let readingDirection = $state<'ltr' | 'rtl'>('ltr')
  let bubblesOnly = $state(false)
  let adBlock = $state(true)
  let huggingface = $state('')
  let modelscope = $state('')
  let cacheGb = $state(2)
  let message = $state<{ text: string; ok: boolean } | null>(null)

  $effect(() => {
    const config = store.config
    if (!config) return
    ocrConcurrency = config.pipeline.ocrConcurrency
    translateConcurrency = config.pipeline.translateConcurrency
    readingDirection = config.pipeline.readingDirection
    ahead = aheadFrom(config.pipeline.rootMarginPx)
    bubblesOnly = config.ui.bubblesOnly
    adBlock = config.ui.adBlock
    huggingface = config.models.mirrors.huggingface
    modelscope = config.models.mirrors.modelscope
    cacheGb = Math.round((config.cache.maxBytes / 1024 ** 3) * 100) / 100
  })

  const concurrencyOptions = [null, 1, 2, 3, 4, 6, 8] as const

  /** Pre-translate distance presets, in CSS pixels. A stored value in between shows as the nearest preset. */
  const AHEAD = { off: 0, near: 1000, far: 5000 } as const
  type Ahead = keyof typeof AHEAD
  const aheadFrom = (px: number): Ahead => (px < 500 ? 'off' : px < 3000 ? 'near' : 'far')
  let ahead = $state<Ahead>('near')

  async function save(): Promise<void> {
    const ok = await saveConfig({
      ui: { bubblesOnly, adBlock },
      pipeline: { ocrConcurrency, translateConcurrency, readingDirection, rootMarginPx: AHEAD[ahead] },
      models: { mirrors: { huggingface: huggingface.trim(), modelscope: modelscope.trim() } },
      cache: { maxBytes: Math.max(0, Math.round(cacheGb * 1024 ** 3)) },
    })
    message = { text: ok ? t.settings.saved : t.settings.invalid, ok }
  }
</script>

<h2>{t.advanced.pipeline}</h2>
<div class="row">
  <label class="field">
    <span>{t.advanced.ocrConcurrency}</span>
    <select bind:value={ocrConcurrency}>
      {#each concurrencyOptions as option (option)}
        <option value={option}>{option === null ? t.advanced.auto : option}</option>
      {/each}
    </select>
  </label>
  <label class="field">
    <span>{t.advanced.translateConcurrency}</span>
    <select bind:value={translateConcurrency}>
      {#each concurrencyOptions as option (option)}
        <option value={option}>{option === null ? t.advanced.auto : option}</option>
      {/each}
    </select>
  </label>
  <label class="field">
    <span>{t.advanced.readingDirection}</span>
    <select bind:value={readingDirection}>
      <option value="ltr">{t.advanced.ltr}</option>
      <option value="rtl">{t.advanced.rtl}</option>
    </select>
  </label>
  <label class="field">
    <span>{t.advanced.ahead}</span>
    <select bind:value={ahead}>
      <option value="off">{t.advanced.aheadOff}</option>
      <option value="near">{t.advanced.aheadNear}</option>
      <option value="far">{t.advanced.aheadFar}</option>
    </select>
  </label>
</div>
<p class="muted small">{t.advanced.aheadNote}</p>
<div class="row">
  <label class="check"><input type="checkbox" bind:checked={bubblesOnly} />{t.advanced.bubblesOnly}</label>
</div>
<p class="muted small">{t.advanced.bubblesOnlyNote}</p>
<div class="row">
  <label class="check"><input type="checkbox" bind:checked={adBlock} />{t.advanced.adBlock}</label>
</div>
<p class="muted small">{t.advanced.adBlockNote}</p>

<h2>{t.advanced.mirrors}</h2>
<div class="row">
  <label class="field long"><span>{t.advanced.huggingface}</span><input type="text" bind:value={huggingface} /></label>
  <label class="field long"><span>{t.advanced.modelscope}</span><input type="text" bind:value={modelscope} /></label>
</div>

<h2>{t.advanced.cache}</h2>
<div class="row">
  <label class="field"><span>{t.advanced.cacheCap}</span><input type="number" min="0" step="0.5" bind:value={cacheGb} /></label>
  <span class="muted">
    {#if store.cache}
      {store.cache.entries} · {formatBytes(store.cache.bytes)}
    {/if}
  </span>
  <button type="button" class="btn" onclick={clearCache}>{t.advanced.clearCache}</button>
</div>
<p class="muted small">{t.advanced.cacheNote}</p>

<div class="row">
  <button type="button" class="btn primary" onclick={save}>{t.settings.apply}</button>
  {#if message}<span class={message.ok ? 'good' : 'bad'} role="status">{message.text}</span>{/if}
</div>

<h2>{t.advanced.logs}</h2>
<div class="row"><button type="button" class="btn" onclick={openLogs}>{t.advanced.openLogs}</button></div>

<style>
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .long {
    min-width: 320px;
  }
  .small {
    font-size: 12px;
  }
</style>
