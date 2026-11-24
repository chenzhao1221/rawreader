<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { historyGroup } from '../../../shared/history-group'
  import type { HistoryGroupName } from '../../../shared/history-group'
  import type { HistoryEntry } from '../../../shared/ipc/contract'
  import { zhCN as t } from '../i18n/zh-CN'
  import { closeHistory } from '../state.svelte'

  const PAGE = 100
  /** The list refreshes by itself, so a visit that the extension reports shows up while the page is open. */
  const REFRESH_MS = 3000

  let query = $state('')
  let entries = $state<HistoryEntry[]>([])
  let total = $state(0)
  let loaded = $state(false)
  let confirming = $state(false)
  let limit = PAGE
  let debounce: ReturnType<typeof setTimeout> | undefined
  let refresh: ReturnType<typeof setInterval> | undefined

  async function load(): Promise<void> {
    const asked = query
    const result = await window.rawreader.invoke('history:list', { query: asked, limit, offset: 0 })
    if (asked !== query) return
    if (result.ok) {
      entries = result.value.entries
      total = result.value.total
    }
    loaded = true
  }

  onMount(() => {
    void load()
    refresh = setInterval(() => void load(), REFRESH_MS)
  })
  onDestroy(() => {
    clearTimeout(debounce)
    clearInterval(refresh)
  })

  function onSearch(): void {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      limit = PAGE
      void load()
    }, 250)
  }

  function more(): void {
    limit += PAGE
    void load()
  }

  async function open(entry: HistoryEntry): Promise<void> {
    const result = await window.rawreader.invoke('tabs:new', { input: entry.url })
    if (result.ok) closeHistory()
  }

  async function remove(entry: HistoryEntry): Promise<void> {
    await window.rawreader.invoke('history:remove', { id: entry.id })
    await load()
  }

  async function clearAll(): Promise<void> {
    confirming = false
    await window.rawreader.invoke('history:clear')
    limit = PAGE
    await load()
  }

  const groups = $derived.by(() => {
    const now = Date.now()
    const out: Array<{ name: HistoryGroupName; entries: HistoryEntry[] }> = []
    // The list is newest first, so each day is one run of entries.
    for (const entry of entries) {
      const name = historyGroup(entry.lastVisitedAt, now)
      let group = out.at(-1)
      if (!group || group.name !== name) {
        group = { name, entries: [] }
        out.push(group)
      }
      group.entries.push(entry)
    }
    return out
  })

  const pad = (n: number): string => String(n).padStart(2, '0')
  function when(entry: HistoryEntry, name: HistoryGroupName): string {
    const d = new Date(entry.lastVisitedAt)
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    return name === 'earlier' ? `${d.getMonth() + 1}月${d.getDate()}日 ${time}` : time
  }
  const detail = (entry: HistoryEntry): string => {
    const parts = [entry.site]
    if (entry.series) parts.push(entry.chapter ? `${entry.series} ${entry.chapter}` : entry.series)
    if (entry.visits > 1) parts.push(t.history.visits(entry.visits))
    return parts.join(' · ')
  }
  const searching = $derived(query.trim() !== '')
</script>

<div class="bar">
  <input
    class="ui-input search"
    type="search"
    spellcheck="false"
    autocomplete="off"
    placeholder={t.history.searchPlaceholder}
    aria-label={t.history.searchPlaceholder}
    bind:value={query}
    oninput={onSearch}
  />
  <span class="count">{searching ? t.history.matched(total) : t.history.total(total)}</span>
  {#if confirming}
    <button type="button" class="ui-btn small danger" onclick={clearAll}>{t.history.clearConfirm}</button>
    <button type="button" class="ui-btn small ghost" onclick={() => (confirming = false)}>{t.history.clearCancel}</button>
  {:else}
    <button type="button" class="ui-btn small ghost" disabled={total === 0 && !searching} onclick={() => (confirming = true)}>{t.history.clear}</button>
  {/if}
</div>

{#if loaded && entries.length === 0}
  <p class="empty">{searching ? t.history.noMatch : t.history.empty}</p>
{/if}

{#each groups as group (group.name)}
  <h3 class="day">{t.history.groups[group.name]}</h3>
  <ul class="list">
    {#each group.entries as entry (entry.id)}
      <li class="row">
        <button type="button" class="open" title={entry.url} aria-label={`${t.history.open}：${entry.title || entry.site}`} onclick={() => open(entry)}>
          <span class="title">{entry.title || t.history.untitled}</span>
          <span class="meta">{detail(entry)}</span>
        </button>
        <span class="time">{when(entry, group.name)}</span>
        <button type="button" class="ui-btn small ghost del" title={t.history.removeTitle} aria-label={t.history.removeTitle} onclick={() => remove(entry)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </li>
    {/each}
  </ul>
{/each}

{#if entries.length < total}
  <button type="button" class="ui-btn ghost more" onclick={more}>{t.history.loadMore}</button>
{/if}

<p class="note">{t.history.note}</p>

<style>
  .note {
    margin: var(--gap-l) 0 0;
    color: var(--text-faint);
    font-size: var(--text-s);
    line-height: 1.6;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-s);
    margin-bottom: var(--gap);
  }
  .search {
    flex: 1 1 160px;
    min-width: 0;
  }
  .count {
    color: var(--text-dim);
    font-size: var(--text-s);
    white-space: nowrap;
  }
  .empty {
    margin: var(--gap-xl) 0;
    color: var(--text-faint);
    text-align: center;
  }
  .day {
    margin: var(--gap-l) 0 var(--gap-xs);
    color: var(--text-dim);
    font-size: var(--text-s);
    font-weight: 600;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--gap-s);
    padding: 0 var(--gap-s) 0 0;
  }
  .row + .row {
    border-top: 1px solid var(--border);
  }
  .row:hover {
    background: var(--surface-2);
  }
  .open {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 8px var(--gap);
    color: var(--text);
    background: transparent;
    border: 0;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .title,
  .meta {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .meta {
    color: var(--text-faint);
    font-size: var(--text-s);
  }
  .time {
    color: var(--text-faint);
    font-size: var(--text-s);
    white-space: nowrap;
  }
  .del {
    min-width: 26px;
    padding: 0;
  }
  svg {
    display: block;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .more {
    display: block;
    margin: var(--gap) auto 0;
  }
</style>
