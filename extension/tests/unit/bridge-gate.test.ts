import { describe, expect, it } from "vitest";
import { PriorityGate } from "@/lib/bridge/gate";

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
