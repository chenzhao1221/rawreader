<!-- Portions ported from libre-manga-translator src/lib/components/Sidebar.svelte @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
     AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
     RawReader changes: one pipeline (the app bridge). The mode switch, language pickers, detector, OCR, backend,
     GPU and model-storage panels are gone; a connection status line replaced them. -->
<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { onDestroy } from "svelte";
  import { Settings, X, Cpu, Type, HardDrive, LoaderCircle, Plug, CircleCheck, CircleAlert } from "lucide-svelte";
  import { getSiteRule } from "@/lib/adapters";
  import { describeBackendStatus } from "@/lib/direct/status";
  import { defaultUserSettings, loadUserSettings, saveUserSettings, type UserSettings } from "@/lib/user-settings";
  import AutoTranslateToggle from "./settings/AutoTranslateToggle.svelte";
  import TypographySettings from "./settings/TypographySettings.svelte";
  import SiteRulesSettings from "./settings/SiteRulesSettings.svelte";
  import DebugPanel from "./settings/DebugPanel.svelte";
  import InpaintSettings from "./settings/InpaintSettings.svelte";
  import {
    loadSeriesContext,
    resetSeriesContext,
    saveSeriesContextSettings,
  } from "@/lib/series-context-store";

  let isOpen = $state(false);
  let activeSection = $state<string>("pipeline");
  const manifestVersion = (browser.runtime.getManifest() as any).version_name || browser.runtime.getManifest().version;

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
  let saveTimer: ReturnType<typeof setTimeout>;
  let loadingSettings = $state(true);
  let seriesName = $state("");
  let status = $state<{ kind: "checking" | "ok" | "warn" | "error"; text: string }>({ kind: "checking", text: "正在检查连接…" });

  const SECTIONS = [
    { id: "pipeline", label: "翻译", icon: Cpu, accent: "cyan" },
    { id: "appearance", label: "渲染", icon: Type, accent: "emerald" },
    { id: "system", label: "系统", icon: HardDrive, accent: "rose" },
  ];
  let systemView = $state<"settings" | "logs">("settings");

  async function checkConnection() {
    status = { kind: "checking", text: "正在检查连接…" };
    try {
      status = describeBackendStatus(await browser.runtime.sendMessage({ type: "BACKEND_STATUS" }));
    } catch (err) {
      status = { kind: "error", text: `检查失败：${(err as Error).message ?? err}` };
    }
  }

  async function loadSettings() {
    try {
      const rule = await getSiteRule();
      seriesName = rule.seriesName;
      seriesContext.seriesName = seriesName;
      settings = await loadUserSettings();
      // The store returns the composed context (settings + history); the UI only edits the settings fields,
      // so history is carried through untouched and never re-saved from here.
      seriesContext = await loadSeriesContext(seriesName);
    } finally {
      loadingSettings = false;
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    // Series context is saved separately so a stale editor can never clobber page-accumulated history.
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

  onDestroy(saveNow);

  $effect(() => {
    if (loadingSettings) return;
    [
      settings.autoTranslate, settings.autoTranslateConcurrency, settings.skipBboxRefining, settings.alwaysInpaint,
      settings.textFont, settings.customFonts.length, settings.customRules.length,
      seriesContext.seriesName, seriesContext.summary, seriesContext.dictionary,
    ];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 150);
  });

  $effect(() => {
    if (isOpen) {
      void loadSettings();
      void checkConnection();
    }
  });

  $effect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") isOpen = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<!-- FLOATING TRIGGER -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  role="presentation"
  class="fixed bottom-6 right-6 z-99999 font-sans pointer-events-auto"
  onmousedown={(e) => e.stopPropagation()}
  onpointerdown={(e) => e.stopPropagation()}
  onclick={(e) => {
    e.stopPropagation();
    e.preventDefault();
  }}
>
  <button
    type="button"
    onclick={(e) => {
      e.stopPropagation();
      e.preventDefault();
      isOpen = !isOpen;
    }}
    class="w-11 h-11 bg-[var(--surface-panel)] text-[var(--text-primary)] rounded-lg shadow-xl flex items-center justify-center cursor-pointer hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] hover:shadow-[0_0_12px_var(--accent-cyan-glow)] transition-all border border-[var(--border-line)]"
    title="RawReader 设置"
    aria-label="打开或关闭设置面板"
  >
    {#if isOpen}
      <X size={18} />
    {:else}
      <Settings size={18} />
    {/if}
  </button>
</div>

<!-- SLIDING PANEL (360px Void-0 Contract) -->
{#if isOpen}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 bg-black/25 z-99998 pointer-events-auto"
    transition:fade={{ duration: 180 }}
    onmousedown={(e) => e.stopPropagation()}
    onpointerdown={(e) => e.stopPropagation()}
    onclick={(e) => {
      e.stopPropagation();
      e.preventDefault();
      isOpen = false;
    }}
  ></div>

  <!-- Panel -->
  <div
    role="presentation"
    class="fixed top-0 right-0 bottom-0 w-[360px] max-w-[95vw] bg-[var(--bg-void-0)]/95 backdrop-blur-md text-[var(--text-primary)] shadow-2xl z-99999 flex flex-col font-body border-l border-[var(--border-line)] pointer-events-auto select-none"
    transition:fly={{ x: 360, duration: 220 }}
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    onkeyup={(e) => e.stopPropagation()}
    onkeypress={(e) => e.stopPropagation()}
    onmousedown={(e) => e.stopPropagation()}
    onpointerdown={(e) => e.stopPropagation()}
    onwheel={(e) => e.stopPropagation()}
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-3.5 py-3 border-b border-[var(--border-line)] shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        <img
          src={browser.runtime.getURL("/icon/48.png")}
          alt=""
          class="w-6 h-6 rounded-md shrink-0 object-contain"
        />
        <span class="font-display font-semibold text-[13px] tracking-tight truncate">RawReader</span>
      </div>
      <button
        type="button"
        onclick={() => (isOpen = false)}
        class="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent-rose)] rounded-md cursor-pointer hover:bg-[var(--surface-panel-alt)] transition-colors"
        aria-label="关闭设置"
      >
        <X size={15} />
      </button>
    </div>

    <!-- 4 quiet tabs with distinctive domain accents -->
    <div class="grid grid-cols-3 border-b border-[var(--border-line)] shrink-0">
      {#each SECTIONS as s}
        {@const Icon = s.icon}
        {@const isActive = activeSection === s.id}
        <button
          type="button"
          onclick={() => { activeSection = s.id; systemView = "settings"; }}
          aria-current={isActive ? "page" : undefined}
          class="flex items-center justify-center gap-1.5 py-2.5 px-1 text-center transition-colors cursor-pointer border-b-2
                 {isActive
                   ? (s.accent === 'cyan'
                       ? 'border-b-[var(--accent-cyan)] bg-[var(--surface-panel)] text-[var(--accent-cyan)] font-semibold'
                       : s.accent === 'amber'
                         ? 'border-b-[var(--accent-amber)] bg-[var(--surface-panel)] text-[var(--accent-amber)] font-semibold'
                         : s.accent === 'emerald'
                           ? 'border-b-[var(--accent-emerald)] bg-[var(--surface-panel)] text-[var(--accent-emerald)] font-semibold'
                           : 'border-b-[var(--accent-rose)] bg-[var(--surface-panel)] text-[var(--accent-rose)] font-semibold')
                   : 'border-b-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-panel-alt)]/50'}"
        >
          <Icon size={13} />
          <span class="font-medium text-xs tracking-tight truncate">{s.label}</span>
        </button>
      {/each}
    </div>

    <!-- Content area -->
    <div class="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3 min-h-0">
      {#if loadingSettings}
        <div class="flex flex-col items-center justify-center py-16 gap-3">
          <LoaderCircle size={24} class="animate-spin text-[var(--accent-cyan)]" />
          <span class="text-xs text-[var(--text-dim)]">加载中…</span>
        </div>
      {:else}
        {#if activeSection === "pipeline"}
          <div class="space-y-3">
            <div class="panel-card !p-2 flex flex-col gap-1.5">
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
              <button
                type="button"
                onclick={() => browser.runtime.sendMessage({ type: "OPEN_SETUP_TAB" })}
                class="btn-ghost w-full justify-center py-1.5 text-xs font-bold"
              >
                端口与配对码…
              </button>
            </div>

            <AutoTranslateToggle bind:autoTranslate={settings.autoTranslate} bind:concurrency={settings.autoTranslateConcurrency} />
          </div>
        {/if}

        {#if activeSection === "appearance"}
          <div class="space-y-3">
            <InpaintSettings bind:alwaysInpaint={settings.alwaysInpaint} />

            <TypographySettings bind:textFont={settings.textFont} bind:customFonts={settings.customFonts} />

            <div class="panel-card !p-2.5 flex flex-col gap-2">
              <span class="kicker">作品上下文与术语表</span>
              <div class="flex flex-col gap-2">
                <input
                  type="text"
                  bind:value={seriesContext.seriesName}
                  placeholder="作品标题（例如 One Piece）..."
                  class="w-full bg-[var(--bg-void)] border border-[var(--border-faint)] rounded-lg p-2 text-xs outline-none focus:border-[var(--border-line)] placeholder:text-[var(--text-dim)]"
                />
                <textarea
                  bind:value={seriesContext.summary}
                  placeholder="剧情摘要或世界观背景..."
                  rows={2}
                  class="w-full bg-[var(--bg-void)] custom-scrollbar border border-[var(--border-faint)] rounded-lg p-2 text-xs outline-none resize-none focus:border-[var(--border-line)] placeholder:text-[var(--text-dim)]"
                ></textarea>
                <textarea
                  bind:value={seriesContext.dictionary}
                  placeholder="人物术语表（例如 Kuro -> 小黑）..."
                  rows={2}
                  class="w-full bg-[var(--bg-void)] custom-scrollbar border border-[var(--border-faint)] rounded-lg p-2 text-xs outline-none resize-none focus:border-[var(--border-line)] placeholder:text-[var(--text-dim)]"
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
            </div>
          </div>
        {/if}

        {#if activeSection === "system"}
          {#if systemView === "logs"}
            <div class="space-y-3">
              <DebugPanel showList={true} onBack={() => (systemView = "settings")} />
            </div>
          {:else}
            <div class="space-y-3">
              <div class="panel-card !p-2.5 flex flex-col gap-2">
                <span class="kicker">网站规则</span>
                <SiteRulesSettings bind:customRules={settings.customRules} />
              </div>

              <DebugPanel compact onOpenLogs={() => (systemView = "logs")} />
            </div>
          {/if}
        {/if}
      {/if}
    </div>

    <div class="px-3.5 py-2 border-t border-[var(--border-line)] flex items-center justify-between shrink-0 text-[11px] text-[var(--text-dim)] bg-[var(--bg-void)]">
      <span class="flex items-center gap-1.5 min-w-0">
        <span class="pulse-dot"></span>
        <span class="truncate text-[var(--text-muted)]">RawReader 应用 · 本机运行</span>
      </span>
      <span class="shrink-0 font-mono text-[10px]">v{manifestVersion}</span>
    </div>
  </div>
{/if}
