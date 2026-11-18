<!-- RawReader extension: connection status. The extension finds the app by itself; there is nothing to enter. New file. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { CircleCheck, CircleAlert, LoaderCircle, Plug } from "lucide-svelte";
  import { describePingReply } from "@/lib/bridge/status";
  import type { BridgePingMessage } from "@/lib/bridge/protocol";

  let checking = $state(false);
  let outcome = $state<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);

  async function check() {
    checking = true;
    outcome = null;
    try {
      const message: BridgePingMessage = { type: "BRIDGE_PING" };
      outcome = describePingReply(await browser.runtime.sendMessage(message));
    } catch (err) {
      outcome = { kind: "error", text: `检测失败：${(err as Error).message ?? err}` };
    } finally {
      checking = false;
    }
  }

  onMount(() => void check());
</script>

<div class="panel-card !p-2.5 flex flex-col gap-2">
  <span class="kicker is-cyan">连接 RawReader 应用</span>
  <p class="text-[11px] text-[var(--text-muted)] leading-snug">
    不用设置端口或配对码。打开 RawReader 应用后，插件会自动找到它并连接，每次翻译前也会重新检测。
  </p>

  <button type="button" onclick={check} disabled={checking} class="btn-ghost w-full justify-center py-1.5 text-xs font-bold">
    {#if checking}
      <LoaderCircle size={13} class="animate-spin" />
    {:else}
      <Plug size={13} />
    {/if}
    重新检测
  </button>

  {#if outcome}
    <div
      class="flex items-start gap-1.5 text-[11px] leading-snug {outcome.kind === 'ok'
        ? 'text-[var(--accent-emerald)]'
        : outcome.kind === 'warn'
          ? 'text-[var(--accent-amber)]'
          : 'text-[var(--accent-rose)]'}"
      role="status"
    >
      {#if outcome.kind === "ok"}
        <CircleCheck size={13} class="shrink-0 mt-0.5" />
      {:else}
        <CircleAlert size={13} class="shrink-0 mt-0.5" />
      {/if}
      <span>{outcome.text}</span>
    </div>
  {/if}
</div>