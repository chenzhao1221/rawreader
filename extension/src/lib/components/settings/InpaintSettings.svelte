<!-- Portions ported from libre-manga-translator src/lib/components/settings/InpaintSettings.svelte @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
     AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
     RawReader changes: the LaMa model choice and its download UI are gone. Only the algorithmic ladder is left. -->
<script lang="ts">
  import { DefaultConfig } from "@/lib/configs";
  import { Info } from "lucide-svelte";

  let {
    alwaysInpaint = $bindable(DefaultConfig.alwaysInpaint),
  }: {
    alwaysInpaint?: boolean;
  } = $props();
</script>

<div class="space-y-1.5">
  <span class="kicker ml-0.5">
    擦字重绘
  </span>
  <div class="panel-card !p-2.5 space-y-2.5">
    <div class="flex items-center justify-between">
      <div class="flex flex-col">
        <span class="text-[13px] font-medium text-[var(--text-primary)]">
          总是擦字重绘
        </span>
        <span class="text-[11px] text-[var(--text-muted)]">
          即使质量检查未通过也强制擦字重绘（不会保留原文字区域）
        </span>
      </div>
      <label class="switch-cyber is-emerald">
        <input type="checkbox" bind:checked={alwaysInpaint} />
        <span class="track"><span class="thumb"></span></span>
      </label>
    </div>

    <div
      class="flex gap-1.5 p-2 bg-[var(--bg-void)] border border-[var(--border-line)] rounded-lg text-[var(--text-muted)] text-[11px] leading-snug"
    >
      <Info size={12} class="shrink-0 mt-0.5 text-[var(--accent-cyan)]" />
      <p>
        擦字使用无模型的分级方案：平面填充 → 双边降噪 → Telea 快速行进。
      </p>
    </div>
  </div>
</div>
