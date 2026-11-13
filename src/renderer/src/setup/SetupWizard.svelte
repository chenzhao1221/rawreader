<script lang="ts">
  import { onMount } from 'svelte'
  import type { ModelItem } from '../../../shared/ipc/contract'
  import { localRolesFor, largestVram, planEngine } from '../../../shared/setup/plan'
  import type { SetupEngine, SetupVerdict } from '../../../shared/setup/plan'
  import { TRANSLATOR_OPTIONS, isDownloadable } from '../../../shared/models/translators'
  import type { TranslatorId } from '../../../shared/models/translators'
  import { formatBytes, modelLabel, zhCN as t } from '../i18n/zh-CN'
  import { closeSettings, modelsDownload, saveConfig, store } from '../state.svelte'
  import Choice from '../ui/Choice.svelte'
  import Group from '../ui/Group.svelte'
  import Row from '../ui/Row.svelte'

  let step = $state<1 | 2 | 3>(1)
  let engine = $state<SetupEngine>('local')
  let baseUrl = $state('https://api.deepseek.com/v1')
  let apiModel = $state('deepseek-chat')
  let geminiModel = $state('gemini-2.5-flash')
  let apiKey = $state('')
  let geminiKey = $state('')
  let keySet = $state({ openai: false, gemini: false })
  let error = $state<string | null>(null)
  let saving = $state(false)

  const presets = [
    { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash' },
    { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  ] as const

  const hardware = $derived(store.hardware)
  const models = $derived(store.models)
  const engines: readonly SetupEngine[] = ['local', 'openai', 'gemini']

  onMount(async () => {
    const result = await window.rawreader.invoke('secrets:status')
    if (result.ok) keySet = result.value
    const config = store.config
    if (config) {
      engine = config.translate.engine
      baseUrl = config.translate.api.baseUrl
      apiModel = config.translate.api.model
      geminiModel = config.translate.gemini.model
    }
  })

  const engineNames: Record<SetupEngine, string> = { local: t.engine.local, openai: t.engine.openai, gemini: t.engine.gemini }
  const chipTone: Record<SetupVerdict, string> = { recommended: 'good', workable: 'warn', blocked: 'bad' }

  /** The four rows at the top of step 1: GPU, its memory, RAM and free disk. */
  const gpuText = $derived(
    !hardware ? t.setup.checking : hardware.gpus.length === 0 ? t.setup.noGpu : hardware.gpus.map((gpu) => gpu.name).join('、'),
  )
  const vramBytes = $derived(hardware ? largestVram(hardware) : 0)
  const vramText = $derived(vramBytes > 0 ? formatBytes(vramBytes) : '—')
  const ramText = $derived(hardware ? formatBytes(hardware.totalRamBytes) : '—')
  const diskText = $derived(hardware?.freeDiskBytes != null ? formatBytes(hardware.freeDiskBytes) : '—')

  function diskNeedFor(target: SetupEngine): number {
    if (!models) return 0
    const roles = new Set<string>(localRolesFor(target))
    return models.items.filter((item) => roles.has(item.role) && item.path === null).reduce((sum, item) => sum + item.size, 0)
  }

  function planFor(target: SetupEngine) {
    return hardware ? planEngine(target, hardware, diskNeedFor(target)) : null
  }

  /** Blocked engines stay selectable: the card is dimmed, not disabled. */
  function choose(target: SetupEngine): void {
    engine = target
    error = null
  }

  /** Files this engine runs locally, with the ones still missing. */
  const translator = $derived<TranslatorId>(store.config?.models.translator ?? 'index-2b')

  /** The translator row of the file list follows the choice, so the size and download update at once. */
  async function pickTranslator(id: TranslatorId): Promise<void> {
    if (id === translator) return
    await saveConfig({ models: { translator: id } })
    const result = await window.rawreader.invoke('models:overview')
    if (result.ok) store.models = result.value
  }

  const neededItems = $derived.by(() => {
    if (!models) return [] as ModelItem[]
    const roles = new Set<string>(localRolesFor(engine))
    return models.items.filter((item) => roles.has(item.role))
  })
  const missingItems = $derived(neededItems.filter((item) => item.path === null))
  const downloading = $derived(
    neededItems.some((item) => item.download !== null && ['queued', 'downloading', 'verifying'].includes(item.download.status)),
  )

  const isActive = (item: ModelItem): boolean =>
    item.download !== null && ['queued', 'downloading', 'verifying'].includes(item.download.status)
  const isStopped = (item: ModelItem): boolean =>
    item.download !== null && ['paused', 'cancelled', 'error'].includes(item.download.status)

  function percent(item: ModelItem): number {
    const download = item.download
    if (!download || download.totalBytes === 0) return 0
    return Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100))
  }

  function dot(item: ModelItem): string {
    if (isActive(item)) return 'busy'
    if (item.path !== null) return 'good'
    if (isStopped(item)) return 'warn'
    return ''
  }

  async function saveKey(name: 'openai' | 'gemini', value: string): Promise<boolean> {
    const result = await window.rawreader.invoke('secrets:set', { name, value })
    if (result.ok) keySet = result.value
    return result.ok
  }

  async function removeKey(name: 'openai' | 'gemini'): Promise<void> {
    await saveKey(name, '')
  }

  async function persist(): Promise<boolean> {
    return saveConfig({
      translate: { engine, api: { baseUrl: baseUrl.trim(), model: apiModel.trim() }, gemini: { model: geminiModel.trim() } },
    })
  }

  function missingKey(): boolean {
    return (engine === 'openai' && !keySet.openai && apiKey.trim() === '') || (engine === 'gemini' && !keySet.gemini && geminiKey.trim() === '')
  }

  async function next(): Promise<void> {
    error = null
    if (step === 1) {
      step = 2
      return
    }
    if (step !== 2) return
    if (missingKey()) {
      error = t.setup.needKey
      return
    }
    saving = true
    try {
      if (apiKey.trim() && !(await saveKey('openai', apiKey))) {
        error = t.engine.keyFailed
        return
      }
      if (geminiKey.trim() && !(await saveKey('gemini', geminiKey))) {
        error = t.engine.keyFailed
        return
      }
      apiKey = ''
      geminiKey = ''
      if (!(await persist())) {
        error = t.engine.invalid
        return
      }
      if (engine !== 'gemini' && missingItems.length > 0 && !downloading && models?.downloadsAllowed) {
        // Only the files this engine runs (an API translator needs no local translation model).
        for (const item of missingItems) void modelsDownload('start', item.role)
      }
      step = 3
    } finally {
      saving = false
    }
  }

  async function finish(): Promise<void> {
    await saveConfig({ ui: { setupDone: true } })
    closeSettings()
  }

  async function skip(): Promise<void> {
    await saveConfig({ ui: { setupDone: true } })
    closeSettings()
  }

  const roleName: Record<string, string> = {
    ocr: '文字识别模型',
    ocrMmproj: '文字识别视觉投影',
    translator: '翻译模型',
  }
</script>

<section class="wizard" aria-label={t.setup.title}>
  <header>
    <div class="steps" role="group" aria-label={t.setup.step(step)}>
      {#each [1, 2, 3] as n (n)}
        <span class="step-dot" class:current={n === step} class:done={n < step} aria-hidden="true"></span>
      {/each}
    </div>
    <h1>{t.setup.title}</h1>
    <span class="spacer"></span>
    {#if step < 3}
      <button type="button" class="ui-btn small ghost" onclick={skip}>{t.setup.skip}</button>
    {/if}
  </header>

  <div class="body">
    {#if step === 1}
      <Group title={t.setup.hardware}>
        <Row label={t.setup.specGpu}><span class="value" title={gpuText}>{gpuText}</span></Row>
        <Row label={t.setup.specVram}><span class="value">{vramText}</span></Row>
        <Row label={t.setup.specRam}><span class="value">{ramText}</span></Row>
        <Row label={t.setup.specDisk}><span class="value">{diskText}</span></Row>
      </Group>

      <div class="choices">
        {#each engines as option (option)}
          {@const plan = planFor(option)}
          {@const verdict = plan?.verdict ?? null}
          <Choice title={engineNames[option]} selected={engine === option} disabled={verdict === 'blocked'} onselect={() => choose(option)}>
            {#if verdict}
              <span class="ui-chip {chipTone[verdict]}">{t.setup.verdict[verdict]}</span>
            {/if}
            {#if verdict === 'blocked' && engine === option}
              <span class="ui-chip">{t.setup.forced}</span>
            {/if}
            {#if option === 'openai'}
              <span class="ui-chip warn">{t.engine.tagPaid}</span>
            {/if}
            {#if plan && plan.shortfallBytes !== null}
              <span class="ui-chip bad">{t.setup.diskShort(plan.shortfallBytes)}</span>
            {/if}
          </Choice>
        {/each}
      </div>
    {:else if step === 2}
      {#if engine === 'openai'}
        <Group title={t.engine.apiTitle}>
          {#snippet actions()}
            {#each presets as preset (preset.label)}
              <button
                type="button"
                class="ui-btn small ghost"
                onclick={() => {
                  baseUrl = preset.baseUrl
                  apiModel = preset.model
                }}>{preset.label}</button
              >
            {/each}
          {/snippet}
          <Row label={t.engine.baseUrl}>
            <input class="ui-input mono field" bind:value={baseUrl} spellcheck="false" />
          </Row>
          <Row label={t.engine.model}>
            <input class="ui-input mono field" bind:value={apiModel} spellcheck="false" />
          </Row>
          <Row label={t.engine.apiKey} detail={missingKey() ? t.setup.needKey : undefined} tone="warn">
            {#if keySet.openai}<span class="ui-chip good">{t.engine.keySet}</span>{/if}
            <input
              class="ui-input mono field"
              type="password"
              bind:value={apiKey}
              placeholder={keySet.openai ? t.engine.keepKey : 'sk-…'}
              autocomplete="off"
            />
            {#if keySet.openai}
              <button type="button" class="ui-btn small ghost" onclick={() => removeKey('openai')}>{t.setup.removeKey}</button>
            {/if}
          </Row>
        </Group>
      {:else if engine === 'gemini'}
        <Group title={t.engine.geminiTitle}>
          <Row label={t.engine.model}>
            <input class="ui-input mono field" bind:value={geminiModel} spellcheck="false" />
          </Row>
          <Row label={t.engine.apiKey} detail={missingKey() ? t.setup.needKey : undefined} tone="warn">
            {#if keySet.gemini}<span class="ui-chip good">{t.engine.keySet}</span>{/if}
            <input
              class="ui-input mono field"
              type="password"
              bind:value={geminiKey}
              placeholder={keySet.gemini ? t.engine.keepKey : 'AIza…'}
              autocomplete="off"
            />
            {#if keySet.gemini}
              <button type="button" class="ui-btn small ghost" onclick={() => removeKey('gemini')}>{t.setup.removeKey}</button>
            {/if}
          </Row>
        </Group>
      {:else}
        <Group title={t.models.translatorTitle}>
          <Row label={t.models.translatorTitle}>
            <select class="ui-select select" value={translator} onchange={(e) => pickTranslator(e.currentTarget.value as TranslatorId)}>
              {#each TRANSLATOR_OPTIONS.filter(isDownloadable) as option (option.id)}
                <option value={option.id}>
                  {option.displayName} · {formatBytes(option.size)} · {t.models.vram(formatBytes(option.vramBytes))}
                </option>
              {/each}
            </select>
          </Row>
        </Group>
      {/if}

      {#if engine !== 'gemini' && neededItems.length > 0}
        <Group title={t.setup.downloadTitle}>
          {#snippet actions()}
            {#if models?.downloadsAllowed && !downloading && missingItems.length > 0}
              <button
                type="button"
                class="ui-btn small primary"
                onclick={() => missingItems.forEach((item) => void modelsDownload('start', item.role))}>{t.setup.downloadAll}</button
              >
            {/if}
          {/snippet}
          {#each neededItems as item (item.role)}
            <div class="file">
              <span class="ui-dot {dot(item)}"></span>
              <div class="file-text">
                <div class="file-name">
                  {roleName[item.role] ?? item.displayName}
                  <span class="size">{formatBytes(item.size)}</span>
                </div>
                {#if isActive(item)}
                  <div class="ui-bar"><div style="width: {percent(item)}%"></div></div>
                {/if}
              </div>
              <span class="file-state">
                {#if item.path !== null}
                  <span class="ui-chip good">{modelLabel.check('ok')}</span>
                {:else if item.download && item.download.status !== 'queued'}
                  <span class="ui-chip" class:bad={item.download.status === 'error'}>
                    {modelLabel.downloadStatus(item.download.status)} {percent(item)}%
                  </span>
                {:else}
                  <span class="ui-chip bad">{t.models.missing}</span>
                {/if}
              </span>
            </div>
          {/each}
        </Group>
      {/if}
    {:else}
      <div class="done">
        <h2>{t.setup.doneTitle}</h2>
        <div class="done-chips">
          <span class="ui-chip good">{engineNames[engine]}</span>
          {#if engine !== 'gemini'}
            {#if missingItems.length === 0}
              <span class="ui-chip good">{modelLabel.check('ok')}</span>
            {:else}
              <span class="ui-chip warn">{t.models.missing}</span>
            {/if}
          {/if}
        </div>
        <button type="button" class="ui-btn primary finish" onclick={finish}>{t.setup.finish}</button>
      </div>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

  {#if step < 3}
    <footer>
      {#if step > 1}
        <button type="button" class="ui-btn ghost" onclick={() => (step = 1)}>{t.setup.back}</button>
      {/if}
      <span class="spacer"></span>
      <button type="button" class="ui-btn primary" disabled={saving} onclick={next}>{t.setup.next}</button>
    </footer>
  {/if}
</section>

<style>
  /* One centred card, like the settings page: the window shows through around it. */
  .wizard {
    display: flex;
    flex-direction: column;
    width: min(640px, calc(100% - 2 * var(--gap-xl)));
    max-height: calc(100% - 2 * var(--gap-xl));
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    box-shadow: var(--shadow);
    color: var(--text);
    font-family: var(--font);
    font-size: var(--text-m);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--gap);
    padding: var(--gap-l) var(--gap-l) var(--gap);
  }
  h1 {
    margin: 0;
    font-size: var(--text-l);
    font-weight: 600;
  }
  .steps {
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    flex: none;
  }
  .step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--surface-3);
    transition: background 0.15s;
  }
  .step-dot.done {
    background: var(--good);
  }
  .step-dot.current {
    background: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .step-dot {
      transition: none;
    }
  }
  .spacer {
    flex: 1;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 var(--gap-l) var(--gap);
  }
  footer {
    display: flex;
    align-items: center;
    gap: var(--gap-s);
    padding: var(--gap) var(--gap-l);
    border-top: 1px solid var(--border);
  }
  .choices {
    display: grid;
    gap: var(--gap-s);
  }
  .value {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .field {
    width: 300px;
  }
  .select {
    width: 260px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: var(--gap);
    min-height: 56px;
    padding: 10px 16px;
    box-sizing: border-box;
  }
  .file-text {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
    flex: 1;
    min-width: 0;
  }
  .file-name {
    display: flex;
    align-items: baseline;
    gap: var(--gap-s);
  }
  .size {
    color: var(--text-faint);
    font-size: var(--text-s);
  }
  .file-state {
    flex: none;
  }
  .done {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap-l);
    padding: var(--gap-xl) 0;
  }
  .done h2 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
  }
  .done-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--gap-s);
  }
  .finish {
    width: 100%;
    max-width: 320px;
    height: 44px;
    font-size: var(--text-l);
  }
  .error {
    margin: var(--gap) 0 0;
    color: var(--bad);
  }
</style>
