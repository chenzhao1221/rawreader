<script lang="ts" generics="T extends string | number | null">
  let {
    value,
    options,
    label,
    onchange,
  }: { value: T; options: readonly { value: T; label: string }[]; label: string; onchange: (next: T) => void } = $props()
</script>

<div class="seg" role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={option.value === value}
      class:active={option.value === value}
      onclick={() => option.value !== value && onchange(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
  }
  button {
    height: 26px;
    padding: 0 12px;
    color: var(--text-dim);
    background: transparent;
    border: 0;
    border-radius: 4px;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  button:hover:not(.active) {
    color: var(--text);
  }
  button.active {
    color: var(--text);
    background: var(--surface-3);
  }
</style>
