<!-- Portions ported from libre-manga-translator src/lib/components/settings/InpaintSettings.svelte @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
     AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
     RawReader changes: the LaMa model choice and its download UI are gone. Only the algorithmic ladder is left. -->
<script lang="ts">
  import { DefaultConfig } from "@/lib/configs";

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
          复杂背景也强制擦字（可能留痕）
        </span>
      </div>
      <label class="switch-cyber is-emerald">
        <input type="checkbox" bind:checked={alwaysInpaint} />
        <span class="track"><span class="thumb"></span></span>
      </label>
    </div>
  </div>
</div>
