<script lang="ts">
  import { zhCN as t } from '../i18n/zh-CN'
  import { closeSettings, selectTab, store } from '../state.svelte'
  import type { SettingsTab } from '../state.svelte'
  import AdvancedSection from './AdvancedSection.svelte'
  import BridgeTab from './BridgeTab.svelte'
  import EngineSection from './EngineSection.svelte'
  import ModelsSection from './ModelsSection.svelte'
  import ServersSection from './ServersSection.svelte'

  // The licence view is hidden: the notices ship in the installer (resources/licenses) and in the repository.
  // LicensesSection.svelte is kept so it can come back by adding 'licenses' here.
  const tabs: SettingsTab[] = ['engine', 'models', 'advanced', 'servers', 'bridge']

  /** 16px line icons, one per page. */
  const icons: Record<string, string> = {
    engine: 'M3 5h7M6.5 3v2M4.5 5c.6 2.6 2.5 4.6 5 5.5M9 5c-.5 2.4-2.2 4.6-5 6M10 13l2.5-6 2.5 6M10.8 11.2h3.4',
    models: 'M8 2 14 5v6l-6 3-6-3V5l6-3ZM2 5l6 3 6-3M8 8v6',
    advanced: 'M2 4h7M12 4h2M2 8h2M7 8h7M2 12h9M14 12h0M10.5 2.5v3M5.5 6.5v3M12.5 10.5v3',
    servers: 'M2.5 3h11v4h-11zM2.5 9h11v4h-11zM5 5h.01M5 11h.01',
    bridge: 'M6 2.5v3M10 2.5v3M4 5.5h8v3a4 4 0 0 1-8 0v-3ZM8 12.5v1',
  }
</script>

<section class="panel" aria-label={t.settings.title}>
  <div class="side" role="tablist" aria-orientation="vertical">
    <h1>{t.settings.title}</h1>
    {#each tabs as tab (tab)}
      <button type="button" role="tab" class:active={store.tab === tab} aria-selected={store.tab === tab} onclick={() => selectTab(tab)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d={icons[tab]} /></svg>
        {t.settings.tabs[tab]}
      </button>
    {/each}
    <span class="spacer"></span>
    <button type="button" class="close" onclick={closeSettings}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
      {t.settings.back}
    </button>
  </div>

  <div class="content">
    <div class="page">
      <h2 class="page-title">{t.settings.tabs[store.tab]}</h2>
      {#if store.tab === 'engine'}
        <EngineSection />
      {:else if store.tab === 'models'}
        <ModelsSection />
      {:else if store.tab === 'servers'}
        <ServersSection />
      {:else if store.tab === 'advanced'}
        <AdvancedSection />
      {:else if store.tab === 'bridge'}
        <BridgeTab />
      {/if}
    </div>
  </div>
</section>

<style>
  .panel {
    display: grid;
    grid-template-columns: 200px 1fr;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: var(--text-m);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--gap-l) var(--gap-s);
    background: var(--surface);
    border-right: 1px solid var(--border);
  }
  h1 {
    margin: 0 10px var(--gap);
    font-size: var(--text-l);
    font-weight: 600;
  }
  .side button {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    color: var(--text-dim);
    background: transparent;
    border: 0;
    border-radius: var(--radius-s);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .side button:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .side button.active {
    color: var(--text);
    background: var(--surface-3);
  }
  svg {
    width: 16px;
    height: 16px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .spacer {
    flex: 1;
  }
  .content {
    min-height: 0;
    overflow: auto;
  }
  .page {
    max-width: 760px;
    margin: 0 auto;
    padding: var(--gap-xl) var(--gap-xl) 64px;
  }
  .page-title {
    margin: 0 0 var(--gap-l);
    font-size: var(--text-xl);
    font-weight: 600;
  }
</style>
