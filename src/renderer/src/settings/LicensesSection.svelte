<script lang="ts">
  import { zhCN as t } from '../i18n/zh-CN'
  import { store } from '../state.svelte'

  let selected = $state('notices')

  const documents = $derived(store.licenses?.documents ?? [])
  const current = $derived(documents.find((d) => d.id === selected) ?? documents[0])
</script>

<h2>{t.licenses.heading}</h2>
{#if store.licenses === null}
  <p class="muted">{t.licenses.loading}</p>
{:else}
  <div class="row">
    {#each documents as doc (doc.id)}
      <button type="button" class="btn" class:primary={current?.id === doc.id} onclick={() => (selected = doc.id)}>
        {t.licenses.docs[doc.id] ?? doc.title}
      </button>
    {/each}
  </div>
  <pre>{current?.text ?? ''}</pre>
{/if}

<style>
  pre {
    margin: 10px 0 0;
    padding: 12px 14px;
    max-height: calc(100vh - 220px);
    overflow: auto;
    color: #c9ccd2;
    background: #25272b;
    border-radius: 8px;
    font-family: Consolas, 'Microsoft YaHei UI', monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
