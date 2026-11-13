<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    label,
    detail,
    tone,
    children,
  }: {
    label: string
    /** One short line under the label: a value, a path, or a warning (with `tone`). */
    detail?: string
    tone?: 'warn' | 'bad'
    children?: Snippet
  } = $props()
</script>

<div class="row">
  <div class="text">
    <div class="label">{label}</div>
    {#if detail}<div class="detail {tone ?? ''}">{detail}</div>{/if}
  </div>
  {#if children}<div class="control">{@render children()}</div>{/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: var(--gap-l);
    min-height: 52px;
    padding: 10px 16px;
    box-sizing: border-box;
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .label {
    color: var(--text);
  }
  .detail {
    margin-top: 2px;
    color: var(--text-faint);
    font-size: var(--text-s);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail.warn {
    color: var(--warn);
    white-space: normal;
  }
  .detail.bad {
    color: var(--bad);
    white-space: normal;
  }
  .control {
    display: flex;
    align-items: center;
    gap: var(--gap-s);
    flex: none;
  }
</style>
