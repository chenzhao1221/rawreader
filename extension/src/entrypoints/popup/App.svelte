<!-- Portions ported from libre-manga-translator src/entrypoints/popup/App.svelte @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
     AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
     RawReader changes: one pipeline (the app bridge). The mode switch, language pickers, detector, OCR and backend
     settings are gone; a connection status line and a link to the options page took their place. -->
<script lang="ts">
  import { Plug, Settings as SettingsIcon, CircleCheck, CircleAlert, History as HistoryIcon } from "lucide-svelte";
  import ReadingHistory from "@/lib/components/ReadingHistory.svelte";
  import { READING_HISTORY_ENABLED_KEY } from "@/lib/reading-history";
  import { onDestroy, onMount } from "svelte";
  import { getSiteRule } from "@/lib/adapters";
  import { describeBackendStatus } from "@/lib/direct/status";
  import { defaultUserSettings, loadUserSettings, saveUserSettings, type UserSettings } from "@/lib/user-settings";
  import {
    loadSeriesContext,
    resetSeriesContext,
    saveSeriesContextSettings,
  } from "@/lib/series-context-store";

  let { hostname = "", title = "", path = "" }: { hostname?: string; title?: string; path?: string } = $props();

  let seriesName = $state("Unknown Series");
  let ruleId = $state("");
  let settings = $state<UserSettings>(defaultUserSettings());
  let seriesContext = $state<SeriesContext>({
    seriesName: "",
    summary: "",
    dictionary: "",
    lastChapterId: null,
    lastPageIndex: null,
    recentHistory: [],
    translatedCount: 0,
  });

  let showContextDrawer = $state(false);
  // The reading history replaces the popup's content while it is open.
  let showHistory = $state(false);
  let historyEnabled = $state(true);
  async function setHistoryEnabled(value: boolean) {
    historyEnabled = value;
    await storage.setItem(READING_HISTORY_ENABLED_KEY, value);
  }
  let loadingSettings = $state(true);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let status = $state<{ kind: "checking" | "ok" | "warn" | "error"; text: string }>({ kind: "checking", text: "正在检查连接…" });

  async function checkConnection() {
    status = { kind: "checking", text: "正在检查连接…" };
    try {
      status = describeBackendStatus(await browser.runtime.sendMessage({ type: "BACKEND_STATUS" }));
    } catch (err) {
      status = { kind: "error", text: `检查失败：${(err as Error).message ?? err}` };
    }
  }

  async function loadAll() {
    const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
    const hardTimer = setTimeout(() => (loadingSettings = false), 2000);
    try {
      ({ ruleId, seriesName } = await withTimeout(
        getSiteRule(undefined, hostname, title, path),
        1500,
        { ruleId: "", seriesName: "Unknown Series" } as any,
      ));
      seriesContext.seriesName = seriesName;
      settings = await withTimeout(loadUserSettings(), 1500, defaultUserSettings());
      seriesContext = await loadSeriesContext(seriesName);
    } finally {
      clearTimeout(hardTimer);
      loadingSettings = false;
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveSeriesContextSettings(seriesName, {
      summary: seriesContext.summary,
      dictionary: seriesContext.dictionary,
      seriesName: seriesContext.seriesName,
    }).catch((err) => console.warn("RawReader: series-context save failed:", err));
    saveUserSettings($state.snapshot(settings) as UserSettings).catch((err) => console.warn("RawReader: settings save failed:", err));
  }

  async function handleResetSeriesContext() {
    if (
      !confirm(
        `要重置“${seriesContext.seriesName || seriesName}”的作品上下文吗？\n\n这会清除用于保持翻译连贯的摘要、术语表和最近的页面记录，已缓存的页面会保留。`,
      )
    ) {
      return;
    }
    try {
      await resetSeriesContext(seriesName);
      seriesContext = {
        ...seriesContext,
        seriesName,
        summary: "",
        dictionary: "",
        lastChapterId: null,
        lastPageIndex: null,
        recentHistory: [],
        translatedCount: 0,
      };
    } catch (err) {
      console.warn("RawReader: series-context reset failed:", err);
    }
  }

  $effect(() => {
    if (loadingSettings) return;
    [
      settings.autoTranslate,
      settings.autoTranslateConcurrency,
      settings.skipBboxRefining,
      settings.alwaysInpaint,
      seriesContext.seriesName,
      seriesContext.summary,
      seriesContext.dictionary,
    ];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 150);
  });

  onMount(() => {
    void loadAll();
    void checkConnection();
    void storage.getItem<boolean>(READING_HISTORY_ENABLED_KEY).then((value) => (historyEnabled = value !== false));
  });
  onDestroy(saveNow);
</script>

<main
  class="w-[360px] h-[540px] max-w-[360px] max-h-[540px] bg-[var(--bg-void-0)] text-[var(--text-primary)] font-body flex flex-col overflow-hidden select-none"
>
  <header class="flex items-center justify-between px-3.5 py-2.5 border-b border-[var(--border-line)] shrink-0">
    <div class="flex items-center gap-2 min-w-0">
      <img src="/icon/48.png" alt="" class="w-6 h-6 rounded-md shrink-0 object-contain" />
      <span class="font-display font-semibold text-[13px] tracking-tight truncate">RawReader</span>
    </div>
    <div class="flex items-center gap-1.5">
      <button
        type="button"
        onclick={() => (showHistory = true)}
        class="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer border border-[var(--border-line)] text-[var(--text-muted)] hover:text-[var(--accent-amber)]"
      >
        <HistoryIcon size={12} />
        历史
      </button>
      <button
        type="button"
        onclick={() => browser.runtime.openOptionsPage()}
        class="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer border border-[var(--border-line)] text-[var(--text-muted)] hover:text-[var(--accent-amber)]"
      >
        <SettingsIcon size={12} />
        设置
      </button>
    </div>
  </header>

  {#if showHistory}
    <ReadingHistory onBack={() => (showHistory = false)} />
  {:else}
  <div class="flex-1 overflow-y-auto custom-scrollbar p-3 flex flex-col gap-2.5 min-h-0">
    <!-- Connection -->
    <section class="panel-card !p-2 flex flex-col gap-1.5">
      <div class="flex items-center justify-between">
        <span class="kicker">应用连接</span>
        <button
          type="button"
          onclick={checkConnection}
          class="flex items-center gap-1 text-[11px] text-[var(--text-dim)] hover:text-[var(--accent-cyan)] cursor-pointer"
        >
          <Plug size={11} />
          重新检查
        </button>
      </div>
      <div
        class="flex items-start gap-1.5 text-xs leading-snug {status.kind === 'ok'
          ? 'text-[var(--accent-emerald)]'
          : status.kind === 'warn'
            ? 'text-[var(--accent-amber)]'
            : status.kind === 'error'
              ? 'text-[var(--accent-rose)]'
              : 'text-[var(--text-dim)]'}"
        role="status"
      >
        {#if status.kind === "ok"}
          <CircleCheck size={13} class="shrink-0 mt-0.5" />
        {:else if status.kind !== "checking"}
          <CircleAlert size={13} class="shrink-0 mt-0.5" />
        {/if}
        <span>{status.text}</span>
      </div>
    </section>

    <!-- Quick toggles -->
    <section class="grid grid-cols-2 gap-2">
      <div class="panel-card !p-2 flex flex-col justify-between gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium">自动翻译</span>
          <label class="switch-cyber is-emerald">
            <input type="checkbox" bind:checked={settings.autoTranslate} />
            <span class="track"><span class="thumb"></span></span>
          </label>
        </div>
        <span class="text-[11px] text-[var(--text-muted)] leading-tight">
          {settings.autoTranslate ? `最多同时翻译 ${settings.autoTranslateConcurrency} 页` : "已关闭（右键图片手动翻译）"}
        </span>
      </div>

      <div class="panel-card !p-2 flex flex-col justify-between gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium">直接翻译</span>
          <label class="switch-cyber is-amber">
            <input type="checkbox" bind:checked={settings.skipBboxRefining} />
            <span class="track"><span class="thumb"></span></span>
          </label>
        </div>
        <span class="text-[11px] text-[var(--text-muted)] leading-tight">
          {settings.skipBboxRefining ? "跳过文本框调整" : "先调整文本框"}
        </span>
      </div>

      <div class="col-span-2 panel-card !p-2 flex items-center justify-between gap-1.5">
        <div class="flex flex-col">
          <span class="text-xs font-medium">记录阅读历史</span>
          <span class="text-[11px] text-[var(--text-muted)] leading-tight">
            {historyEnabled ? "翻译过的页面记在本机，可在“历史”里查看" : "已关闭，已有记录不会删除"}
          </span>
        </div>
        <label class="switch-cyber shrink-0">
          <input type="checkbox" checked={historyEnabled} onchange={(e) => setHistoryEnabled(e.currentTarget.checked)} />
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>

      <div class="col-span-2 panel-card !p-2 flex items-center justify-between gap-1.5">
        <div class="flex flex-col">
          <span class="text-xs font-medium">总是擦字重绘</span>
          <span class="text-[11px] text-[var(--text-muted)] leading-tight">
            {settings.alwaysInpaint ? "质量检查未通过时仍强制擦字重绘" : "质量检查未通过时保持原样"}
          </span>
        </div>
        <label class="switch-cyber is-emerald shrink-0">
          <input type="checkbox" bind:checked={settings.alwaysInpaint} />
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
    </section>

    <!-- Series context -->
    <section class="panel-card !p-2 flex flex-col gap-1.5">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="badge-cyber is-cyan shrink-0">{ruleId || "网站"}</span>
          <span class="text-xs font-medium truncate">{seriesName}</span>
        </div>
        <button
          type="button"
          onclick={() => (showContextDrawer = !showContextDrawer)}
          class="text-xs text-[var(--text-dim)] hover:text-[var(--accent-cyan)] cursor-pointer shrink-0 transition-colors"
        >
          {showContextDrawer ? "收起术语表" : "术语表 ▾"}
        </button>
      </div>

      {#if showContextDrawer}
        <div class="pt-1.5 border-t border-[var(--border-faint)] flex flex-col gap-1.5">
          <input
            type="text"
            bind:value={seriesContext.seriesName}
            placeholder="自定义作品标题..."
            class="w-full bg-[var(--bg-void)] border border-[var(--border-faint)] rounded-lg px-2 py-1 text-xs outline-none focus:border-[var(--border-line)] placeholder:text-[var(--text-dim)]"
          />
          <textarea
            bind:value={seriesContext.summary}
            placeholder="剧情摘要或世界观背景..."
            rows={2}
            class="w-full bg-[var(--bg-void)] border border-[var(--border-faint)] rounded-lg p-1.5 text-xs outline-none resize-none focus:border-[var(--border-line)] placeholder:text-[var(--text-dim)]"
          ></textarea>
          <textarea
            bind:value={seriesContext.dictionary}
            placeholder="人物术语表（例如 Kuro -> 小黑）..."
            rows={2}
            class="w-full bg-[var(--bg-void)] border border-[var(--border-faint)] rounded-lg p-1.5 text-xs outline-none resize-none focus:border-[var(--border-line)] placeholder:text-[var(--text-dim)]"
          ></textarea>
          <button
            type="button"
            onclick={handleResetSeriesContext}
            class="self-start text-[10px] uppercase tracking-wide text-[var(--text-dim)] hover:text-[var(--accent-rose)] cursor-pointer transition-colors"
            title="清除该作品的摘要、术语表和页面记录"
          >
            重置作品上下文
          </button>
        </div>
      {/if}
    </section>
  </div>

  {/if}

  <footer class="px-3.5 py-2 border-t border-[var(--border-line)] shrink-0 flex items-center justify-between text-[11px] text-[var(--text-dim)] bg-[var(--bg-void)]">
    <span class="truncate">在漫画上点右键，选「翻译这张图片」</span>
    <span class="text-[var(--text-muted)] truncate max-w-[120px]">{seriesName}</span>
  </footer>
</main>