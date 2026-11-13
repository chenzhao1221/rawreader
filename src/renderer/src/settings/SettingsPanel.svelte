<script lang="ts">
  import { zhCN as t } from '../i18n/zh-CN'
  import { closeSettings, selectTab, store } from '../state.svelte'
  import type { SettingsTab } from '../state.svelte'
  import AdvancedSection from './AdvancedSection.svelte'
  import ModelsSection from './ModelsSection.svelte'
  import ServersSection from './ServersSection.svelte'

  // The licence view is hidden: the notices ship in the installer (resources/licenses) and in the repository.
  // LicensesSection.svelte is kept so it can come back by adding 'licenses' here.
  const tabs: SettingsTab[] = ['models', 'servers', 'advanced']
</script>

<section class="panel" aria-label={t.settings.title}>
  <header>
    <h1>{t.settings.title}</h1>
    <div class="tabs" role="tablist">
      {#each tabs as tab (tab)}
        <button
          type="button"
          role="tab"
          class:active={store.tab === tab}
          aria-selected={store.tab === tab}
          onclick={() => selectTab(tab)}
        >
          {t.settings.tabs[tab]}
        </button>
      {/each}
    </div>
    <span class="spacer"></span>
    <button type="button" class="close" onclick={closeSettings}>{t.settings.close}</button>
  </header>

  <div class="body">
    {#if store.tab === 'models'}
      <ModelsSection />
    {:else if store.tab === 'servers'}
      <ServersSection />
    {:else if store.tab === 'advanced'}
      <AdvancedSection />
    {/if}
  </div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: #1e1f22;
    color: #dfe1e5;
  }
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 16px;
    background: #2b2d30;
    border-bottom: 1px solid #393b40;
  }
  h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tabs button {
    height: 28px;
    padding: 0 12px;
    color: #a9acb2;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    font: inherit;
    cursor: pointer;
  }
  .tabs button.active {
    color: #dfe1e5;
    border-bottom-color: #6b9eff;
  }
  .spacer {
    flex: 1;
  }
  .close {
    height: 28px;
    padding: 0 12px;
    color: inherit;
    background: #393b40;
    border: 0;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 24px 32px;
  }

  /* Shared look of the section components. */
  .body :global(h2) {
    margin: 22px 0 10px;
    font-size: 14px;
    font-weight: 600;
  }
  .body :global(h2:first-child) {
    margin-top: 0;
  }
  .body :global(.row) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
  }
  .body :global(.muted) {
    color: #8a8d93;
  }
  .body :global(.warn) {
    color: #e8c46a;
  }
  .body :global(.bad) {
    color: #ff8f88;
  }
  .body :global(.good) {
    color: #57c27a;
  }
  .body :global(button.btn) {
    height: 28px;
    padding: 0 12px;
    color: inherit;
    background: #393b40;
    border: 1px solid transparent;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  .body :global(button.btn:hover:not(:disabled)) {
    background: #45484e;
  }
  .body :global(button.btn:disabled) {
    opacity: 0.45;
    cursor: default;
  }
  .body :global(button.btn.primary) {
    background: #3d6fd8;
  }
  .body :global(input[type='text']),
  .body :global(input[type='number']),
  .body :global(select) {
    height: 28px;
    box-sizing: border-box;
    padding: 0 8px;
    color: inherit;
    background: #2b2d30;
    border: 1px solid #4e5157;
    border-radius: 6px;
    font: inherit;
  }
  .body :global(.field) {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 150px;
  }
  .body :global(.field > span) {
    color: #a9acb2;
    font-size: 12px;
  }
</style>
