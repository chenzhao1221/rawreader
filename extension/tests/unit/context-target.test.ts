// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  meetsBeneathSize,
  meetsPageSize,
  pickForCommand,
  resolveContextTarget,
  type ContextRecord,
  type TargetEnv,
} from "@/lib/context-target";

const size = (el: Element, w: number, h: number) => {
  Object.defineProperty(el, "offsetWidth", { value: w, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: h, configurable: true });
  return el;
};
const picture = (tag: "img" | "canvas", src?: string, w = 900, h = 1300) => {
  const el = document.createElement(tag);
  if (src) el.setAttribute("src", src);
  return size(el, w, h);
};

/** A page: `stack` is what the browser would list for the click point, topmost first. */
const envFor = (stack: Element[]): TargetEnv => ({
  elementsAt: () => stack,
  qualifies: meetsPageSize,
  qualifiesBeneath: meetsBeneathSize,
  isOwnUi: (el) => el.closest("lmt-overlay, lmt-task-status") !== null,
  originalOfOverlay: (el) => el.closest("lmt-overlay")?.parentElement?.querySelector(":scope > img, :scope > canvas") ?? null,
});
const at = { x: 200, y: 300 };

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("resolveContextTarget", () => {
  it("takes a plain picture that was clicked itself", () => {
    const img = picture("img", "https://cdn.example.test/p1.jpg");
    document.body.append(img);
    expect(resolveContextTarget(img, at, envFor([img]))).toBe(img);
  });

  it("finds the picture under a transparent flip layer from the click point", () => {
    const img = picture("img", "https://cdn.example.test/p1.jpg");
    const layer = size(document.createElement("div"), 900, 1300);
    document.body.append(img, layer);
    expect(resolveContextTarget(layer, at, envFor([layer, img, document.body]))).toBe(img);
  });

  it("finds the picture under a link that lies over it", () => {
    const img = picture("img", "https://cdn.example.test/p1.jpg");
    const link = size(document.createElement("a"), 900, 1300);
    document.body.append(img, link);
    expect(resolveContextTarget(link, at, envFor([link, img]))).toBe(img);
  });

  it("takes a canvas reader's canvas, with or without something over it", () => {
    const canvas = picture("canvas");
    const layer = size(document.createElement("div"), 900, 1300);
    document.body.append(canvas, layer);
    expect(resolveContextTarget(canvas, at, envFor([canvas]))).toBe(canvas);
    expect(resolveContextTarget(layer, at, envFor([layer, canvas]))).toBe(canvas);
  });

  it("picks the second copy when the same address is shown twice and the second one is clicked", () => {
    const first = picture("img", "https://cdn.example.test/same.jpg");
    const second = picture("img", "https://cdn.example.test/same.jpg");
    document.body.append(first, second);
    expect(resolveContextTarget(second, at, envFor([second]))).toBe(second);
    expect(resolveContextTarget(first, at, envFor([first]))).toBe(first);
  });

  it("reports no comic when the click is on text", () => {
    const paragraph = size(document.createElement("p"), 600, 40);
    const img = picture("img", "https://cdn.example.test/p1.jpg");
    document.body.append(paragraph, img);
    expect(resolveContextTarget(paragraph, at, envFor([paragraph, document.body, document.documentElement]))).toBeNull();
    expect(resolveContextTarget(null, at, envFor([]))).toBeNull();
  });

  it("ignores a small picture under the click (an icon, a thumbnail)", () => {
    const icon = picture("img", "https://cdn.example.test/icon.png", 48, 48);
    const row = size(document.createElement("div"), 900, 60);
    document.body.append(row, icon);
    expect(resolveContextTarget(row, at, envFor([row, icon]))).toBeNull();
  });

  it("maps our own overlay back to the picture it covers", () => {
    const wrapper = document.createElement("div");
    const img = picture("img", "https://cdn.example.test/p1.jpg");
    const host = document.createElement("lmt-overlay");
    const inner = document.createElement("div");
    host.append(inner);
    wrapper.append(img, host);
    document.body.append(wrapper);
    expect(resolveContextTarget(host, at, envFor([host, img]))).toBe(img);
    expect(resolveContextTarget(inner, at, envFor([inner, host]))).toBe(img);
  });

  it("skips our status bar and finds the picture beneath it", () => {
    const img = picture("img", "https://cdn.example.test/p1.jpg");
    const bar = document.createElement("lmt-task-status");
    document.body.append(img, bar);
    expect(resolveContextTarget(bar, at, envFor([bar, img]))).toBe(img);
  });
});

describe("meetsPageSize", () => {
  it("accepts shown or natural size from 260 px each way", () => {
    expect(meetsPageSize(picture("img", "a", 300, 400))).toBe(true);
    expect(meetsPageSize(picture("img", "a", 100, 100))).toBe(false);
    const natural = picture("img", "a", 100, 100);
    Object.defineProperty(natural, "naturalWidth", { value: 800 });
    Object.defineProperty(natural, "naturalHeight", { value: 1200 });
    expect(meetsPageSize(natural)).toBe(true);
  });
});

describe("pickForCommand", () => {
  const url = "https://reader.example.test/ch1";
  const connected = (el: Element) => document.body.contains(el);
  const record = (over: Partial<ContextRecord>): ContextRecord => ({ at: 1, x: 10, y: 10, pageUrl: url, target: null, resolved: null, ...over });

  it("uses the picture found at the click when the menu gave no address (flip layer, canvas)", () => {
    const canvas = picture("canvas");
    document.body.append(canvas);
    const out = pickForCommand(record({ resolved: canvas }), url, connected, undefined, () => false, () => null);
    expect(out).toEqual({ ok: true, element: canvas });
  });

  it("takes the clicked copy when two pictures share the address", () => {
    const first = picture("img", "https://cdn.example.test/same.jpg");
    const second = picture("img", "https://cdn.example.test/same.jpg");
    document.body.append(first, second);
    const out = pickForCommand(
      record({ target: second, resolved: second }),
      url,
      connected,
      "https://cdn.example.test/same.jpg",
      () => true,
      () => first,
    );
    expect(out).toEqual({ ok: true, element: second });
  });

  it("looks the address up when the clicked element does not match it", () => {
    const layer = size(document.createElement("div"), 900, 1300);
    const other = picture("img", "https://cdn.example.test/other.jpg");
    const wanted = picture("img", "https://cdn.example.test/wanted.jpg");
    document.body.append(layer, other, wanted);
    const out = pickForCommand(record({ target: layer, resolved: other }), url, connected, "https://cdn.example.test/wanted.jpg", (el) => el === wanted, () => wanted);
    expect(out).toEqual({ ok: true, element: wanted });
  });

  it("looks the address up when nothing was resolved, and refuses when that finds nothing", () => {
    const wanted = picture("img", "https://cdn.example.test/wanted.jpg");
    document.body.append(wanted);
    expect(pickForCommand(record({}), url, connected, "https://cdn.example.test/wanted.jpg", () => false, () => wanted)).toEqual({ ok: true, element: wanted });
    expect(pickForCommand(record({}), url, connected, "https://cdn.example.test/none.jpg", () => false, () => null)).toEqual({ ok: false, reason: "no-element" });
  });

  it("ignores a record from another page address or an element that left the document", () => {
    const img = picture("img", "https://cdn.example.test/p1.jpg");
    document.body.append(img);
    expect(pickForCommand(record({ pageUrl: "https://reader.example.test/ch2", resolved: img }), url, connected, undefined, () => false, () => null)).toEqual({
      ok: false,
      reason: "other-page",
    });
    const gone = picture("img", "https://cdn.example.test/gone.jpg");
    expect(pickForCommand(record({ resolved: gone }), url, connected, undefined, () => false, () => null)).toEqual({ ok: false, reason: "no-element" });
  });

  it("falls back to the address lookup when no right-click was recorded", () => {
    const wanted = picture("img", "https://cdn.example.test/wanted.jpg");
    document.body.append(wanted);
    expect(pickForCommand(null, url, connected, "https://cdn.example.test/wanted.jpg", () => false, () => wanted)).toEqual({ ok: true, element: wanted });
    expect(pickForCommand(null, url, connected, undefined, () => false, () => null)).toEqual({ ok: false, reason: "no-record" });
  });
});
