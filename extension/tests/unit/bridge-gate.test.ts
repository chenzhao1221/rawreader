import { describe, expect, it } from "vitest";
import {
  PRIORITY_MANUAL,
  PRIORITY_OFFSCREEN_FLOOR,
  PRIORITY_VIEWPORT_BASE,
  PriorityGate,
  taskPriority,
} from "@/lib/bridge/gate";

describe("PriorityGate", () => {
  it("grants up to the limit at once and queues the rest", async () => {
    const gate = new PriorityGate(2);
    const a = await gate.acquire(0);
    await gate.acquire(0);
    let third = false;
    void gate.acquire(0).then(() => (third = true));
    await Promise.resolve();
    expect(gate.inFlight).toBe(2);
    expect(gate.queued).toBe(1);
    expect(third).toBe(false);
    a();
    await Promise.resolve();
    expect(third).toBe(true);
  });

  it("serves the highest priority first, then first come first served", async () => {
    const gate = new PriorityGate(1);
    const release = await gate.acquire(0);
    const order: string[] = [];
    const wait = (name: string, priority: number) => gate.acquire(priority).then((r) => (order.push(name), r()));
    const all = [wait("low", 1), wait("high", 5), wait("low2", 1), wait("mid", 3)];
    release();
    await Promise.all(all);
    expect(order).toEqual(["high", "mid", "low", "low2"]);
  });

  it("ignores a second release call", async () => {
    const gate = new PriorityGate(1);
    const release = await gate.acquire(0);
    release();
    release();
    expect(gate.inFlight).toBe(0);
  });

  it("removes an aborted waiter and rejects an already aborted signal", async () => {
    const gate = new PriorityGate(1);
    await gate.acquire(0);
    const controller = new AbortController();
    const waiting = gate.acquire(0, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.queued).toBe(0);
    await expect(gate.acquire(0, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("taskPriority", () => {
  it("puts a menu click above a picture on screen, and that above one off screen", () => {
    const manual = taskPriority({ manual: true, viewportCoverage: 0, distancePx: 99_999 });
    const onScreen = taskPriority({ manual: false, viewportCoverage: 1, distancePx: 0 });
    const barely = taskPriority({ manual: false, viewportCoverage: 0.001, distancePx: 0 });
    const near = taskPriority({ manual: false, viewportCoverage: 0, distancePx: 10 });
    const far = taskPriority({ manual: false, viewportCoverage: 0, distancePx: 90_000 });
    expect(manual).toBe(PRIORITY_MANUAL);
    expect(manual).toBeGreaterThan(onScreen);
    expect(onScreen).toBeGreaterThan(barely);
    expect(barely).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(far);
  });

  it("does not let a picture that is long but barely on screen lose to a short one that is far (distance is not size)", () => {
    // A strip whose centre is thousands of pixels away is still on screen: it ranks by what it covers, not by its centre.
    const longStrip = taskPriority({ manual: false, viewportCoverage: 0.4, distancePx: 0 });
    const offScreen = taskPriority({ manual: false, viewportCoverage: 0, distancePx: 300 });
    expect(longStrip).toBeGreaterThan(PRIORITY_VIEWPORT_BASE);
    expect(longStrip).toBeGreaterThan(offScreen);
  });

  it("stays inside the bridge protocol's limit and the floor", () => {
    expect(taskPriority({ manual: true, viewportCoverage: 1, distancePx: 0 })).toBeLessThanOrEqual(1_000_000);
    expect(taskPriority({ manual: false, viewportCoverage: 5, distancePx: 0 })).toBeLessThan(PRIORITY_MANUAL);
    expect(taskPriority({ manual: false, viewportCoverage: 0, distancePx: 10_000_000 })).toBe(PRIORITY_OFFSCREEN_FLOOR);
    expect(taskPriority({ manual: false, viewportCoverage: 0, distancePx: -5 })).toBe(0);
  });
});

describe("PriorityGate with task priorities", () => {
  it("gives the next free place to the menu click, not to the offscreen pictures that waited longer", async () => {
    const gate = new PriorityGate(2);
    const first = await gate.acquire(0);
    await gate.acquire(0);
    const order: string[] = [];
    const wait = (name: string, priority: number) => gate.acquire(priority).then((release) => (order.push(name), release));
    const offscreen = [1, 2, 3].map((n) => wait(`off${n}`, taskPriority({ manual: false, viewportCoverage: 0, distancePx: 1000 * n })));
    const manual = wait("manual", taskPriority({ manual: true, viewportCoverage: 0, distancePx: 0 }));
    first();
    await Promise.resolve();
    expect(order).toEqual(["manual"]);
    void offscreen;
    void manual;
  });

  it("serves a picture on screen before the offscreen ones when several are waiting", async () => {
    const gate = new PriorityGate(1);
    const hold = await gate.acquire(0);
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const wait = (name: string, priority: number) =>
      gate.acquire(priority).then((release) => {
        order.push(name);
        releases.push(release);
      });
    const all = [
      wait("far", taskPriority({ manual: false, viewportCoverage: 0, distancePx: 8000 })),
      wait("near", taskPriority({ manual: false, viewportCoverage: 0, distancePx: 100 })),
      wait("visible", taskPriority({ manual: false, viewportCoverage: 0.3, distancePx: 0 })),
    ];
    hold();
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      await Promise.resolve();
      releases.shift()?.();
    }
    await Promise.all(all);
    expect(order).toEqual(["visible", "near", "far"]);
  });
});