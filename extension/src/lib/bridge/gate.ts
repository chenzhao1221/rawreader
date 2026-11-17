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
