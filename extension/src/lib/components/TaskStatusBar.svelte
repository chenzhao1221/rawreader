<!-- RawReader extension: one status line per translation task, drawn at the visible edge of its picture.
     The line only reports: it does not start anything and does not follow the mouse. The content script sends the
     events (`lmt:task-status-event`); the retry button answers with `lmt:task-retry`. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { canRetry, isTerminal, reduceStatus, statusText, type TaskStatus, type TaskStatusEvent } from "@/lib/task-status";

  interface Line {
    status: TaskStatus;
    el: Element;
  }
  interface Placed {
    left: number;
    top: number;
    visible: boolean;
  }

  let lines = $state<Record<string, Line>>({});
  let placed = $state<Record<string, Placed>>({});
  let notice = $state<{ x: number; y: number; text: string } | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let raf = 0;

  /** The visible part of the picture decides where the line goes: its top edge, or the top of the screen. */
  function place() {
    raf = 0;
    const next: Record<string, Placed> = {};
    for (const [id, line] of Object.entries(lines)) {
      if (!document.body.contains(line.el)) {
        next[id] = { left: 0, top: 0, visible: false };
        continue;
      }
      const r = line.el.getBoundingClientRect();
      const top = Math.max(r.top, 0);
      const bottom = Math.min(r.bottom, window.innerHeight);
      const left = Math.max(r.left, 0);
      const right = Math.min(r.right, window.innerWidth);
      const visible = bottom - top > 28 && right - left > 80;
      next[id] = { left: (left + right) / 2, top: top + 8, visible };
    }
    placed = next;
    if (Object.keys(lines).length > 0) raf = requestAnimationFrame(place);
  }

  function ensureLoop() {
    if (!raf && Object.keys(lines).length > 0) raf = requestAnimationFrame(place);
  }

  function drop(id: string) {
    const timer = closeTimers.get(id);
    if (timer) clearTimeout(timer);
    closeTimers.delete(id);
    const { [id]: _removed, ...rest } = lines;
    lines = rest;
  }

  function onStatusEvent(e: Event) {
    const detail = (e as CustomEvent<{ event?: TaskStatusEvent; el?: Element; remove?: boolean; taskId?: string }>).detail;
    if (!detail) return;
    if (detail.remove && detail.taskId) {
      drop(detail.taskId);
      return;
    }
    const event = detail.event;
    if (!event) return;
    const current = lines[event.taskId];
    const next = reduceStatus(current?.status ?? null, event);
    if (!next || (current && next === current.status)) return;
    const el = current?.el ?? detail.el;
    if (!el) return;
    lines = { ...lines, [event.taskId]: { status: next, el } };
    const timer = closeTimers.get(event.taskId);
    if (timer) clearTimeout(timer);
    closeTimers.delete(event.taskId);
    // A finished task shows "完成" for about a second and then goes away.
    if (next.phase === "done") closeTimers.set(event.taskId, setTimeout(() => drop(event.taskId), 1000));
    ensureLoop();
  }

  function onNotice(e: Event) {
    const detail = (e as CustomEvent<{ x: number; y: number; text: string }>).detail;
    if (!detail) return;
    notice = detail;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = null), 2000);
  }

  function retry(id: string) {
    document.dispatchEvent(new CustomEvent("lmt:task-retry", { detail: { taskId: id } }));
  }

  onMount(() => {
    document.addEventListener("lmt:task-status-event", onStatusEvent);
    document.addEventListener("lmt:task-notice", onNotice);
    return () => {
      document.removeEventListener("lmt:task-status-event", onStatusEvent);
      document.removeEventListener("lmt:task-notice", onNotice);
      if (raf) cancelAnimationFrame(raf);
      for (const timer of closeTimers.values()) clearTimeout(timer);
      clearTimeout(noticeTimer);
    };
  });

  const barStyle =
    "position:fixed;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:min(560px,90vw);" +
    "padding:5px 12px;border-radius:6px;font:12px/1.4 system-ui,'Microsoft YaHei',sans-serif;color:#e8eef7;" +
    "background:rgba(18,26,38,0.92);border:1px solid rgba(120,160,220,0.35);box-shadow:0 2px 10px rgba(0,0,0,0.45);" +
    "pointer-events:none;z-index:2147483000;";
</script>

<div data-rawreader="task-status" style="all:initial">
  {#each Object.entries(lines) as [id, line] (id)}
    {@const spot = placed[id]}
    {#if spot?.visible}
      <div
        role="status"
        data-phase={line.status.phase}
        style="{barStyle}left:{spot.left}px;top:{spot.top}px;{line.status.phase === 'failed' || line.status.phase === 'partial'
          ? 'border-color:rgba(244,63,94,0.6);'
          : ''}"
      >
        {#if !isTerminal(line.status.phase)}
          <span aria-hidden="true" class="spin"></span>
        {/if}
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{statusText(line.status)}</span>
        {#if canRetry(line.status)}
          <button
            type="button"
            onclick={() => retry(id)}
            style="pointer-events:auto;cursor:pointer;flex:none;border:1px solid rgba(160,200,255,0.6);background:rgba(60,90,140,0.5);color:#e8eef7;border-radius:4px;padding:1px 8px;font:inherit"
          >
            重试
          </button>
          <button
            type="button"
            aria-label="关闭"
            onclick={() => drop(id)}
            style="pointer-events:auto;cursor:pointer;flex:none;border:none;background:transparent;color:#9fb0c8;padding:0 2px;font:inherit"
          >
            ×
          </button>
        {/if}
      </div>
    {/if}
  {/each}
  {#if notice}
    <div
      role="status"
      style="{barStyle}left:{Math.min(Math.max(notice.x, 80), window.innerWidth - 80)}px;top:{Math.max(notice.y - 36, 8)}px;"
    >
      {notice.text}
    </div>
  {/if}
</div>

<style>
  .spin {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid rgba(160, 200, 255, 0.9);
    border-top-color: transparent;
    animation: rawreader-spin 0.8s linear infinite;
  }
  @keyframes rawreader-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
