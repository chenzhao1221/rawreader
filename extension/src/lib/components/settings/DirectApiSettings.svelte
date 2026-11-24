<!-- RawReader extension: translation backend and direct API settings (task 11). New file.
     The API key is saved in chrome.storage.local only and is never written to the log. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { CircleAlert, CircleCheck, LoaderCircle, Save } from "lucide-svelte";
  import { testDirect } from "@/lib/direct/client";
  import { describeDirectError } from "@/lib/direct/errors";
  import {
    PROVIDER_PRESETS,
    DEFAULT_MAX_TOKENS,
    MAX_MAX_TOKENS,
    MIN_MAX_TOKENS,
    getPreset,
    isDirectConfigured,
    isPresetOrigin,
    isProviderId,
    originPatternFor,
    validateBaseUrl,
    type BackendChoice,
    type DirectApiSettings,
    type ProviderId,
  } from "@/lib/direct/providers";
  import { loadBackendSettings, saveBackendSettings } from "@/lib/direct/settings";

  let loading = $state(true);
  let busy = $state(false);
  let choice = $state<BackendChoice>("auto");
  let provider = $state<ProviderId>("gemini");
  let baseUrl = $state("");
  let apiKey = $state("");
  let model = $state("");
  let maxTokens = $state(DEFAULT_MAX_TOKENS);
  let disableThinking = $state(true);
  let showKey = $state(false);
  let outcome = $state<{ kind: "ok" | "error"; text: string } | null>(null);

  const preset = $derived(getPreset(provider));

  const choices: { id: BackendChoice; label: string; hint: string }[] = [
    { id: "auto", label: "自动", hint: "检测到 RawReader 就用它，否则用下面的直连 API。" },
    { id: "rawreader", label: "只用 RawReader", hint: "本地识别和翻译，图片不会发到网上。" },
    { id: "direct", label: "只用直连 API", hint: "图片会发给下面的服务商，不需要打开 RawReader。" },
  ];

  onMount(async () => {
    try {
      const saved = await loadBackendSettings();
      choice = saved.choice;
      provider = saved.direct.provider;
      const defaults = getPreset(saved.direct.provider);
      baseUrl = saved.direct.baseUrl || defaults.baseUrl;
      model = saved.direct.model || defaults.models[0] || "";
      apiKey = saved.direct.apiKey;
      maxTokens = saved.direct.maxTokens;
      disableThinking = saved.direct.disableThinking;
    } finally {
      loading = false;
    }
  });

  function onProviderChange(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!isProviderId(value)) return;
    provider = value;
    const next = getPreset(value);
    baseUrl = next.baseUrl;
    model = next.models[0] ?? "";
    outcome = null;
  }

  const current = (): DirectApiSettings => ({
    provider,
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    maxTokens: clampMaxTokens(maxTokens),
    disableThinking,
  });

  /** A whole number inside the allowed range; anything else (an empty or wrong field) gives the default. */
  function clampMaxTokens(value: number): number {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKENS;
    return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, n));
  }

  /** Validates the form, asks for the host permission when the host is not a preset, and saves. */
  async function save(): Promise<DirectApiSettings | null> {
    const settings = current();
    const touched = settings.apiKey || settings.baseUrl !== preset.baseUrl;
    if (choice !== "rawreader" && (touched || choice === "direct")) {
      const checked = validateBaseUrl(settings.baseUrl);
      if (!checked.ok) {
        outcome = { kind: "error", text: checked.reason };
        return null;
      }
      settings.baseUrl = checked.url;
      // Must be the first await after the click: browsers only allow the permission prompt from a user gesture.
      if (!isPresetOrigin(settings.baseUrl)) {
        const pattern = originPatternFor(settings.baseUrl);
        const granted = pattern ? await browser.permissions.request({ origins: [pattern] }).catch(() => false) : false;
        if (!granted) {
          outcome = { kind: "error", text: "没有获得访问这个地址的权限，设置没有保存。" };
          return null;
        }
      }
    }
    await saveBackendSettings({ choice, direct: settings });
    baseUrl = settings.baseUrl;
    return settings;
  }

  async function onSave(runTest: boolean) {
    busy = true;
    outcome = null;
    try {
      const saved = await save();
      if (!saved) return;
      if (!runTest) {
        outcome = { kind: "ok", text: "已保存。" };
        return;
      }
      if (!isDirectConfigured(saved)) {
        outcome = { kind: "error", text: "请先填写接口地址、API 密钥和模型名。" };
        return;
      }
      const result = await testDirect(saved);
      outcome =
        "error" in result
          ? { kind: "error", text: describeDirectError(result.error) ?? `测试失败（${result.error.code}）。` }
          : { kind: "ok", text: "已保存，连接正常。图片识别要选支持图片输入的模型。" };
    } catch (err) {
      outcome = { kind: "error", text: `保存失败：${(err as Error).message ?? err}` };
    } finally {
      busy = false;
    }
  }

  const field =
    "w-full bg-[var(--bg-void)] border border-[var(--border-faint)] rounded-lg p-2 text-xs outline-none focus:border-[var(--border-line)]";
  const label = "text-[10px] font-bold uppercase tracking-widest text-zinc-400";
</script>

<div class="panel-card !p-2.5 flex flex-col gap-2">
  <span class="kicker is-cyan">翻译后端</span>

  {#if loading}
    <span class="text-xs text-[var(--text-dim)]">加载中…</span>
  {:else}
    <div class="flex flex-col gap-1" role="radiogroup" aria-label="翻译后端">
      {#each choices as c (c.id)}
        <label class="flex items-start gap-1.5 text-xs cursor-pointer">
          <input type="radio" name="backend-choice" value={c.id} bind:group={choice} class="mt-0.5" />
          <span>
            <span class="font-bold">{c.label}</span>
            <span class="text-[11px] text-[var(--text-muted)]"> {c.hint}</span>
          </span>
        </label>
      {/each}
    </div>

    <div class="flex flex-col gap-1.5 border-t border-[var(--border-faint)] pt-2">
      <span class="text-[11px] font-bold">直连 API</span>
      <p class="text-[11px] text-[var(--text-muted)] leading-snug">
        一次请求同时识别并翻译为简体中文。图片会发给所选服务商，API 密钥仅保存在本机浏览器。
      </p>

      <label class="space-y-1">
        <span class={label}>服务商</span>
        <select class={field} value={provider} onchange={onProviderChange}>
          {#each PROVIDER_PRESETS as p (p.id)}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
      </label>

      <label class="space-y-1">
        <span class={label}>接口地址</span>
        <input class={field} type="url" bind:value={baseUrl} placeholder="https://api.example.com/v1" spellcheck="false" autocomplete="off" />
      </label>

      <label class="space-y-1">
        <span class={label}>API 密钥</span>
        <div class="flex gap-1.5">
          <input
            class={field}
            type={showKey ? "text" : "password"}
            bind:value={apiKey}
            placeholder="只保存在本机"
            spellcheck="false"
            autocomplete="off"
          />
          <button type="button" class="btn-ghost shrink-0 px-2 text-[11px]" onclick={() => (showKey = !showKey)}>
            {showKey ? "隐藏" : "显示"}
          </button>
        </div>
      </label>

      <label class="space-y-1">
        <span class={label}>模型名</span>
        <input class={field} type="text" bind:value={model} list="direct-api-models" spellcheck="false" autocomplete="off" />
        <datalist id="direct-api-models">
          {#each preset.models as m (m)}
            <option value={m}></option>
          {/each}
        </datalist>
      </label>

      <details class="flex flex-col gap-1.5 text-[11px]">
        <summary class="cursor-pointer font-bold text-[var(--text-muted)]">高级设置</summary>
        <label class="space-y-1">
          <span class={label}>输出上限（tokens）</span>
          <input class={field} type="number" min={MIN_MAX_TOKENS} max={MAX_MAX_TOKENS} step="256" bind:value={maxTokens} />
          <span class="text-[10px] text-[var(--text-muted)]">
            长图或字多时可调大；若服务商拒绝会自动降档重试（glm-4v-flash 上限 1024）。
          </span>
        </label>
        <label class="flex items-start gap-1.5 cursor-pointer">
          <input type="checkbox" class="mt-0.5" bind:checked={disableThinking} />
          <span>关闭模型思考（更快、更省输出）。只对智谱 GLM 和阿里云百炼生效。</span>
        </label>
      </details>

      <p class="text-[11px] text-[var(--text-muted)] leading-snug">{preset.hint}</p>
      {#if !isPresetOrigin(baseUrl)}
        <p class="text-[11px] text-[var(--accent-amber)] leading-snug">自定义地址：保存时浏览器会询问是否允许插件访问这个网站。</p>
      {/if}

      <div class="flex gap-1.5">
        <button type="button" class="btn-ghost flex-1 justify-center py-1.5 text-xs font-bold" disabled={busy} onclick={() => onSave(false)}>
          <Save size={13} />
          保存
        </button>
        <button type="button" class="btn-primary flex-1 justify-center py-1.5 text-xs font-bold" disabled={busy} onclick={() => onSave(true)}>
          {#if busy}
            <LoaderCircle size={13} class="animate-spin" />
          {/if}
          保存并测试
        </button>
      </div>

      {#if outcome}
        <div
          class="flex items-start gap-1.5 text-[11px] leading-snug {outcome.kind === 'ok' ? 'text-[var(--accent-emerald)]' : 'text-[var(--accent-rose)]'}"
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
  {/if}
</div>
