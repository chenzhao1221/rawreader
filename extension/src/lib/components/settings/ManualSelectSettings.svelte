<!-- RawReader extension: controls when a detection failure offers manual box selection. -->
<script lang="ts">
  import { defaultUserSettings } from "@/lib/user-settings";
  import { Info } from "lucide-svelte";

  let {
    manualSelectOnlyWhenNoText = $bindable(defaultUserSettings().manualSelectOnlyWhenNoText),
  }: {
    manualSelectOnlyWhenNoText?: boolean;
  } = $props();
</script>

<div class="space-y-1.5">
  <span class="kicker ml-0.5">
    识别失败时
  </span>
  <div class="panel-card !p-2.5 space-y-2.5">
    <div class="flex items-center justify-between">
      <div class="flex flex-col">
        <span class="text-[13px] font-medium text-[var(--text-primary)]">
          仅在未找到文本时提示手动框选
        </span>
        <span class="text-[11px] text-[var(--text-muted)]">
          开启时，报错（网络、超时、接口错误等）只显示错误提示；关闭时，报错后也会弹出手动框选
        </span>
      </div>
      <label class="switch-cyber is-emerald">
        <input type="checkbox" bind:checked={manualSelectOnlyWhenNoText} />
        <span class="track"><span class="thumb"></span></span>
      </label>
    </div>

    <div
      class="flex gap-1.5 p-2 bg-[var(--bg-void)] border border-[var(--border-line)] rounded-lg text-[var(--text-muted)] text-[11px] leading-snug"
    >
      <Info size={12} class="shrink-0 mt-0.5 text-[var(--accent-cyan)]" />
      <p>
        页面确实没有文字气泡时，仍会弹出手动框选，这个开关不影响它。
      </p>
    </div>
  </div>
</div>
