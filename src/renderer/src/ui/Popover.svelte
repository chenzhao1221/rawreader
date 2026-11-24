<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    /** The toolbar button this popover hangs from. Presses on it are left to that button's own toggle. */
    anchor: HTMLElement | undefined
    label: string
    /** Any CSS width, e.g. "400px" or "min(680px, calc(100vw - 16px))". */
    width: string
    onclose: () => void
    children: Snippet
  }

  let { anchor, label, width, onclose, children }: Props = $props()

  let panel: HTMLDivElement | undefined = $state()
  let top = $state(0)
  let left = $state(0)

  /** Under the anchor, right edge aligned to the anchor, kept inside the window. */
  function place(): void {
    if (!anchor || !panel) return
    const r = anchor.getBoundingClientRect()
    const w = panel.offsetWidth
    top = r.bottom + 6
    left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target
    if (!(target instanceof Node)) return
    if (panel?.contains(target) || anchor?.contains(target)) return
    onclose()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onclose()
    }
  }

  onMount(() => {
    place()
    // Capture phase, so the press closes the popover even when the page under it stops propagation.
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', place)
    panel?.focus()
  })

  onDestroy(() => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', place)
  })
</script>

<div
  class="popover"
  bind:this={panel}
  role="dialog"
  aria-label={label}
  tabindex="-1"
  style:top="{top}px"
  style:left="{left}px"
  style:width={width}
>
  {@render children()}
</div>

<style>
  .popover {
    position: fixed;
    z-index: 100;
    display: flex;
    flex-direction: column;
    height: min(600px, calc(100vh - 90px));
    box-sizing: border-box;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-l);
    box-shadow: var(--shadow);
    overflow: hidden;
    outline: none;
    font-size: var(--text-m);
  }
</style>
