<!-- RawReader extension: the reading history in the popup. Pages the user translated, kept in this browser's extension
     storage only (not the browser's own history, not synced, not uploaded). Search, open, delete one, clear all. -->
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ArrowLeft, Search, Trash2, X } from "lucide-svelte";
  import {
    MSG_HISTORY_CLEAR,
    MSG_HISTORY_REMOVE,
    READING_HISTORY_KEY,
    groupHistory,
    isSafeHistoryUrl,
    parseHistory,
    searchHistory,
    type HistoryEntry,
  } from "@/lib/reading-history";

  let { onBack }: { onBack: () => void } = $props();

  let entries = $state<HistoryEntry[]>([]);
  let query = $state("");
  let loaded = $state(false);
  let unwatch: (() => void) | undefined;

  const shown = $derived(searchHistory(entries, query));
  const groups = $derived(groupHistory(shown, Date.now()));

  async function load() {
    entries = parseHistory(await storage.getItem(READING_HISTORY_KEY));
    loaded = true;
  }

  function when(entry: HistoryEntry, group: string): string {
    const d = new Date(entry.lastVisitedAt);
    if (group === "更早") return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  /** Opens the page in a new tab. Only web addresses are opened. */
  async function open(entry: HistoryEntry) {
    if (!isSafeHistoryUrl(entry.url)) return;
    await browser.tabs.create({ url: entry.url });
  }

  async function remove(entry: HistoryEntry) {
    entries = entries.filter((e) => e.id !== entry.id);
    await browser.runtime.sendMessage({ type: MSG_HISTORY_REMOVE, id: entry.id }).catch(() => {});
  }

  async function clearAll() {
    if (entries.length === 0) return;
    if (!confirm("要清空全部阅读历史吗？\n\n只会删除这个插件保存的记录，不会影响浏览器自己的历史记录。")) return;
    entries = [];
    await browser.runtime.sendMessage({ type: MSG_HISTORY_CLEAR }).catch(() => {});
  }

  onMount(() => {
    void load();
    // A page translated while the popup is open shows up without reopening it.
    unwatch = storage.watch(READING_HISTORY_KEY, (value) => {
      entries = parseHistory(value);
    });
  });
  onDestroy(() => unwatch?.());
</script>

<div class="flex-1 min-h-0 flex flex-col gap-2 p-3">
  <div class="flex items-center gap-2 shrink-0">
    <button
      type="button"
      onclick={onBack}
      class="flex items-center gap-1 px-2 py-1 text-xs rounded-md cursor-pointer border border-[var(--border-line)] text-[var(--text-muted)] hover:text-[var(--accent-amber)]"
    >
      <ArrowLeft size={12} />
      返回
    </button>
    <label class="flex-1 flex items-center gap-1.5 bg-[var(--bg-void)] border border-[var(--border-faint)] rounded-lg px-2 py-1 focus-within:border-[var(--border-line)]">
      <Search size={12} class="text-[var(--text-dim)] shrink-0" />
      <input
        type="text"
        bind:value={query}
        placeholder="搜索标题、网址、站点、作品名"
        class="w-full bg-transparent text-xs outline-none placeholder:text-[var(--text-dim)] select-text"
      />
    </label>
  </div>

  <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col gap-2" data-testid="history-list">
    {#if loaded && entries.length === 0}
      <p class="text-xs text-[var(--text-dim)] text-center py-8 leading-relaxed">
        还没有阅读历史。<br />翻译一页漫画后，这里会记下这一页。
      </p>
    {:else if loaded && shown.length === 0}
      <p class="text-xs text-[var(--text-dim)] text-center py-8">没有符合的记录。</p>
    {/if}

    {#each groups as group (group.name)}
      <section class="flex flex-col gap-1">
        <span class="kicker">{group.name}</span>
        {#each group.entries as entry (entry.id)}
          <div class="panel-card !p-1.5 flex items-center gap-1.5 group" data-history-id={entry.id}>
            <button
              type="button"
              onclick={() => open(entry)}
              class="flex-1 min-w-0 text-left cursor-pointer flex flex-col gap-0.5"
              title={entry.url}
            >
              <span class="text-xs font-medium truncate text-[var(--text-primary)]">{entry.title || entry.url}</span>
              <span class="text-[11px] text-[var(--text-muted)] truncate">
                {entry.site}{entry.series ? ` · ${entry.series}` : ""} · {when(entry, group.name)}
              </span>
            </button>
            <button
              type="button"
              onclick={() => remove(entry)}
              aria-label="删除这条记录"
              title="删除这条记录"
              class="shrink-0 p-1 rounded text-[var(--text-dim)] hover:text-[var(--accent-rose)] cursor-pointer"
            >
              <X size={13} />
            </button>
          </div>
        {/each}
      </section>
    {/each}
  </div>

  <div class="shrink-0 flex items-center justify-between text-[11px] text-[var(--text-dim)]">
    <span>只保存在这个浏览器里，共 {entries.length} 条</span>
    <button
      type="button"
      onclick={clearAll}
      disabled={entries.length === 0}
      class="flex items-center gap-1 cursor-pointer hover:text-[var(--accent-rose)] disabled:opacity-40 disabled:cursor-default"
    >
      <Trash2 size={11} />
      清空全部
    </button>
  </div>
</div>
