<!-- RawReader extension: options page. Replaces the LMT setup wizard. New file. -->
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import identity from "../../../../app-identity.json";
  import DirectApiSettings from "@/lib/components/settings/DirectApiSettings.svelte";
  import BridgeSettings from "@/lib/components/settings/BridgeSettings.svelte";
  import InpaintSettings from "@/lib/components/settings/InpaintSettings.svelte";
  import ManualSelectSettings from "@/lib/components/settings/ManualSelectSettings.svelte";
  import TypographySettings from "@/lib/components/settings/TypographySettings.svelte";
  import SiteRulesSettings from "@/lib/components/settings/SiteRulesSettings.svelte";
  import { defaultUserSettings, loadUserSettings, saveUserSettings } from "@/lib/user-settings";

  const initial = defaultUserSettings();
  let alwaysInpaint = $state(initial.alwaysInpaint);
  let manualSelectOnlyWhenNoText = $state(initial.manualSelectOnlyWhenNoText);
  let textFont = $state(initial.textFont);
  let customFonts = $state(initial.customFonts);
  let customRules = $state(initial.customRules);

  let loading = $state(true);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const version = browser.runtime.getManifest().version;

  onMount(async () => {
    try {
      const saved = await loadUserSettings();
      alwaysInpaint = saved.alwaysInpaint;
      manualSelectOnlyWhenNoText = saved.manualSelectOnlyWhenNoText;
      textFont = saved.textFont;
      customFonts = saved.customFonts;
      customRules = saved.customRules;
    } finally {
      loading = false;
    }
  });

  async function save() {
    // Read first so fields this page does not show (auto translate, concurrency) are written back unchanged.
    const current = await loadUserSettings();
    await saveUserSettings({
      ...current,
      alwaysInpaint,
      manualSelectOnlyWhenNoText,
      textFont,
      customFonts: $state.snapshot(customFonts),
      customRules: $state.snapshot(customRules),
    });
  }

  $effect(() => {
    if (loading) return;
    [alwaysInpaint, manualSelectOnlyWhenNoText, textFont, customFonts.length, customRules.length];

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save().catch((err) => console.warn("RawReader: settings save failed:", err)), 300);
  });

  onDestroy(() => clearTimeout(saveTimer));
</script>

<main class="max-w-[520px] mx-auto p-4 flex flex-col gap-3 bg-[var(--bg-void-0)] text-[var(--text-primary)] font-body min-h-screen">
  <header class="flex items-center gap-2">
    <img src="/icon/48.png" alt={identity.productName} class="w-7 h-7 rounded-md object-contain" />
    <h1 class="font-display font-semibold text-sm">{identity.productName} 插件设置</h1>
  </header>

  {#if loading}
    <span class="text-xs text-[var(--text-dim)]">加载中…</span>
  {:else}
    <DirectApiSettings />
    <BridgeSettings />
    <InpaintSettings bind:alwaysInpaint />
    <ManualSelectSettings bind:manualSelectOnlyWhenNoText />
    <TypographySettings bind:textFont bind:customFonts />
    <SiteRulesSettings bind:customRules />

    <section class="panel-card !p-2.5 flex flex-col gap-1.5">
      <span class="kicker">关于</span>
      <p class="text-[11px] text-[var(--text-muted)] leading-snug">
        {identity.productName} 插件 v{version}（AGPL-3.0）。无遥测；部分界面代码移植自 libre-manga-translator。
      </p>
    </section>
  {/if}
</main>