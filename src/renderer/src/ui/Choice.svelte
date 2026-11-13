<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    selected = false,
    disabled = false,
    title,
    onselect,
    children,
  }: { selected?: boolean; disabled?: boolean; title: string; onselect: () => void; children?: Snippet } = $props()
</script>

<button type="button" class="choice" class:selected class:disabled aria-pressed={selected} onclick={onselect}>
  <span class="mark" aria-hidden="true"></span>
  <span class="body">
    <span class="title">{title}</span>
    {#if children}<span class="meta">{@render children()}</span>{/if}
  </span>
</button>

<style>
  .choice {
    display: flex;
    align-items: flex-start;
    gap: var(--gap);
    width: 100%;
    padding: 14px 16px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .choice:hover {
    border-color: var(--border-strong);
  }
  .choice.selected {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  /* Too weak for this computer: still selectable, but visibly second-rate. */
  .choice.disabled .body {
    opacity: 0.5;
  }
  .mark {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 1px;
    box-sizing: border-box;
    border: 2px solid var(--border-strong);
    border-radius: 50%;
  }
  .selected .mark {
    border: 5px solid var(--accent);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .title {
    font-weight: 600;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
</style>
