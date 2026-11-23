// RawReader extension: the phases of one translation task as the status bar shows them (pure).
// A task only moves forward: waiting in the page queue, fetching the picture, waiting for a request slot,
// translating, then one of three endings. Events of another task never change this one.

export type TaskPhase = "fetching" | "queued" | "translating" | "done" | "partial" | "failed";

export interface TaskStatus {
  taskId: string;
  phase: TaskPhase;
  /** The picture was already fetched (so a late "fetching" event is old news). */
  fetched: boolean;
  /** Segments answered so far, and how many there are (long strips on the direct API only). */
  done?: number;
  total?: number;
  /** Plain-language reason for `partial` and `failed`. */
  error?: string;
  /** Zero-based numbers of the segments that did not come back. */
  failed?: number[];
}

export type TaskStatusEvent =
  /** `phase`: "queued" when the task waits in the page queue first, "fetching" when it starts at once. */
  | { taskId: string; type: "start"; phase?: "queued" | "fetching" }
  | { taskId: string; type: "fetching" }
  | { taskId: string; type: "queued" }
  | { taskId: string; type: "translating"; done?: number; total?: number }
  | { taskId: string; type: "progress"; done: number; total: number }
  | { taskId: string; type: "done" }
  | { taskId: string; type: "partial"; failed: number[]; error: string }
  | { taskId: string; type: "failed"; error: string }
  | { taskId: string; type: "retry" };

export const isTerminal = (phase: TaskPhase): boolean => phase === "done" || phase === "partial" || phase === "failed";

/** Next status for an event. `null` means "no task yet". Returns the same object when the event changes nothing. */
export function reduceStatus(state: TaskStatus | null, event: TaskStatusEvent): TaskStatus | null {
  if (event.type === "start") {
    if (state && state.taskId === event.taskId) return state;
    const phase = event.phase ?? "fetching";
    return { taskId: event.taskId, phase, fetched: phase === "fetching" };
  }
  if (!state || state.taskId !== event.taskId) return state;

  if (event.type === "retry") {
    if (state.phase !== "partial" && state.phase !== "failed") return state;
    const next: TaskStatus = { taskId: state.taskId, phase: "queued", fetched: true };
    if (state.total !== undefined) next.total = state.total;
    return next;
  }
  if (isTerminal(state.phase)) return state;

  switch (event.type) {
    case "fetching":
      return state.fetched || state.phase !== "queued" ? state : { ...state, phase: "fetching", fetched: true };
    case "queued":
      // Waiting for a request slot comes after the fetch; before it the page queue already said "queued".
      return state.phase === "translating" ? state : state.phase === "queued" ? state : { ...state, phase: "queued" };
    case "translating": {
      const next: TaskStatus = { ...state, phase: "translating", fetched: true };
      if (event.total !== undefined) next.total = event.total;
      if (event.done !== undefined) next.done = Math.max(state.done ?? 0, event.done);
      return next;
    }
    case "progress":
      if (state.phase !== "translating") return state;
      return { ...state, done: Math.max(state.done ?? 0, event.done), total: event.total };
    case "done":
      return { taskId: state.taskId, phase: "done", fetched: true, ...(state.total !== undefined ? { total: state.total, done: state.total } : {}) };
    case "partial":
      return {
        taskId: state.taskId,
        phase: "partial",
        fetched: true,
        error: event.error,
        failed: [...event.failed],
        ...(state.total !== undefined ? { total: state.total } : {}),
      };
    case "failed":
      return { taskId: state.taskId, phase: "failed", fetched: true, error: event.error };
  }
}

/** The line the status bar shows. Segment numbers are shown from 1. */
export function statusText(status: TaskStatus): string {
  switch (status.phase) {
    case "fetching":
      return "正在取图";
    case "queued":
      return "排队中";
    case "translating":
      return status.total && status.total > 1 ? `翻译中 ${Math.min(status.done ?? 0, status.total)}/${status.total}` : "翻译中";
    case "done":
      return "完成";
    case "partial": {
      const list = (status.failed ?? []).map((i) => i + 1).join("、");
      return `第 ${list} 段失败：${status.error ?? "未知原因"}`;
    }
    case "failed":
      return status.error ?? "翻译失败";
  }
}

/** True when the bar offers a retry button. */
export const canRetry = (status: TaskStatus): boolean => status.phase === "partial" || status.phase === "failed";
