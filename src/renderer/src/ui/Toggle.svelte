<script lang="ts">
  let {
    checked = false,
    disabled = false,
    label,
    onchange,
  }: { checked?: boolean; disabled?: boolean; label: string; onchange: (next: boolean) => void } = $props()
</script>

<button
  type="button"
  class="toggle"
  class:on={checked}
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={() => onchange(!checked)}
>
  <span class="knob"></span>
</button>

<style>
  .toggle {
    position: relative;
    width: 38px;
    height: 22px;
    flex: none;
    padding: 0;
    background: var(--surface-3);
    border: 0;
    border-radius: 11px;
    cursor: pointer;
    transition: background 0.18s;
  }
  .toggle.on {
    background: var(--accent);
  }
  .toggle:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.18s;
  }
  .on .knob {
    transform: translateX(16px);
  }
  @media (prefers-reduced-motion: reduce) {
    .toggle,
    .knob {
      transition: none;
    }
  }
</style>
