<script lang="ts">
  import type { ModelItem } from '../../../shared/ipc/contract'
  import { TRANSLATOR_OPTIONS } from '../../../shared/models/translators'
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

  const models = $derived(store.models)
  const notice = $derived(store.modelNotice)
  const translator = $derived<TranslatorId>(store.config?.models.translator ?? 'index-2b')

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

  const missing = $derived(models?.items.filter((i) => i.path === null) ?? [])
  const anyActive = $derived(models?.items.some(isActive) ?? false)
  const anyStopped = $derived(models?.items.some(isStopped) ?? false)

  function percent(item: ModelItem): number {
    const d = item.download
    if (!d || d.totalBytes === 0) return 0
    return Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100))
  }

  function stateText(item: ModelItem): string {
    if (item.download && item.download.status !== 'done') return modelLabel.downloadStatus(item.download.status)
    if (item.path === null) return t.models.missing
    return modelLabel.check(item.check)
  }

  function stateClass(item: ModelItem): string {
    if (item.path === null) return 'bad'
    if (item.check === 'ok') return 'good'
    if (item.check === 'size-mismatch' || item.check === 'hash-mismatch' || item.check === 'unreadable') return 'warn'
    return 'muted'
  }
</script>

{#if models}
  {#if models.needsSetup}
    <div class="setup">
      <strong>{t.models.setupTitle}</strong>
      <p>{modelLabel.setupBody(models.missingBytes)}</p>
    </div>
  {/if}
  {#if !models.downloadsAllowed}
    <p class="muted">{t.models.devNote}</p>
  {/if}

  {#if store.config?.translate.engine === 'local'}
    <h2>{t.models.translatorTitle}</h2>
    <div class="translators">
      {#each TRANSLATOR_OPTIONS as option (option.id)}
        <label class="translator" class:active={translator === option.id}>
          <input type="radio" name="translator" value={option.id} checked={translator === option.id} onchange={() => pickTranslator(option.id)} />
          <strong>{option.displayName}</strong>
          <span class="muted">{formatBytes(option.size)} · {t.models.vram(formatBytes(option.vramBytes))}</span>
          <span class="muted note">{option.note}</span>
          <span class="muted note">{t.models.license}：{option.license}</span>
        </label>
      {/each}
    </div>
    <p class="muted small">{t.models.translatorNote}</p>
  {/if}

  <h2>{t.models.folder}</h2>
  <div class="row">
    <code class="path">{models.modelsDir}</code>
    <button type="button" class="btn" onclick={modelsPickFolder}>{t.models.pickFolder}</button>
    <button type="button" class="btn" onclick={modelsLocateFolder}>{t.models.locateFolder}</button>
  </div>

  {#if notice}
    <div class="notice" role="status">
      <span class={notice.code === 'size-mismatch' || notice.code === 'unreadable' ? 'warn' : 'muted'}>{modelLabel.notice(notice.code)}</span>
      {#if notice.code === 'size-mismatch' && notice.role && notice.path}
        {@const role = notice.role}
        {@const path = notice.path}
        <code class="path">{path}</code>
        <button type="button" class="btn" onclick={() => modelsUseFile(role, path)}>{t.models.useAnyway}</button>
      {/if}
    </div>
  {/if}

  <table>
    <thead>
      <tr>
        <th>{t.models.columns.name}</th>
        <th>{t.models.columns.file}</th>
        <th>{t.models.columns.size}</th>
        <th>{t.models.columns.state}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each models.items as item (item.role)}
        <tr>
          <td>
            {item.displayName}
            {#if item.bundled}<span class="muted tag">{t.models.bundledNote}</span>{/if}
          </td>
          <td>
            <div>{item.fileName}</div>
            <div class="muted small">{item.path ?? item.expectedPath}</div>
          </td>
          <td>{formatBytes(item.size)}</td>
          <td>
            {#if item.download && item.download.status !== 'done' && item.download.status !== 'queued'}
              <div class="bar" title="{percent(item)}%"><div class="fill" style="width: {percent(item)}%"></div></div>
              <div class="small">
                {modelLabel.downloadStatus(item.download.status)} {percent(item)}%
                {#if item.download.bytesPerSecond > 0}· {modelLabel.speed(item.download.bytesPerSecond)}{/if}
                {#if item.download.source}· {modelLabel.source(item.download.source)}{/if}
              </div>
              {#if item.download.errorCode}
                <div class="bad small">{modelLabel.downloadError(item.download.errorCode)}</div>
              {/if}
            {:else}
              <span class={stateClass(item)}>{stateText(item)}</span>
              {#if item.path !== null && item.origin !== 'missing'}
                <span class="muted small">· {modelLabel.origin(item.origin)}</span>
              {/if}
            {/if}
          </td>
          <td class="actions">
            {#if isActive(item)}
              <button type="button" class="btn" onclick={() => modelsDownload('pause', item.role)}>{t.models.pause}</button>
              <button type="button" class="btn" onclick={() => modelsDownload('cancel', item.role)}>{t.models.cancel}</button>
            {:else if isStopped(item) && item.path === null}
              <button type="button" class="btn" onclick={() => modelsDownload('resume', item.role)}>
                {item.download?.status === 'error' ? t.models.retry : t.models.resume}
              </button>
            {:else if item.path === null && models.downloadsAllowed}
              <button type="button" class="btn" onclick={() => modelsDownload('start', item.role)}>{t.models.downloadOne}</button>
            {/if}
            <button type="button" class="btn" onclick={() => modelsPickFile(item.role)}>{t.models.pickFile}</button>
            {#if item.origin === 'config'}
              <button type="button" class="btn" onclick={() => modelsClearPath(item.role)}>{t.models.resetPath}</button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if models.downloadsAllowed}
    <div class="row">
      {#if missing.length > 0 && !anyActive}
        <button type="button" class="btn primary" onclick={() => modelsDownload('start')}>{t.models.download}</button>
      {/if}
      {#if anyActive}
        <button type="button" class="btn" onclick={() => modelsDownload('pause')}>{t.models.pause}</button>
        <button type="button" class="btn" onclick={() => modelsDownload('cancel')}>{t.models.cancel}</button>
      {/if}
      {#if anyStopped && !anyActive}
        <button type="button" class="btn" onclick={() => modelsDownload('resume')}>{t.models.resume}</button>
      {/if}
    </div>
  {/if}
{:else}
  <p class="muted">…</p>
{/if}

<style>
  .translators {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 8px;
    max-width: 960px;
  }
  .translator {
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
  .translator.active {
    border-color: #6b9eff;
  }
  .translator input {
    grid-row: span 4;
    margin-top: 3px;
  }
  .translator .muted {
    font-size: 12px;
  }
  .small {
    font-size: 12px;
  }
  .setup {
    padding: 10px 14px;
    margin-bottom: 14px;
    background: #2a3550;
    border-radius: 8px;
  }
  .setup p {
    margin: 6px 0 0;
  }
  .path {
    padding: 2px 6px;
    background: #2b2d30;
    border-radius: 4px;
    word-break: break-all;
  }
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 8px 0 12px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    padding: 6px 8px;
    text-align: left;
    color: #8a8d93;
    font-weight: 500;
    border-bottom: 1px solid #393b40;
  }
  td {
    padding: 8px;
    vertical-align: top;
    border-bottom: 1px solid #2b2d30;
  }
  .small {
    font-size: 12px;
  }
  .tag {
    margin-left: 6px;
    font-size: 12px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }
  .bar {
    width: 220px;
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
