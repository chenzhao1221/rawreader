<!-- RawReader extension: controls when a detection failure offers manual box selection. -->
<script lang="ts">
  import { defaultUserSettings } from "@/lib/user-settings";

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
          出错时不弹出手动框选
        </span>
        <span class="text-[11px] text-[var(--text-muted)]">
          网络或接口报错时仅提示错误；画面确实无气泡时仍会提示手动框选
        </span>
      </div>
      <label class="switch-cyber is-emerald">
        <input type="checkbox" bind:checked={manualSelectOnlyWhenNoText} />
        <span class="track"><span class="thumb"></span></span>
      </label>
    </div>
  </div>
</div>
