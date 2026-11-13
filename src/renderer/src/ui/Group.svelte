<script lang="ts">
  import type { Snippet } from 'svelte'

  let { title, actions, children }: { title?: string; actions?: Snippet; children: Snippet } = $props()
</script>

<section class="group">
  {#if title || actions}
    <header>
      {#if title}<h3>{title}</h3>{/if}
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="card">
    {@render children()}
  </div>
</section>

<style>
  .group {
    margin-bottom: var(--gap-xl);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--gap);
    margin: 0 0 var(--gap-s) 2px;
  }
  h3 {
    margin: 0;
    color: var(--text-dim);
    font-size: var(--text-s);
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .actions {
    display: flex;
    gap: var(--gap-s);
    margin-left: auto;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  /* Rows inside a card are separated by hairlines. */
  .card > :global(* + *) {
    border-top: 1px solid var(--border);
  }
</style>
