// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoTranslateQueue } from "@/entrypoints/content/auto-translate";
import * as Registry from "@/entrypoints/content/translation-registry";
import { quickHash } from "@/entrypoints/content/utils";
import type { MangaTargetElement } from "@/lib/canvas";

let queue: AutoTranslateQueue;
const order: string[] = [];
const finishers = new Map<string, () => void>();

/** A page picture. `top` decides whether it is on screen (the viewport is 0..768 tall). */
function picture(name: string, top: number, height = 1000, src = `https://cdn.example.test/${name}.jpg`): HTMLImageElement {
  const img = document.createElement("img");
  img.setAttribute("src", src);
  img.id = name;
  document.body.append(img);
  img.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  return img;
}

/** What the pipeline does for the queue: claim the picture at once, finish later. */
const translateFn = (img: MangaTargetElement) => {
  order.push(img.id);
  Registry.markPending(img.getAttribute("src")!, undefined, img);
  return new Promise<void>((resolve) => {
    finishers.set(img.id, () => Registry.markDone(img.getAttribute("src")!, undefined, img));
    resolve();
  });
};
const finish = (name: string) => finishers.get(name)!();

beforeEach(() => {
  document.body.innerHTML = "";
  order.length = 0;
  finishers.clear();
  queue = new AutoTranslateQueue();
  queue.setConcurrency(1);
});
afterEach(() => queue.destroy());

describe("page queue order: manual, then on screen, then off screen", () => {
  it("starts the menu-chosen long picture before the off-screen ones that were queued earlier", () => {
    const far = [picture("far1", 5000), picture("far2", 6200), picture("far3", 7400)];
    for (const img of far) queue.enqueue(img, translateFn);
    expect(order).toEqual(["far1"]); // free slot: the first one starts at once
    const strip = picture("strip", 0, 10000);
    queue.enqueue(strip, translateFn, { manual: true });
    expect(order).toEqual(["far1"]); // not preempted: the running one keeps its slot
    finish("far1");
    expect(order).toEqual(["far1", "strip"]);
    finish("strip");
    expect(order).toEqual(["far1", "strip", "far2"]);
    expect(queue.started.map((s) => s.class)).toEqual(["offscreen", "manual", "offscreen"]);
  });

  it("starts a picture on screen before one off screen, judged when the slot frees up", () => {
    const running = picture("running", 0);
    queue.enqueue(running, translateFn);
    const below = picture("below", 4000);
    const later = picture("later", 5000);
    queue.enqueue(below, translateFn);
    queue.enqueue(later, translateFn);
    // The reader scrolls: `later` is now on screen, `below` is not.
    later.getBoundingClientRect = () => ({ top: 100, bottom: 1100, left: 0, right: 800, width: 800, height: 1000, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    finish("running");
    expect(order).toEqual(["running", "later"]);
  });

  it("is first come first served inside a class", () => {
    const first = picture("a", 0);
    queue.enqueue(first, translateFn);
    queue.enqueue(picture("b", 10), translateFn);
    queue.enqueue(picture("c", 20), translateFn);
    queue.enqueue(picture("m1", 9000), translateFn, { manual: true });
    queue.enqueue(picture("m2", 9500), translateFn, { manual: true });
    finish("a");
    expect(order).toEqual(["a", "m1"]);
    finish("m1");
    expect(order).toEqual(["a", "m1", "m2"]);
    finish("m2");
    expect(order).toEqual(["a", "m1", "m2", "b"]);
  });

  it("moves a picture that is already waiting to the manual class instead of queuing it twice", () => {
    queue.enqueue(picture("busy", 0), translateFn);
    const target = picture("target", 8000);
    queue.enqueue(picture("other", 5000), translateFn);
    queue.enqueue(target, translateFn);
    queue.enqueue(target, translateFn, { manual: true });
    expect(queue.length).toBe(2);
    finish("busy");
    expect(order).toEqual(["busy", "target"]);
  });

  it("uses every free slot when the limit is higher", () => {
    queue.setConcurrency(2);
    queue.enqueue(picture("a", 5000), translateFn);
    queue.enqueue(picture("b", 6000), translateFn);
    queue.enqueue(picture("c", 7000), translateFn);
    expect(order).toEqual(["a", "b"]);
    queue.enqueue(picture("m", 8000), translateFn, { manual: true });
    finish("a");
    expect(order).toEqual(["a", "b", "m"]);
  });
});

describe("one task per page element, not per address", () => {
  it("translates two pictures that share an address, one after the other", () => {
    const first = picture("one", 0, 1000, "https://cdn.example.test/same.jpg");
    const second = picture("two", 1100, 1000, "https://cdn.example.test/same.jpg");
    queue.enqueue(first, translateFn);
    queue.enqueue(second, translateFn);
    expect(order).toEqual(["one"]);
    finish("one");
    expect(order).toEqual(["one", "two"]);
    expect(Registry.getStatus("https://cdn.example.test/same.jpg", first)).toBe("done");
    expect(Registry.getStatus("https://cdn.example.test/same.jpg", second)).toBe("pending");
  });

  it("does not queue a finished or running picture again", () => {
    const img = picture("a", 0);
    queue.enqueue(img, translateFn);
    queue.enqueue(img, translateFn);
    queue.enqueue(img, translateFn, { manual: true });
    expect(order).toEqual(["a"]);
    finish("a");
    queue.enqueue(img, translateFn, { manual: true });
    expect(order).toEqual(["a"]);
  });

  it("lets a failed picture be queued again after it went idle", () => {
    const img = picture("a", 0);
    queue.enqueue(img, translateFn);
    Registry.markIdle(img.getAttribute("src")!, undefined, img);
    queue.enqueue(img, translateFn);
    expect(order).toEqual(["a", "a"]);
  });
});

describe("a page that came back in part", () => {
  it("frees its slot, is not queued again by the scanner, and is taken again by a menu click", () => {
    const part = picture("part", 0);
    queue.enqueue(part, translateFn);
    queue.enqueue(picture("next", 5000), translateFn);
    Registry.markPartial(part.getAttribute("src")!, undefined, part);
    expect(order).toEqual(["part", "next"]);
    finish("next");
    queue.enqueue(part, translateFn);
    expect(order).toEqual(["part", "next"]);
    queue.enqueue(part, translateFn, { manual: true });
    expect(order).toEqual(["part", "next", "part"]);
  });
});

describe("registry per element", () => {
  it("keeps the status of two elements with one address apart", () => {
    const a = picture("a", 0, 100, "https://cdn.example.test/x.jpg");
    const b = picture("b", 0, 100, "https://cdn.example.test/x.jpg");
    const key = `local:page-cache-zh-Series-ch1-p1-${quickHash("https://cdn.example.test/x.jpg")}`;
    Registry.markPending("https://cdn.example.test/x.jpg", key, a);
    expect(Registry.isPending("https://cdn.example.test/x.jpg", a)).toBe(true);
    expect(Registry.isPending("https://cdn.example.test/x.jpg", b)).toBe(false);
    expect(Registry.getStatusByCacheKey(key, a)).toBe("pending");
    expect(Registry.getStatusByCacheKey(key, b)).toBe("idle");
    Registry.markDone("https://cdn.example.test/x.jpg", undefined, a);
    expect(Registry.getStatus("https://cdn.example.test/x.jpg", a)).toBe("done");
    expect(Registry.getStatus("https://cdn.example.test/x.jpg", b)).toBe("idle");
    Registry.markIdle("https://cdn.example.test/x.jpg", undefined, a);
    expect(Registry.getStatus("https://cdn.example.test/x.jpg", a)).toBe("idle");
    expect(Registry.getStatusByCacheKey(key, a)).toBe("idle");
  });
});
