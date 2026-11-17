<!-- Portions ported from libre-manga-translator src/lib/components/settings/DebugPanel.svelte @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
     AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader. -->
<script lang="ts">
  import { getDebugLogs, clearDebugLogs } from "@/entrypoints/content/debug";
  import { Check, Copy, Download, LoaderCircle, RefreshCw, Trash2, TriangleAlert } from "lucide-svelte";

  const DEBUG_ENABLED_KEY = "local:debug-enabled";

  let {
    // Compact mode (System tab default): toggle row only, plus an
    // "open logs" affordance once debugging is enabled.
    compact = false,
    onOpenLogs,
    // Controlled list visibility for the System ⇄ Logs view swap.
    showList,
    onBack,
  }: {
    compact?: boolean;
    onOpenLogs?: () => void;
    showList?: boolean;
    onBack?: () => void;
  } = $props();

  let logs = $state<DebugEntry[]>([]);
  let loading = $state(false);
  let copied = $state(false);
  let copiedId = $state<string | null>(null);
  let expandedId = $state<string | null>(null);
  let debugEnabled = $state(false);
  let togglingEnabled = $state(false);
  let internalOpen = $state(false);

  // Controlled when the parent swaps views; uncontrolled otherwise.
  const listOpen = $derived(showList ?? internalOpen);

  async function loadLogs() {
    loading = true;
    try {
      logs = await getDebugLogs();
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    (async () => {
      debugEnabled = (await storage.getItem<boolean>(DEBUG_ENABLED_KEY)) ?? false;
      loadLogs();
    })();
  });

  async function toggleEnabled() {
    togglingEnabled = true;
    debugEnabled = !debugEnabled;
    await storage.setItem(DEBUG_ENABLED_KEY, debugEnabled);
    if (!debugEnabled) {
      internalOpen = false;
      expandedId = null;
    }
    togglingEnabled = false;
  }

  function openLogs() {
    if (onOpenLogs) onOpenLogs();
    else {
      internalOpen = true;
      loadLogs();
    }
  }

  async function handleClear() {
    await clearDebugLogs();
    logs = [];
  }

  function handleCopy() {
    navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function handleCopyOne(id: string) {
    const log = logs.find((l) => l.id === id);
    if (!log) return;
    navigator.clipboard.writeText(JSON.stringify(log, null, 2));
    copiedId = id;
    setTimeout(() => (copiedId = null), 2000);
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(logs, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lmt-debug-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  function formatDuration(ms?: number): string {
    if (ms === undefined) return "-";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
</script>

{#if listOpen}
<!-- Privacy / Sensitive Data Notice (log view only) -->
<div
  class="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-300/60 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-950/15 text-amber-800 dark:text-amber-200/90 text-xs"
>
  <TriangleAlert size={14} class="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400/80" />
  <div class="flex flex-col gap-0.5">
    <span class="font-semibold text-xs">敏感数据提示</span>
    <span class="text-[11px] opacity-80 leading-snug">
      调试日志会记录你浏览的页面上识别出的 OCR 文字、提示词和翻译结果。导出的日志若含敏感或隐私内容，请勿公开分享。
    </span>
  </div>
</div>
{/if}

<!-- Enable toggle row (always visible, compact) -->
<div
  class="panel-card !p-3 flex items-center justify-between gap-2"
>
  <div class="flex flex-col gap-0.5 min-w-0">
    <span class="text-[13px] font-medium text-[var(--text-primary)]">
      调试日志
    </span>
    <span class="text-xs text-[var(--text-muted)]">
      {debugEnabled ? "正在记录翻译数据" : "已关闭"}
    </span>
  </div>
  <div class="flex items-center gap-2 shrink-0">
    {#if compact && debugEnabled && !listOpen}
      <button
        type="button"
        onclick={openLogs}
        class="btn-ghost !py-1.5 !px-2.5 !text-[11px]"
      >
        查看日志（{logs.length}）
      </button>
    {/if}
    <label class="switch-cyber is-rose">
      <input type="checkbox" checked={debugEnabled} onchange={toggleEnabled} disabled={togglingEnabled} />
      <span class="track"><span class="thumb"></span></span>
    </label>
  </div>
</div>

{#if !compact && debugEnabled && !listOpen}
  <button
    type="button"
    onclick={openLogs}
    class="btn-ghost w-full justify-center"
  >
    查看日志（{logs.length}）
  </button>
{/if}

{#if listOpen}
{#if onBack}
  <button
    type="button"
    onclick={onBack}
    class="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
  >
    ← 返回系统设置
  </button>
{/if}
<!-- Log list header -->
<div class="flex items-center justify-between mt-1">
  <span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
    日志（{logs.length}{logs.length === 50 ? "，已达上限" : ""}）
  </span>
  <div class="flex items-center gap-1">
    <button
      onclick={loadLogs}
      disabled={loading}
      class="p-1 text-zinc-400 hover:text-[var(--text-primary)] rounded cursor-pointer transition-colors"
      title="刷新"
    >
      <RefreshCw size={12} class={loading ? "animate-spin" : ""} />
    </button>
    {#if logs.length > 0}
      <button
        onclick={handleCopy}
        class="p-1 text-zinc-400 hover:text-[var(--text-primary)] rounded cursor-pointer transition-colors"
        title="复制 JSON"
      >
        {#if copied}<Check size={12} class="text-emerald-500" />{:else}<Copy size={12} />{/if}
      </button>
      <button
        onclick={handleExport}
        class="p-1 text-zinc-400 hover:text-[var(--text-primary)] rounded cursor-pointer transition-colors"
        title="导出 JSON"
      >
        <Download size={12} />
      </button>
      <button
        onclick={handleClear}
        class="p-1 text-zinc-400 hover:text-red-500 rounded cursor-pointer transition-colors"
        title="清空日志"
      >
        <Trash2 size={12} />
      </button>
    {/if}
  </div>
</div>

<!-- Log entries -->
<div class="space-y-2 mt-2">
  {#if logs.length === 0}
    <div class="text-center py-6 text-xs text-[var(--text-dim)] italic">
      {#if debugEnabled}
        暂无日志。翻译一个页面后即可记录数据。
      {:else}
        调试日志已关闭。请在上方开启后开始记录。
      {/if}
    </div>
  {:else}
    {#each logs as log (log.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="p-2 bg-[var(--surface-panel)] border border-[var(--border-faint)] rounded-lg text-xs cursor-pointer hover:border-[var(--border-line)] transition-all"
        onclick={() => (expandedId = expandedId === log.id ? null : log.id)}
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5 font-medium">
            <span
              class="w-2 h-2 rounded-full shrink-0 {log.success
                ? 'bg-[var(--accent-emerald)] shadow-[0_0_6px_var(--accent-emerald-glow)]'
                : 'bg-[var(--accent-rose)] shadow-[0_0_6px_var(--accent-rose-glow)]'}"
            ></span>
            <span class="font-mono text-[10px] text-[var(--text-dim)]">
              {formatTime(log.timestamp)}
            </span>
            <span
              class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase
              {log.mode === 'gemini'
                ? 'bg-[var(--accent-emerald-soft)] text-[var(--accent-emerald)] border border-[var(--accent-emerald)]/30'
                : log.mode === 'api'
                  ? 'bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] border border-[var(--accent-cyan)]/30'
                  : 'bg-[var(--accent-amber-soft)] text-[var(--accent-amber)] border border-[var(--accent-amber)]/30'}"
            >
              {log.mode}
            </span>
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-[var(--text-dim)] font-mono">
            <button
              onclick={(e) => {
                e.stopPropagation();
                handleCopyOne(log.id);
              }}
              class="p-1 text-[var(--text-dim)] hover:text-[var(--text-primary)] rounded cursor-pointer transition-colors"
              title="将此条复制为 JSON"
              aria-label="复制此条 JSON"
            >
              {#if copiedId === log.id}
                <Check size={12} class="text-[var(--accent-emerald)]" />
              {:else}
                <Copy size={12} />
              {/if}
            </button>
            <span>{log.bboxCount}b</span>
            {#if log.untranslated?.length}
              <span
                class="text-[var(--accent-amber)]"
                title="输出与原文相同的文本框"
              >
                {log.untranslated.length} 个回显
              </span>
            {/if}
            <span>{formatDuration(log.timing?.total)}</span>
          </div>
        </div>

        {#if log.error}
          <div class="mt-1 text-[10px] text-[var(--accent-rose)] font-mono truncate">
            {log.error}
          </div>
        {/if}

        {#if expandedId === log.id}
          <div
            class="mt-2 pt-2 border-t border-[var(--border-faint)] space-y-2"
          >
            <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono text-[var(--text-dim)]">
              <div>{log.sourceLang} → {log.targetLang}</div>
              <div>总计：{formatDuration(log.timing?.total)}</div>
              {#if log.timing?.detect}
                <div>检测：{formatDuration(log.timing.detect)}</div>
              {/if}
              {#if log.timing?.ocr}
                <div>OCR: {formatDuration(log.timing.ocr)}</div>
              {/if}
              {#if log.timing?.translate}
                <div>翻译：{formatDuration(log.timing.translate)}</div>
              {/if}
              {#if log.timing?.inpaint}
                <div>擦字重绘：{formatDuration(log.timing.inpaint)}</div>
              {/if}
              {#if log.untranslated?.length}
                <div class="col-span-2 text-[var(--accent-amber)]">
                  未翻译的文本框：{log.untranslated.map((i) => i + 1).join(", ")}
                </div>
              {/if}
            </div>

            <!-- Models & pipeline metadata -->
            <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono text-[var(--text-muted)]">
              {#if log.models?.detection}
                <div class="flex items-center gap-1">
                  <span class="text-[var(--text-dim)] uppercase">检测:</span>
                  <span title="{log.models.detection}">{log.models.detection}</span>
                </div>
              {/if}
              {#if log.models?.ocr}
                <div class="flex items-center gap-1 truncate">
                  <span class="text-[var(--text-dim)] uppercase">OCR:</span>
                  <span title="{log.models.ocr}">{log.models.ocr}</span>
                </div>
              {/if}
              {#if log.models?.llm}
                <div class="flex items-center gap-1 truncate">
                  <span class="text-[var(--text-dim)] uppercase">LLM:</span>
                  <span title="{log.models.llm}">{log.models.llm}</span>
                </div>
              {/if}
              {#if log.models?.server}
                <div class="flex items-center gap-1 truncate">
                  <span class="text-zinc-500 uppercase">服务器:</span>
                  <span title="{log.models.server}">{log.models.server}</span>
                </div>
              {/if}
              {#if log.inpaintMethod}
                <div class="flex items-center gap-1">
                  <span class="text-zinc-500 uppercase">擦字重绘:</span>
                  <span>{log.inpaintMethod}</span>
                </div>
              {/if}
              {#if log.inpaintStats}
                <div
                  class="col-span-2 text-[10px] font-mono text-zinc-500"
                  title="fill · denoise · lama · telea · rect-telea · declined · skipped"
                >
                  {log.inpaintStats.fill} fill ·
                  {log.inpaintStats.denoise} denoise ·
                  {#if (log.inpaintStats as any).lama}
                    {(log.inpaintStats as any).lama} lama ·
                  {/if}
                  {log.inpaintStats.telea} telea ·
                  {log.inpaintStats.rectTelea} rect
                  {#if log.inpaintStats.declined}
                    · <span class="text-red-400">{log.inpaintStats.declined} 个被拒</span>
                  {/if}
                  {#if log.inpaintStats.skipped}
                    · {log.inpaintStats.skipped} 个跳过
                  {/if}
                </div>
              {/if}
              {#if log.inpaintError}
                <div class="col-span-2 text-[10px] font-mono text-red-400 truncate" title="{log.inpaintError}">
                  擦字重绘错误：{log.inpaintError}
                </div>
              {/if}
              {#if log.inpaintLamaError}
                <div class="col-span-2 text-[10px] font-mono text-red-400 truncate" title="{log.inpaintLamaError}">
                  LaMa 错误：{log.inpaintLamaError}
                </div>
              {/if}
              {#if log.lamaStages}
                <div
                  class="col-span-2 text-[10px] font-mono text-zinc-500"
                  title="LaMa 阶段（按文本框计）：模型已重绘 · 太小未交给模型 · 模型失败 · 未尝试（会话未就绪，或失败后未执行到）。未由模型重绘的文本框都走了快速回退流程。"
                >
                  LaMa: {log.lamaStages.painted} 已重绘 ·
                  {log.lamaStages.skippedSize} 太小 ·
                  <span class:text-red-400={log.lamaStages.failed > 0}>
                    {log.lamaStages.failed} 失败
                  </span>
                  ·
                  <span class:text-red-400={log.lamaStages.notAttempted > 0}>
                    {log.lamaStages.notAttempted} 未尝试
                  </span>
                </div>
              {/if}
              {#if log.gate}
                <div
                  class="col-span-2 text-[10px] font-mono text-zinc-500"
                  title="模式 · 已检查区域 · 被拦下区域 · 语言组"
                >
                  闸门：{log.gate.mode} · {log.gate.checked} 已检查 ·
                  <span class:text-amber-500={log.gate.skipped > 0}>
                    {log.gate.skipped} 已跳过
                  </span>
                  {#if log.gate.group}· {log.gate.group}{/if}
                  {#if log.gate.groupSource === "fallback"}
                    · <span class="text-amber-500">推测</span>
                  {/if}
                  {#if log.gate.unavailable}
                    · <span class="text-red-400">模型不可用 - 仅文字</span>
                  {/if}
                </div>
              {/if}
              {#if log.langGroup}
                <div>
                  <span class="text-zinc-500 uppercase">语言组:</span> {log.langGroup}
                  {#if log.langGroupFallback}
                    <span class="text-amber-500" title="没有模型或检测结果给出语言组，此为推测值">
                      推测
                    </span>
                  {/if}
                </div>
              {/if}
              {#if log.llmCalls || log.promptChars || log.finishReason}
                <div class="col-span-2 text-[10px] font-mono text-zinc-500">
                  {#if log.llmCalls}{log.llmCalls} 次调用 ·{/if}
                  {#if log.promptChars}{log.promptChars} 个提示词字符 ·{/if}
                  结束原因：{log.finishReason ?? "未知"}
                  {#if log.truncated}
                    · <span class="text-red-400">已截断</span>
                  {/if}
                  {#if log.padded}
                    · <span class="text-red-400">已填充</span>
                  {/if}
                </div>
              {/if}
              {#if log.rawResponse}
                <details class="col-span-2">
                  <summary class="text-[10px] font-mono text-zinc-500 cursor-pointer">
                    原始响应（{log.rawResponse.length} 个字符）
                  </summary>
                  <pre
                    class="mt-1 p-1.5 rounded bg-[var(--surface-panel)] border border-[var(--border-faint)] text-[10px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">{log.rawResponse}</pre>
                </details>
              {/if}
              {#if log.version || log.device || log.backend}
                <div class="col-span-2 flex items-center gap-1.5 flex-wrap">
                  {log.version}{#if log.device} · {log.device}{/if}
                  {#if log.backend}
                    <span
                      class="px-1.5 rounded text-[9px] font-bold uppercase
                      {log.backend === 'webgpu'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                        : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'}"
                    >
                      {log.backend}
                    </span>
                  {/if}
                </div>
              {/if}
            </div>

            {#if log.sourceTexts && log.sourceTexts.length > 0}
              <div>
                <div class="text-[10px] font-bold uppercase text-zinc-400 mb-0.5">
                  OCR 原文
                </div>
                <div class="space-y-0.5 max-h-20 overflow-y-auto custom-scrollbar">
                  {#each log.sourceTexts as txt, i}
                    <div class="font-mono text-[10px] text-zinc-600 dark:text-zinc-400 truncate">
                      <strong class="text-zinc-400">#{i + 1}:</strong>
                      {txt || "（空）"}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            {#if log.translations && log.translations.length > 0}
              <div>
                <div class="text-[10px] font-bold uppercase text-zinc-400 mb-0.5">
                  译文
                </div>
                <div class="space-y-0.5 max-h-20 overflow-y-auto custom-scrollbar">
                  {#each log.translations as txt, i}
                    <div class="font-mono text-[10px] text-zinc-600 dark:text-zinc-400 truncate">
                      <strong class="text-zinc-400">#{i + 1}:</strong> {txt}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
{/if}
