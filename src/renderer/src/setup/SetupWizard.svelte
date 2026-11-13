<script lang="ts">
  import { onMount } from 'svelte'
  import type { ModelItem } from '../../../shared/ipc/contract'
  import { localRolesFor, planEngine } from '../../../shared/setup/plan'
  import { TRANSLATOR_OPTIONS, isDownloadable, translatorOption } from '../../../shared/models/translators'
  import type { TranslatorId } from '../../../shared/models/translators'
  import type { SetupEngine, SetupVerdict } from '../../../shared/setup/plan'
  import { formatBytes, modelLabel, zhCN as t } from '../i18n/zh-CN'
  import { closeSettings, modelsDownload, saveConfig, store } from '../state.svelte'

  let step = $state<1 | 2 | 3>(1)
  let engine = $state<SetupEngine>('local')
  let forced = $state<SetupEngine | null>(null)
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
  const engineNotes: Record<SetupEngine, string> = { local: t.engine.localNote, openai: t.engine.openaiNote, gemini: t.engine.geminiNote }

  function diskNeedFor(target: SetupEngine): number {
    if (!models) return 0
    const roles = new Set<string>(localRolesFor(target))
    return models.items.filter((item) => roles.has(item.role) && item.path === null).reduce((sum, item) => sum + item.size, 0)
  }

  function planFor(target: SetupEngine) {
    return hardware ? planEngine(target, hardware, diskNeedFor(target)) : null
  }

  function verdictFor(target: SetupEngine): SetupVerdict | null {
    return planFor(target)?.verdict ?? null
  }

  function reasonsFor(target: SetupEngine): string[] {
    const plan = planFor(target)
    return plan ? plan.reasons.map((code) => t.setup.reason(code, plan.shortfallBytes)) : []
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
  const missingBytes = $derived(missingItems.reduce((sum, item) => sum + item.size, 0))
  const downloading = $derived(neededItems.some((item) => item.download !== null && ['queued', 'downloading', 'verifying'].includes(item.download.status)))

  function percent(item: ModelItem): number {
    const download = item.download
    if (!download || download.totalBytes === 0) return 0
    return Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100))
  }

  function choose(target: SetupEngine): void {
    if (verdictFor(target) === 'blocked' && forced !== target) return
    engine = target
    error = null
  }

  function force(target: SetupEngine): void {
    forced = target
    engine = target
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
    <div>
      <h1>{t.setup.title}</h1>
      <span class="muted step">{t.setup.step(step)} · {t.setup.stepTitles[step]}</span>
    </div>
    <span class="spacer"></span>
    {#if step < 3}
      <button type="button" class="btn" onclick={skip}>{t.setup.skip}</button>
    {/if}
  </header>

  <div class="body">
    {#if step === 1}
      <div class="hardware">
        <strong>{t.setup.hardware}</strong>
        {#if hardware}
          <div class="specs">
            <span>{t.setup.cpu(hardware.cpuThreads)}</span>
            <span>{t.setup.ram(hardware.totalRamBytes)}</span>
            {#if hardware.freeDiskBytes !== null}<span>{t.setup.disk(hardware.freeDiskBytes)}</span>{/if}
          </div>
          <div class="specs">
            {#if hardware.gpus.length === 0}
              <span class="warn">{t.setup.noGpu}</span>
            {:else}
              {#each hardware.gpus as gpu (gpu.name)}
                <span>{t.setup.gpu(gpu.name, gpu.vramBytes)}</span>
              {/each}
            {/if}
          </div>
        {:else}
          <div class="specs muted">{t.setup.checking}</div>
        {/if}
      </div>

      <div class="choices">
        {#each engines as option (option)}
          {@const verdict = verdictFor(option)}
          {@const blocked = verdict === 'blocked' && forced !== option}
          <div
            class="choice"
            class:active={engine === option}
            class:blocked
            role="radio"
            aria-checked={engine === option}
            tabindex={blocked ? -1 : 0}
            onclick={() => choose(option)}
            onkeydown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                choose(option)
              }
            }}
          >
            <div class="choice-head">
              <strong>{engineNames[option]}</strong>
              {#if verdict}
                <span class="badge {verdict}">{t.setup.verdict[verdict]}</span>
              {/if}
              {#if forced === option}<span class="badge forced">{t.setup.forced}</span>{/if}
            </div>
            <span class="muted note">{engineNotes[option]}</span>
            {#if reasonsFor(option).length > 0}
              <ul class="reasons">
                {#each reasonsFor(option) as reason (reason)}
                  <li>{reason}</li>
                {/each}
              </ul>
            {/if}
            {#if blocked}
              <button
                type="button"
                class="btn small"
                onclick={(event) => {
                  event.stopPropagation()
                  force(option)
                }}>{t.setup.force}</button
              >
            {/if}
          </div>
        {/each}
      </div>
      {#if hardware && hardware.gpus.length === 0}
        <p class="muted small">{t.setup.hardwareFailed}</p>
      {/if}
    {:else if step === 2}
      {#if engine === 'openai'}
        <h2>{t.engine.apiTitle}</h2>
        <div class="row">
          {#each presets as preset (preset.label)}
            <button
              type="button"
              class="btn"
              onclick={() => {
                baseUrl = preset.baseUrl
                apiModel = preset.model
              }}>{preset.label}</button
            >
          {/each}
        </div>
        <div class="row">
          <label class="field long"><span>{t.engine.baseUrl}</span><input type="text" bind:value={baseUrl} spellcheck="false" /></label>
          <label class="field"><span>{t.engine.model}</span><input type="text" bind:value={apiModel} spellcheck="false" /></label>
        </div>
        <div class="row">
          <label class="field long">
            <span>{t.engine.apiKey}{keySet.openai ? `（${t.engine.keySet}）` : ''}</span>
            <input type="password" bind:value={apiKey} placeholder={keySet.openai ? t.engine.keepKey : 'sk-…'} autocomplete="off" />
          </label>
          {#if keySet.openai}<button type="button" class="btn" onclick={() => removeKey('openai')}>{t.setup.removeKey}</button>{/if}
        </div>
      {:else if engine === 'gemini'}
        <h2>{t.engine.geminiTitle}</h2>
        <div class="row">
          <label class="field"><span>{t.engine.model}</span><input type="text" bind:value={geminiModel} spellcheck="false" /></label>
          <label class="field long">
            <span>{t.engine.apiKey}{keySet.gemini ? `（${t.engine.keySet}）` : ''}</span>
            <input type="password" bind:value={geminiKey} placeholder={keySet.gemini ? t.engine.keepKey : 'AIza…'} autocomplete="off" />
          </label>
          {#if keySet.gemini}<button type="button" class="btn" onclick={() => removeKey('gemini')}>{t.setup.removeKey}</button>{/if}
        </div>
        <p class="muted small">{t.engine.geminiKeyNote}</p>
      {/if}

      {#if engine === 'local'}
        <h2>{t.models.translatorTitle}</h2>
        <div class="row">
          <select value={translator} onchange={(e) => pickTranslator(e.currentTarget.value as TranslatorId)}>
            {#each TRANSLATOR_OPTIONS.filter(isDownloadable) as option (option.id)}
              <option value={option.id}>
                {option.displayName} · {formatBytes(option.size)} · {t.models.vram(formatBytes(option.vramBytes))}
              </option>
            {/each}
          </select>
        </div>
        <p class="muted small">{translatorOption(translator).note}</p>
      {/if}

      {#if engine !== 'gemini'}
        {#if missingItems.length === 0}
          <p class="good small">{t.setup.modelsReady}</p>
        {:else}
          <p class="muted small">{t.setup.downloadNote(missingBytes)}</p>
          <ul class="files">
            {#each neededItems as item (item.role)}
              <li>
                <span>{roleName[item.role] ?? item.displayName}</span>
                <span class="muted">{formatBytes(item.size)}</span>
                {#if item.path !== null}
                  <span class="good small">{t.setup.modelsReady}</span>
                {:else if item.download && item.download.status !== 'queued'}
                  <span class="small">{modelLabel.downloadStatus(item.download.status)} {percent(item)}%</span>
                {:else}
                  <span class="muted small">{t.models.missing}</span>
                {/if}
              </li>
            {/each}
          </ul>
          {#if models?.downloadsAllowed && !downloading}
            <button type="button" class="btn" onclick={() => missingItems.forEach((item) => void modelsDownload('start', item.role))}>{t.setup.downloadAll}</button>
          {/if}
        {/if}
      {:else}
        <p class="muted small">{t.setup.noModelsNeeded}</p>
      {/if}

      <p class="muted small">{t.setup.keyNote}</p>
    {:else}
      <h2>{t.setup.doneTitle}</h2>
      <p>{t.setup.doneBody}</p>
      <ul class="summary">
        <li>{engineNames[engine]}</li>
        {#if engine === 'local' || engine === 'openai'}
          <li>
            {#if missingItems.length === 0}
              <span class="good">{t.setup.modelsReady}</span>
            {:else}
              <span class="muted">{t.setup.downloadNote(missingBytes)}</span>
            {/if}
          </li>
        {/if}
      </ul>
    {/if}

    {#if error}<p class="bad" role="alert">{error}</p>{/if}
  </div>

  <footer>
    {#if step > 1 && step < 3}
      <button type="button" class="btn" onclick={() => (step = 1)}>{t.setup.back}</button>
    {/if}
    <span class="spacer"></span>
    {#if step < 3}
      <button type="button" class="btn primary" disabled={saving} onclick={next}>{t.setup.next}</button>
    {:else}
      <button type="button" class="btn primary" onclick={finish}>{t.setup.finish}</button>
    {/if}
  </footer>
</section>

<style>
  .wizard {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: #1e1f22;
    color: #dfe1e5;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 18px;
    background: #2b2d30;
    border-bottom: 1px solid #393b40;
  }
  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .step {
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 18px 24px 28px;
    max-width: 860px;
    width: 100%;
    box-sizing: border-box;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    background: #2b2d30;
    border-top: 1px solid #393b40;
  }
  h2 {
    margin: 20px 0 10px;
    font-size: 14px;
    font-weight: 600;
  }
  h2:first-child {
    margin-top: 0;
  }
  .hardware {
    padding: 12px 14px;
    margin-bottom: 16px;
    background: #26282b;
    border: 1px solid #393b40;
    border-radius: 8px;
  }
  .specs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin-top: 6px;
    font-size: 12px;
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .choice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    background: #26282b;
    border: 1px solid #393b40;
    border-radius: 8px;
    cursor: pointer;
  }
  .choice.active {
    border-color: #6b9eff;
  }
  .choice.blocked {
    opacity: 0.65;
    cursor: default;
  }
  .choice-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .note {
    font-size: 12px;
  }
  .reasons {
    margin: 2px 0 0;
    padding-left: 18px;
    color: #e8c46a;
    font-size: 12px;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    background: #393b40;
  }
  .badge.recommended {
    color: #8ce0a8;
    background: #24402f;
  }
  .badge.workable {
    color: #e8c46a;
    background: #403a24;
  }
  .badge.blocked {
    color: #ff9a94;
    background: #402a29;
  }
  .badge.forced {
    color: #a9acb2;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 150px;
  }
  .field > span {
    color: #a9acb2;
    font-size: 12px;
  }
  .long {
    min-width: 360px;
  }
  input[type='text'],
  input[type='password'] {
    height: 28px;
    box-sizing: border-box;
    padding: 0 8px;
    color: inherit;
    background: #2b2d30;
    border: 1px solid #4e5157;
    border-radius: 6px;
    font: inherit;
  }
  .btn {
    height: 28px;
    padding: 0 12px;
    color: inherit;
    background: #393b40;
    border: 1px solid transparent;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    background: #45484e;
  }
  .btn.primary {
    background: #3d6fd8;
  }
  .btn.small {
    align-self: flex-start;
    height: 24px;
    font-size: 12px;
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0 12px;
    padding: 0;
    list-style: none;
    font-size: 13px;
  }
  .files li {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .summary {
    margin: 10px 0 16px;
    padding-left: 18px;
  }
  .muted {
    color: #8a8d93;
  }
  .small {
    font-size: 12px;
  }
  .warn {
    color: #e8c46a;
  }
  .good {
    color: #57c27a;
  }
  .bad {
    color: #ff8f88;
  }
</style>
