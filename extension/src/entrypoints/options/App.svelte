<!-- RawReader extension: options page. Replaces the LMT setup wizard. New file. -->
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import identity from "../../../../app-identity.json";
  import BridgeSettings from "@/lib/components/settings/BridgeSettings.svelte";
  import InpaintSettings from "@/lib/components/settings/InpaintSettings.svelte";
  import TypographySettings from "@/lib/components/settings/TypographySettings.svelte";
  import SiteRulesSettings from "@/lib/components/settings/SiteRulesSettings.svelte";
  import { defaultUserSettings, loadUserSettings, saveUserSettings } from "@/lib/user-settings";

  const initial = defaultUserSettings();
  let alwaysInpaint = $state(initial.alwaysInpaint);
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
      textFont,
      customFonts: $state.snapshot(customFonts),
      customRules: $state.snapshot(customRules),
    });
  }

  $effect(() => {
    if (loading) return;
    [alwaysInpaint, textFont, customFonts.length, customRules.length];
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
    <BridgeSettings />
    <InpaintSettings bind:alwaysInpaint />
    <TypographySettings bind:textFont bind:customFonts />
    <SiteRulesSettings bind:customRules />

    <section class="panel-card !p-2.5 flex flex-col gap-1.5">
      <span class="kicker">关于与许可</span>
      <p class="text-[11px] text-[var(--text-muted)] leading-snug">
        {identity.productName} 插件 v{version}。文字识别和翻译都在你电脑上的 {identity.productName} 应用里完成，插件只和 127.0.0.1 通信，没有遥测。
      </p>
      <p class="text-[11px] text-[var(--text-muted)] leading-snug">
        许可证：AGPL-3.0。部分代码移植自 libre-manga-translator（AGPL-3.0-or-later），详见仓库中的 extension/THIRD_PARTY_NOTICES.md。
      </p>
    </section>
  {/if}
</main>