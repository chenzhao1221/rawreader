/** Priority of a task at the page queue and the per-tab gate: manual click, then pictures on screen, then the rest. */
export const PRIORITY_MANUAL = 1_000_000;
export const PRIORITY_VIEWPORT_BASE = 500_000;
/** Room above the base for the share of the screen the picture covers (at most this many points). */
export const PRIORITY_VIEWPORT_SPAN = 100_000;
/** Pictures off screen go from 0 down to this, by how far they are from the screen. */
export const PRIORITY_OFFSCREEN_FLOOR = -400_000;

export interface PriorityInput {
  /** The user asked for this one (menu click) rather than the queue picking it up. */
  manual: boolean;
  /** Share of the viewport the picture covers (0..1). Zero means it is off screen. */
  viewportCoverage: number;
  /** Distance in pixels from the picture to the viewport edge (0 when it is on screen). */
  distancePx: number;
}

/** Larger is more urgent. Always within the bridge protocol's limit of plus or minus 1,000,000. */
export function taskPriority(input: PriorityInput): number {
  if (input.manual) return PRIORITY_MANUAL;
  if (input.viewportCoverage > 0) {
    return PRIORITY_VIEWPORT_BASE + Math.round(Math.min(1, input.viewportCoverage) * PRIORITY_VIEWPORT_SPAN);
  }
  return 0 - Math.min(Math.max(0, Math.round(input.distancePx)), -PRIORITY_OFFSCREEN_FLOOR);
}

/**
 * Counting gate with priorities: at most `limit` holders at a time, waiters served highest priority first
 * (first come first served among equals). The background worker keeps one gate per tab, so one long strip
 * page cannot flood the app's queue (design 5.1).
 */
export class PriorityGate {
  private active = 0;
  private waiters: Array<{ priority: number; order: number; grant: () => void }> = [];
  private counter = 0;

  constructor(private readonly limit: number) {}

  /** Resolves with a release function once a slot is free. Rejects when `signal` aborts first. */
  acquire(priority: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.pump();
        });
      };
      const waiter = { priority, order: this.counter++, grant };
      signal?.addEventListener(
        "abort",
        () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
            reject(new DOMException("Aborted", "AbortError"));
          }
        },
        { once: true },
      );
      this.waiters.push(waiter);
      this.pump();
    });
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      let best = 0;
      for (let i = 1; i < this.waiters.length; i++) {
        const a = this.waiters[i]!;
        const b = this.waiters[best]!;
        if (a.priority > b.priority || (a.priority === b.priority && a.order < b.order)) best = i;
      }
      const [next] = this.waiters.splice(best, 1);
      next?.grant();
    }
  }
}
