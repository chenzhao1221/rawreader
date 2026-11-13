<script lang="ts">
  import { formatBytes, zhCN as t } from '../i18n/zh-CN'
  import { clearCache, openLogs, saveConfig, store } from '../state.svelte'

  let ocrConcurrency = $state<number | null>(null)
  let translateConcurrency = $state<number | null>(null)
  let readingDirection = $state<'ltr' | 'rtl'>('ltr')
  let bubblesOnly = $state(false)
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
    bubblesOnly = config.ui.bubblesOnly
    huggingface = config.models.mirrors.huggingface
    modelscope = config.models.mirrors.modelscope
    cacheGb = Math.round((config.cache.maxBytes / 1024 ** 3) * 100) / 100
  })

  const concurrencyOptions = [null, 1, 2, 3, 4, 6, 8] as const

  async function save(): Promise<void> {
    const ok = await saveConfig({
      ui: { bubblesOnly },
      pipeline: { ocrConcurrency, translateConcurrency, readingDirection },
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
</div>
<div class="row">
  <label class="check"><input type="checkbox" bind:checked={bubblesOnly} />{t.advanced.bubblesOnly}</label>
</div>
<p class="muted small">{t.advanced.bubblesOnlyNote}</p>

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
