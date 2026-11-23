import { describe, expect, it } from "vitest";
import {
  CONTEXT_MENU_ITEMS,
  MENU_TRANSLATE_IMAGE,
  MENU_TRANSLATE_PAGE,
  MSG_CONTEXT_TARGET,
  MSG_CONTEXT_TRANSLATE_IMAGE,
  MSG_CONTEXT_TRANSLATE_PAGE,
  isContextTargetMessage,
  isContextTranslateMessage,
  messageForMenuClick,
} from "@/lib/context-menu";

describe("context menu items", () => {
  it("has the image item on images, plain page areas and links, with unique ids", () => {
    const image = CONTEXT_MENU_ITEMS.find((i) => i.id === MENU_TRANSLATE_IMAGE)!;
    expect(image.title).toBe("翻译这张图片");
    expect(image.contexts).toEqual(["image", "page", "link"]);
    expect(new Set(CONTEXT_MENU_ITEMS.map((i) => i.id)).size).toBe(CONTEXT_MENU_ITEMS.length);
  });

  it("has the page item on pages (and images)", () => {
    const page = CONTEXT_MENU_ITEMS.find((i) => i.id === MENU_TRANSLATE_PAGE)!;
    expect(page.title).toBe("翻译本页图片");
    expect(page.contexts).toContain("page");
  });
});

describe("messageForMenuClick", () => {
  it("builds the image message from srcUrl, the click time and the frame", () => {
    expect(messageForMenuClick({ menuItemId: MENU_TRANSLATE_IMAGE, srcUrl: " https://cdn.example.test/a.jpg ", frameId: 0 }, 1234)).toEqual({
      type: MSG_CONTEXT_TRANSLATE_IMAGE,
      data: { srcUrl: "https://cdn.example.test/a.jpg", clickedAt: 1234, frameId: 0 },
    });
  });
  it("still builds the image message when the browser reports no address (flip layer, canvas)", () => {
    expect(messageForMenuClick({ menuItemId: MENU_TRANSLATE_IMAGE }, 5)).toEqual({ type: MSG_CONTEXT_TRANSLATE_IMAGE, data: { clickedAt: 5 } });
    expect(messageForMenuClick({ menuItemId: MENU_TRANSLATE_IMAGE, srcUrl: "  " }, 5)).toEqual({ type: MSG_CONTEXT_TRANSLATE_IMAGE, data: { clickedAt: 5 } });
  });
  it("builds the page message", () => {
    expect(messageForMenuClick({ menuItemId: MENU_TRANSLATE_PAGE })).toEqual({ type: MSG_CONTEXT_TRANSLATE_PAGE });
  });
  it("ignores other menu items", () => {
    expect(messageForMenuClick({ menuItemId: "other", srcUrl: "https://cdn.example.test/a.jpg" })).toBeNull();
    expect(messageForMenuClick({ menuItemId: 7 })).toBeNull();
  });
});

describe("isContextTranslateMessage", () => {
  it("accepts both messages, with or without an address", () => {
    expect(isContextTranslateMessage({ type: MSG_CONTEXT_TRANSLATE_PAGE })).toBe(true);
    expect(isContextTranslateMessage({ type: MSG_CONTEXT_TRANSLATE_IMAGE, data: { srcUrl: "https://cdn.example.test/a.jpg" } })).toBe(true);
    expect(isContextTranslateMessage({ type: MSG_CONTEXT_TRANSLATE_IMAGE, data: { clickedAt: 1 } })).toBe(true);
  });
  it("rejects malformed input", () => {
    expect(isContextTranslateMessage(null)).toBe(false);
    expect(isContextTranslateMessage("x")).toBe(false);
    expect(isContextTranslateMessage({ type: MSG_CONTEXT_TRANSLATE_IMAGE })).toBe(false);
    expect(isContextTranslateMessage({ type: MSG_CONTEXT_TRANSLATE_IMAGE, data: { srcUrl: 3 } })).toBe(false);
    expect(isContextTranslateMessage({ type: MSG_CONTEXT_TRANSLATE_IMAGE, data: { clickedAt: "now" } })).toBe(false);
    expect(isContextTranslateMessage({ type: "BRIDGE_PING" })).toBe(false);
  });
});

describe("isContextTargetMessage", () => {
  it("accepts the page's report and rejects anything else", () => {
    expect(isContextTargetMessage({ type: MSG_CONTEXT_TARGET, hasTarget: true })).toBe(true);
    expect(isContextTargetMessage({ type: MSG_CONTEXT_TARGET, hasTarget: false })).toBe(true);
    expect(isContextTargetMessage({ type: MSG_CONTEXT_TARGET })).toBe(false);
    expect(isContextTargetMessage({ type: "OTHER", hasTarget: true })).toBe(false);
    expect(isContextTargetMessage(null)).toBe(false);
  });
});
