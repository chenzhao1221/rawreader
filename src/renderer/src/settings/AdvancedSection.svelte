<script lang="ts">
  import { formatBytes, zhCN as t } from '../i18n/zh-CN'
  import { clearCache, openLogs, saveConfig, store } from '../state.svelte'
  import Group from '../ui/Group.svelte'
  import Row from '../ui/Row.svelte'
  import Segmented from '../ui/Segmented.svelte'
  import Toggle from '../ui/Toggle.svelte'

  const config = $derived(store.config)
  let error = $state<string | null>(null)

  async function save(patch: Parameters<typeof saveConfig>[0]): Promise<void> {
    error = (await saveConfig(patch)) ? null : t.settings.invalid
  }

  /** Pre-translate distance presets, in CSS pixels. A stored value in between shows as the nearest preset. */
  const AHEAD = { off: 0, near: 1000, far: 5000 } as const
  type Ahead = keyof typeof AHEAD
  const aheadFrom = (px: number): Ahead => (px < 500 ? 'off' : px < 3000 ? 'near' : 'far')

  const concurrency = [null, 1, 2, 3, 4, 6, 8] as const
  let confirmClear = $state(false)
</script>

{#if config}
  <Group title={t.advanced.reading}>
    <Row label={t.advanced.ahead}>
      <Segmented
        label={t.advanced.ahead}
        value={aheadFrom(config.pipeline.rootMarginPx)}
        options={[
          { value: 'off', label: t.advanced.aheadOff },
          { value: 'near', label: t.advanced.aheadNear },
          { value: 'far', label: t.advanced.aheadFar },
        ]}
        onchange={(v) => save({ pipeline: { rootMarginPx: AHEAD[v] } })}
      />
    </Row>
    <Row label={t.advanced.readingDirection}>
      <Segmented
        label={t.advanced.readingDirection}
        value={config.pipeline.readingDirection}
        options={[
          { value: 'ltr', label: t.advanced.ltr },
          { value: 'rtl', label: t.advanced.rtl },
        ]}
        onchange={(v) => save({ pipeline: { readingDirection: v } })}
      />
    </Row>
    <Row label={t.advanced.bubblesOnly}>
      <Toggle label={t.advanced.bubblesOnly} checked={config.ui.bubblesOnly} onchange={(v) => save({ ui: { bubblesOnly: v } })} />
    </Row>
  </Group>

  <Group title={t.advanced.web}>
    <Row label={t.advanced.adBlock}>
      <Toggle label={t.advanced.adBlock} checked={config.ui.adBlock} onchange={(v) => save({ ui: { adBlock: v } })} />
    </Row>
  </Group>

  <Group title={t.advanced.performance}>
    <Row label={t.advanced.ocrConcurrency}>
      <select
        class="ui-select"
        value={config.pipeline.ocrConcurrency}
        onchange={(e) => save({ pipeline: { ocrConcurrency: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) } })}
      >
        {#each concurrency as option (option)}<option value={option ?? ''}>{option ?? t.advanced.auto}</option>{/each}
      </select>
    </Row>
    <Row label={t.advanced.translateConcurrency}>
      <select
        class="ui-select"
        value={config.pipeline.translateConcurrency}
        onchange={(e) => save({ pipeline: { translateConcurrency: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) } })}
      >
        {#each concurrency as option (option)}<option value={option ?? ''}>{option ?? t.advanced.auto}</option>{/each}
      </select>
    </Row>
  </Group>

  <Group title={t.advanced.cache}>
    <Row label={t.advanced.cacheUsed} detail={store.cache ? `${store.cache.entries} · ${formatBytes(store.cache.bytes)}` : undefined}>
      {#if confirmClear}
        <button type="button" class="ui-btn ghost" onclick={() => (confirmClear = false)}>{t.settings.no}</button>
        <button
          type="button"
          class="ui-btn danger"
          onclick={async () => {
            confirmClear = false
            await clearCache()
          }}>{t.advanced.clearCacheConfirm}</button
        >
      {:else}
        <button type="button" class="ui-btn danger" onclick={() => (confirmClear = true)}>{t.advanced.clearCache}</button>
      {/if}
    </Row>
    <Row label={t.advanced.cacheCap}>
      <input
        class="ui-input number"
        type="number"
        min="0"
        step="0.5"
        value={Math.round((config.cache.maxBytes / 1024 ** 3) * 100) / 100}
        onchange={(e) => save({ cache: { maxBytes: Math.max(0, Math.round(Number(e.currentTarget.value) * 1024 ** 3)) } })}
      />
      <span class="unit">GB</span>
    </Row>
  </Group>

  <Group title={t.advanced.mirrors}>
    <Row label="Hugging Face">
      <input
        class="ui-input mono field"
        value={config.models.mirrors.huggingface}
        spellcheck="false"
        onchange={(e) => save({ models: { mirrors: { huggingface: e.currentTarget.value.trim() } } })}
      />
    </Row>
    <Row label="ModelScope">
      <input
        class="ui-input mono field"
        value={config.models.mirrors.modelscope}
        spellcheck="false"
        onchange={(e) => save({ models: { mirrors: { modelscope: e.currentTarget.value.trim() } } })}
      />
    </Row>
  </Group>

  <Group>
    <Row label={t.advanced.logs}>
      <button type="button" class="ui-btn" onclick={openLogs}>{t.advanced.openLogs}</button>
    </Row>
  </Group>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
{/if}

<style>
  .field {
    width: 300px;
  }
  .number {
    width: 80px;
  }
  .unit {
    color: var(--text-dim);
  }
  .error {
    color: var(--bad);
  }
</style>
