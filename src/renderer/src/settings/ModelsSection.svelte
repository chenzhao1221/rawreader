<script lang="ts">
  import type { ModelItem } from '../../../shared/ipc/contract'
  import { CUSTOM_TRANSLATOR, TRANSLATOR_OPTIONS } from '../../../shared/models/translators'
  import type { TranslatorId } from '../../../shared/models/translators'
  import { formatBytes, modelLabel, zhCN as t } from '../i18n/zh-CN'
  import {
    modelsClearPath,
    modelsDownload,
    modelsLocateFolder,
    modelsPickFile,
    modelsPickFolder,
    modelsUseFile,
    saveConfig,
    store,
  } from '../state.svelte'
  import Choice from '../ui/Choice.svelte'
  import Group from '../ui/Group.svelte'
  import Row from '../ui/Row.svelte'

  const models = $derived(store.models)
  const notice = $derived(store.modelNotice)
  const translator = $derived<TranslatorId>(store.config?.models.translator ?? 'index-2b')
  const local = $derived(store.config?.translate.engine === 'local')

  /** Switching the model restarts the translation server; a missing file shows up below with a download button. */
  async function pickTranslator(id: TranslatorId): Promise<void> {
    if (id === translator) return
    await saveConfig({ models: { translator: id } })
    const result = await window.rawreader.invoke('models:overview')
    if (result.ok) store.models = result.value
  }

  const isActive = (item: ModelItem): boolean =>
    item.download !== null && ['queued', 'downloading', 'verifying'].includes(item.download.status)
  const isStopped = (item: ModelItem): boolean =>
    item.download !== null && ['paused', 'cancelled', 'error'].includes(item.download.status)

  const missing = $derived(models?.items.filter((i) => i.path === null && i.size > 0) ?? [])
  const anyActive = $derived(models?.items.some(isActive) ?? false)

  function percent(item: ModelItem): number {
    const d = item.download
    if (!d || d.totalBytes === 0) return 0
    return Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100))
  }

  function dot(item: ModelItem): string {
    if (isActive(item)) return 'busy'
    if (item.path === null) return 'bad'
    if (item.check === 'ok') return 'good'
    if (item.check === 'size-mismatch' || item.check === 'hash-mismatch' || item.check === 'unreadable') return 'warn'
    return ''
  }

  /** The one line under the name: progress while downloading, else where the file is (or should go). */
  function detail(item: ModelItem): string {
    const d = item.download
    if (d && d.status !== 'done' && d.status !== 'queued') {
      const parts = [`${modelLabel.downloadStatus(d.status)} ${percent(item)}%`]
      if (d.bytesPerSecond > 0) parts.push(modelLabel.speed(d.bytesPerSecond))
      if (d.source) parts.push(modelLabel.source(d.source))
      if (d.errorCode) parts.push(modelLabel.downloadError(d.errorCode))
      return parts.join(' · ')
    }
    if (item.path !== null && item.check !== 'ok' && item.check !== 'unchecked' && item.check !== 'checking') return modelLabel.check(item.check)
    return item.path ?? item.expectedPath
  }
</script>

{#if models}
  {#if local}
    <div class="choices">
      {#each TRANSLATOR_OPTIONS as option (option.id)}
        <Choice title={option.displayName} selected={translator === option.id} onselect={() => pickTranslator(option.id)}>
          {#if option.id === CUSTOM_TRANSLATOR}
            <span class="ui-chip">GGUF</span>
          {:else}
            <span class="ui-chip">{formatBytes(option.size)}</span>
            <span class="ui-chip">{t.models.vram(formatBytes(option.vramBytes))}</span>
            {#if option.license.startsWith('Tencent')}<span class="ui-chip warn" title={option.license}>{t.models.regionLimited}</span>{/if}
          {/if}
        </Choice>
      {/each}
    </div>
  {/if}

  <Group title={t.models.files}>
    {#snippet actions()}
      {#if models.downloadsAllowed && missing.length > 0 && !anyActive}
        <button type="button" class="ui-btn small primary" onclick={() => missing.forEach((item) => void modelsDownload('start', item.role))}>
          {t.models.downloadAll(formatBytes(missing.reduce((sum, item) => sum + item.size, 0)))}
        </button>
      {/if}
      {#if anyActive}
        <button type="button" class="ui-btn small" onclick={() => modelsDownload('pause')}>{t.models.pause}</button>
      {/if}
    {/snippet}

    {#each models.items as item (item.role)}
      <div class="file">
        <span class="ui-dot {dot(item)}"></span>
        <div class="file-text">
          <div class="file-name">
            {item.displayName}
            {#if item.size > 0}<span class="size">{formatBytes(item.size)}</span>{/if}
          </div>
          <div class="ui-path" title={item.path ?? item.expectedPath}>{detail(item)}</div>
          {#if isActive(item)}<div class="ui-bar"><div style="width: {percent(item)}%"></div></div>{/if}
        </div>
        <div class="file-actions">
          {#if isActive(item)}
            <button type="button" class="ui-btn small ghost" onclick={() => modelsDownload('pause', item.role)}>{t.models.pause}</button>
            <button type="button" class="ui-btn small ghost" onclick={() => modelsDownload('cancel', item.role)}>{t.models.cancel}</button>
          {:else if isStopped(item) && item.path === null}
            <button type="button" class="ui-btn small" onclick={() => modelsDownload('resume', item.role)}>
              {item.download?.status === 'error' ? t.models.retry : t.models.resume}
            </button>
          {:else if item.path === null && models.downloadsAllowed && item.size > 0}
            <button type="button" class="ui-btn small primary" onclick={() => modelsDownload('start', item.role)}>{t.models.downloadOne}</button>
          {/if}
          {#if !item.bundled}
            <button type="button" class="ui-btn small ghost" onclick={() => modelsPickFile(item.role)}>{t.models.pickFile}</button>
          {/if}
          {#if item.origin === 'config'}
            <button type="button" class="ui-btn small ghost" onclick={() => modelsClearPath(item.role)}>{t.models.resetPath}</button>
          {/if}
        </div>
      </div>
    {/each}
  </Group>

  {#if notice}
    <div class="notice" role="status">
      <span>{modelLabel.notice(notice.code)}</span>
      {#if notice.code === 'size-mismatch' && notice.role && notice.path}
        {@const role = notice.role}
        {@const path = notice.path}
        <button type="button" class="ui-btn small" onclick={() => modelsUseFile(role, path)}>{t.models.useAnyway}</button>
      {/if}
    </div>
  {/if}

  <Group title={t.models.folder}>
    <Row label={t.models.folder} detail={models.modelsDir}>
      <button type="button" class="ui-btn small ghost" onclick={modelsLocateFolder}>{t.models.locateFolder}</button>
      <button type="button" class="ui-btn small" onclick={modelsPickFolder}>{t.models.pickFolder}</button>
    </Row>
  </Group>
{/if}

<style>
  .choices {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--gap-s);
    margin-bottom: var(--gap-xl);
  }
  .file {
    display: flex;
    align-items: center;
    gap: var(--gap);
    min-height: 60px;
    padding: 10px 16px;
    box-sizing: border-box;
  }
  .file-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
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
  .file-actions {
    display: flex;
    gap: var(--gap-xs);
    flex: none;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: var(--gap);
    margin: calc(var(--gap-l) * -1) 0 var(--gap-xl);
    padding: 10px 16px;
    color: var(--warn);
    background: rgba(227, 181, 91, 0.1);
    border-radius: var(--radius);
  }
</style>
