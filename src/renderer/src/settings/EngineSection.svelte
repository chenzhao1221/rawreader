<script lang="ts">
  import { onMount } from 'svelte'
  import type { SecretsStatus } from '../../../shared/ipc/contract'
  import { zhCN as t } from '../i18n/zh-CN'
  import { openWizard, saveConfig, store } from '../state.svelte'

  type Engine = 'local' | 'openai' | 'gemini'
  let engine = $state<Engine>('local')
  let baseUrl = $state('')
  let apiModel = $state('')
  let geminiModel = $state('')
  /** Typed keys. Empty means "keep the saved one". */
  let apiKey = $state('')
  let geminiKey = $state('')
  let secrets = $state<SecretsStatus>({ openai: false, gemini: false })
  let message = $state<{ text: string; ok: boolean } | null>(null)

  $effect(() => {
    const config = store.config
    if (!config) return
    engine = config.translate.engine
    baseUrl = config.translate.api.baseUrl
    apiModel = config.translate.api.model
    geminiModel = config.translate.gemini.model
  })

  onMount(async () => {
    const result = await window.rawreader.invoke('secrets:status')
    if (result.ok) secrets = result.value
  })

  /** One-click presets for common OpenAI-compatible services. */
  const presets = [
    { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash' },
    { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  ] as const

  async function saveKey(name: 'openai' | 'gemini', value: string): Promise<boolean> {
    const result = await window.rawreader.invoke('secrets:set', { name, value })
    if (result.ok) secrets = result.value
    return result.ok
  }

  async function save(): Promise<void> {
    if (apiKey.trim() && !(await saveKey('openai', apiKey))) return void (message = { text: t.engine.keyFailed, ok: false })
    if (geminiKey.trim() && !(await saveKey('gemini', geminiKey))) return void (message = { text: t.engine.keyFailed, ok: false })
    apiKey = ''
    geminiKey = ''
    const ok = await saveConfig({
      translate: { engine, api: { baseUrl: baseUrl.trim(), model: apiModel.trim() }, gemini: { model: geminiModel.trim() } },
    })
    const missingKey = (engine === 'openai' && !secrets.openai) || (engine === 'gemini' && !secrets.gemini)
    message = ok ? { text: missingKey ? t.engine.needKey : t.settings.saved, ok: !missingKey } : { text: t.engine.invalid, ok: false }
  }

  async function removeKey(name: 'openai' | 'gemini'): Promise<void> {
    await saveKey(name, '')
  }
</script>

<h2>{t.engine.title}</h2>
<div class="choices">
  <label class="choice" class:active={engine === 'local'}>
    <input type="radio" bind:group={engine} value="local" />
    <strong>{t.engine.local}</strong>
    <span class="muted">{t.engine.localNote}</span>
  </label>
  <label class="choice" class:active={engine === 'openai'}>
    <input type="radio" bind:group={engine} value="openai" />
    <strong>{t.engine.openai}</strong>
    <span class="muted">{t.engine.openaiNote}</span>
  </label>
  <label class="choice" class:active={engine === 'gemini'}>
    <input type="radio" bind:group={engine} value="gemini" />
    <strong>{t.engine.gemini}</strong>
    <span class="muted">{t.engine.geminiNote}</span>
  </label>
</div>

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
      <span>{t.engine.apiKey}{secrets.openai ? `（${t.engine.keySet}）` : ''}</span>
      <input type="password" bind:value={apiKey} placeholder={secrets.openai ? t.engine.keepKey : 'sk-…'} autocomplete="off" />
    </label>
    {#if secrets.openai}<button type="button" class="btn" onclick={() => removeKey('openai')}>{t.engine.removeKey}</button>{/if}
  </div>
{:else if engine === 'gemini'}
  <h2>{t.engine.geminiTitle}</h2>
  <div class="row">
    <label class="field"><span>{t.engine.model}</span><input type="text" bind:value={geminiModel} spellcheck="false" /></label>
    <label class="field long">
      <span>{t.engine.apiKey}{secrets.gemini ? `（${t.engine.keySet}）` : ''}</span>
      <input type="password" bind:value={geminiKey} placeholder={secrets.gemini ? t.engine.keepKey : 'AIza…'} autocomplete="off" />
    </label>
    {#if secrets.gemini}<button type="button" class="btn" onclick={() => removeKey('gemini')}>{t.engine.removeKey}</button>{/if}
  </div>
  <p class="muted small">{t.engine.geminiKeyNote}</p>
{/if}

<p class="muted small">{t.engine.keyStorage}</p>

<div class="row">
  <button type="button" class="btn primary" onclick={save}>{t.settings.apply}</button>
  {#if message}<span class={message.ok ? 'good' : 'bad'} role="status">{message.text}</span>{/if}
</div>

<h2>{t.engine.wizardTitle}</h2>
<div class="row">
  <button type="button" class="btn" onclick={openWizard}>{t.engine.rerunWizard}</button>
  <span class="muted small">{t.engine.rerunNote}</span>
</div>

<style>
  .choices {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 720px;
  }
  .choice {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 10px;
    row-gap: 2px;
    padding: 10px 12px;
    background: #26282b;
    border: 1px solid #393b40;
    border-radius: 8px;
    cursor: pointer;
  }
  .choice.active {
    border-color: #6b9eff;
  }
  .choice input {
    grid-row: span 2;
    margin-top: 3px;
  }
  .choice .muted {
    font-size: 12px;
  }
  .long {
    min-width: 360px;
  }
  .small {
    font-size: 12px;
  }
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
</style>
