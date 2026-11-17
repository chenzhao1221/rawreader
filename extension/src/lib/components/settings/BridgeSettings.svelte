<!-- RawReader extension: connection to the RawReader app (port, pairing code, test). New file. -->
<script lang="ts">
  import { CircleCheck, CircleAlert, LoaderCircle, Plug } from "lucide-svelte";
  import { DefaultConfig } from "@/lib/configs";
  import { isValidPort, normalizeCode } from "@/lib/bridge/client";
  import { describePingReply } from "@/lib/bridge/status";
  import type { BridgePingMessage } from "@/lib/bridge/protocol";

  let {
    port = $bindable(DefaultConfig.bridgePort),
    code = $bindable(""),
  }: {
    port?: number;
    code?: string;
  } = $props();

  let testing = $state(false);
  let outcome = $state<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);

  const portOk = $derived(isValidPort(port));
  const codeOk = $derived(code.trim() === "" || normalizeCode(code) !== null);

  async function testConnection() {
    testing = true;
    outcome = null;
    try {
      const message: BridgePingMessage = { type: "BRIDGE_PING", data: { port, code } };
      outcome = describePingReply(await browser.runtime.sendMessage(message));
    } catch (err) {
      outcome = { kind: "error", text: `测试失败：${(err as Error).message ?? err}` };
    } finally {
      testing = false;
    }
  }
</script>

<div class="panel-card !p-2.5 flex flex-col gap-2">
  <span class="kicker is-cyan">连接 RawReader 应用</span>
  <p class="text-[11px] text-[var(--text-muted)] leading-snug">
    先在 RawReader 的设置里启用“浏览器插件桥接”，再把这里的端口和配对码改成和应用里显示的一致。
  </p>

  <label class="flex flex-col gap-1">
    <span class="text-xs font-medium">端口</span>
    <input
      type="number"
      min="1024"
      max="65535"
      bind:value={port}
      class="w-full bg-[var(--bg-void)] border rounded-lg p-2 text-xs outline-none {portOk ? 'border-[var(--border-faint)]' : 'border-[var(--accent-rose)]'}"
    />
  </label>

  <label class="flex flex-col gap-1">
    <span class="text-xs font-medium">配对码</span>
    <input
      type="password"
      autocomplete="off"
      spellcheck="false"
      placeholder="XXXX-XXXX-XXXX-XXXX"
      bind:value={code}
      class="w-full bg-[var(--bg-void)] border rounded-lg p-2 text-xs font-mono outline-none {codeOk ? 'border-[var(--border-faint)]' : 'border-[var(--accent-rose)]'}"
    />
    {#if !codeOk}
      <span class="text-[10px] text-[var(--accent-rose)]">配对码应为 16 位字母和数字。</span>
    {/if}
  </label>

  <button
    type="button"
    onclick={testConnection}
    disabled={testing || !portOk || !codeOk || code.trim() === ""}
    class="btn-ghost w-full justify-center py-1.5 text-xs font-bold"
  >
    {#if testing}
      <LoaderCircle size={13} class="animate-spin" />
    {:else}
      <Plug size={13} />
    {/if}
    测试连接
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