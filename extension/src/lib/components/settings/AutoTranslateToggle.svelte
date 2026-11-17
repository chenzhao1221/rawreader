<!-- Portions ported from libre-manga-translator src/lib/components/settings/AutoTranslateToggle.svelte @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
     AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader. -->
<script lang="ts">
  import { Zap } from "lucide-svelte";

  let {
    autoTranslate = $bindable(false),
    concurrency = $bindable(1),
  }: {
    autoTranslate?: boolean;
    concurrency?: number;
  } = $props();
</script>

<div class="panel-card !p-2.5">
  <div class="flex items-center justify-between gap-3">
    <div class="flex items-center gap-2.5 min-w-0">
      <div
        class="shrink-0 w-6 h-6 rounded-md border flex items-center justify-center bg-[var(--bg-void)] border-[var(--border-faint)] text-[var(--text-dim)]"
      >
        <Zap size={13} />
      </div>
      <div class="flex flex-col min-w-0">
        <span class="text-xs font-medium leading-tight text-[var(--text-primary)]">
          自动翻译页面
        </span>
        <span class="text-[11px] text-[var(--text-muted)] leading-tight">
          滚动时自动翻译页面
        </span>
      </div>
    </div>
    <label class="switch-cyber is-emerald ml-2">
      <input type="checkbox" bind:checked={autoTranslate} />
      <span class="track"><span class="thumb"></span></span>
    </label>
  </div>

  {#if autoTranslate}
    <div class="mt-2.5 pt-2 border-t border-[var(--border-faint)]">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[11px] font-medium text-[var(--text-muted)]">
          同时翻译数
        </span>
        <span class="text-[11px] font-medium px-1.5 py-px rounded bg-[var(--bg-void)] text-[var(--accent-emerald)] border border-[var(--accent-emerald)]/30">
          {concurrency}
        </span>
      </div>
      <input
        type="range"
        min="1"
        max="10"
        step="1"
        bind:value={concurrency}
        disabled={!autoTranslate}
        class="slider-cyber is-emerald"
      />
      <div class="flex justify-between text-[10px] text-[var(--text-dim)] mt-0.5">
        <span>1（逐页）</span>
        <span>10（最大）</span>
      </div>
    </div>
  {/if}
</div>
