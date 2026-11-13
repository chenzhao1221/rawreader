<script lang="ts">
  import { onMount } from 'svelte'
  import type { SecretsStatus } from '../../../shared/ipc/contract'
  import { zhCN as t } from '../i18n/zh-CN'
  import { openWizard, saveConfig, store } from '../state.svelte'
  import Choice from '../ui/Choice.svelte'
  import Group from '../ui/Group.svelte'
  import Row from '../ui/Row.svelte'

  type Engine = 'local' | 'openai' | 'gemini'
  type KeyName = 'openai' | 'gemini'

  const config = $derived(store.config)
  const engine = $derived<Engine>(config?.translate.engine ?? 'local')
  let secrets = $state<SecretsStatus>({ openai: false, gemini: false })
  let error = $state<string | null>(null)
  /** Typed into the key fields; saved on blur, then cleared. */
  let keys = $state<Record<KeyName, string>>({ openai: '', gemini: '' })

  onMount(async () => {
    const result = await window.rawreader.invoke('secrets:status')
    if (result.ok) secrets = result.value
  })

  const presets = [
    { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash' },
    { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  ] as const

  async function save(patch: Parameters<typeof saveConfig>[0]): Promise<void> {
    error = (await saveConfig(patch)) ? null : t.engine.invalid
  }

  async function saveKey(name: KeyName): Promise<void> {
    const value = keys[name].trim()
    if (!value) return
    const result = await window.rawreader.invoke('secrets:set', { name, value })
    if (result.ok) {
      secrets = result.value
      keys[name] = ''
      error = null
    } else {
      error = t.engine.keyFailed
    }
  }

  async function removeKey(name: KeyName): Promise<void> {
    const result = await window.rawreader.invoke('secrets:set', { name, value: '' })
    if (result.ok) secrets = result.value
  }

  const keyMissing = $derived((engine === 'openai' && !secrets.openai) || (engine === 'gemini' && !secrets.gemini))
</script>

<div class="choices">
  <Choice title={t.engine.local} selected={engine === 'local'} onselect={() => save({ translate: { engine: 'local' } })}>
    <span class="ui-chip">{t.engine.tagOffline}</span>
    <span class="ui-chip">{t.engine.tagFree}</span>
    <span class="ui-chip">{t.engine.tagGpu}</span>
  </Choice>
  <Choice title={t.engine.openai} selected={engine === 'openai'} onselect={() => save({ translate: { engine: 'openai' } })}>
    <span class="ui-chip">{t.engine.tagBetter}</span>
    <span class="ui-chip warn">{t.engine.tagPaid}</span>
  </Choice>
  <Choice title={t.engine.gemini} selected={engine === 'gemini'} onselect={() => save({ translate: { engine: 'gemini' } })}>
    <span class="ui-chip good">{t.engine.tagNoDownload}</span>
    <span class="ui-chip">{t.engine.tagNeedsGoogle}</span>
  </Choice>
</div>

{#if config && engine === 'openai'}
  <Group title={t.engine.apiTitle}>
    {#snippet actions()}
      {#each presets as preset (preset.label)}
        <button
          type="button"
          class="ui-btn small ghost"
          class:on={config.translate.api.baseUrl === preset.baseUrl}
          onclick={() => save({ translate: { api: { baseUrl: preset.baseUrl, model: preset.model } } })}>{preset.label}</button
        >
      {/each}
    {/snippet}
    <Row label={t.engine.baseUrl}>
      <input
        class="ui-input mono field"
        value={config.translate.api.baseUrl}
        spellcheck="false"
        onchange={(e) => save({ translate: { api: { baseUrl: e.currentTarget.value.trim() } } })}
      />
    </Row>
    <Row label={t.engine.model}>
      <input
        class="ui-input mono field"
        value={config.translate.api.model}
        spellcheck="false"
        onchange={(e) => save({ translate: { api: { model: e.currentTarget.value.trim() } } })}
      />
    </Row>
    {@render keyRow('openai', 'sk-…')}
  </Group>
{:else if config && engine === 'gemini'}
  <Group title="Gemini">
    <Row label={t.engine.model}>
      <input
        class="ui-input mono field"
        value={config.translate.gemini.model}
        spellcheck="false"
        onchange={(e) => save({ translate: { gemini: { model: e.currentTarget.value.trim() } } })}
      />
    </Row>
    {@render keyRow('gemini', 'AIza…')}
  </Group>
{/if}

{#if error}<p class="error" role="alert">{error}</p>{/if}

<Group>
  <Row label={t.engine.rerunWizard}>
    <button type="button" class="ui-btn" onclick={openWizard}>{t.engine.open}</button>
  </Row>
</Group>

{#snippet keyRow(name: KeyName, placeholder: string)}
  <Row label={t.engine.apiKey} detail={keyMissing ? t.engine.needKey : undefined} tone="warn">
    {#if secrets[name]}
      <span class="ui-chip good">{t.engine.keySet}</span>
      <button type="button" class="ui-btn small ghost" onclick={() => removeKey(name)}>{t.engine.removeKey}</button>
    {:else}
      <input
        class="ui-input mono field"
        type="password"
        autocomplete="off"
        {placeholder}
        bind:value={keys[name]}
        onblur={() => saveKey(name)}
        onkeydown={(e) => e.key === 'Enter' && saveKey(name)}
      />
    {/if}
  </Row>
{/snippet}

<style>
  .choices {
    display: grid;
    gap: var(--gap-s);
    margin-bottom: var(--gap-xl);
  }
  .field {
    width: 300px;
  }
  .on {
    color: var(--accent);
  }
  .error {
    margin: calc(var(--gap-l) * -1) 0 var(--gap-l);
    color: var(--bad);
  }
</style>
