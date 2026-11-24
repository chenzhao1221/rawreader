// RawReader extension: right-click menu entries and the messages between the background worker and the page.
// "Translate this image" is the way to start a translation by hand. Pure logic; the chrome.* calls are in the
// background worker.

export const MENU_TRANSLATE_IMAGE = "rawreader-translate-image";
export const MENU_TRANSLATE_PAGE = "rawreader-translate-page";

export const MSG_CONTEXT_TRANSLATE_IMAGE = "CONTEXT_TRANSLATE_IMAGE";
export const MSG_CONTEXT_TRANSLATE_PAGE = "CONTEXT_TRANSLATE_PAGE";

export type ContextTranslateMessage =
  | {
      type: typeof MSG_CONTEXT_TRANSLATE_IMAGE;
      /** `srcUrl` is missing when the browser reports no address (a transparent layer, a canvas). */
      data: { srcUrl?: string; clickedAt?: number; frameId?: number };
    }
  | { type: typeof MSG_CONTEXT_TRANSLATE_PAGE };

type MenuContext = "image" | "page" | "link";

export interface MenuItemDef {
  id: string;
  title: string;
  contexts: [MenuContext, ...MenuContext[]];
}

/**
 * The two entries. Titles are UI strings (Simplified Chinese). The image entry also shows on plain page areas and on
 * links: a transparent flip layer, a canvas, a CSS background or a link around the picture hides the "image" context,
 * and the page decides from the click position which picture is meant. The entry is never hidden: a command that
 * finds no picture on the page only shows a short note. The page entry also shows on images.
 */
export const CONTEXT_MENU_ITEMS: readonly MenuItemDef[] = [
  { id: MENU_TRANSLATE_IMAGE, title: "翻译这张图片", contexts: ["image", "page", "link"] },
  { id: MENU_TRANSLATE_PAGE, title: "翻译本页图片", contexts: ["page", "image"] },
];

/** The minimal part of chrome.contextMenus.OnClickData that is used here. */
export interface MenuClickInfo {
  menuItemId: string | number;
  srcUrl?: string;
  frameId?: number;
}

/** Message for the page for a click, or null when the click is not ours. `now` is the click time (ms since epoch). */
export function messageForMenuClick(info: MenuClickInfo, now: number = Date.now()): ContextTranslateMessage | null {
  if (info.menuItemId === MENU_TRANSLATE_IMAGE) {
    const srcUrl = info.srcUrl?.trim();
    return {
      type: MSG_CONTEXT_TRANSLATE_IMAGE,
      data: {
        ...(srcUrl ? { srcUrl } : {}),
        clickedAt: now,
        ...(info.frameId !== undefined ? { frameId: info.frameId } : {}),
      },
    };
  }
  if (info.menuItemId === MENU_TRANSLATE_PAGE) return { type: MSG_CONTEXT_TRANSLATE_PAGE };
  return null;
}

/** Narrows an incoming runtime message to a context-menu command. */
export function isContextTranslateMessage(msg: unknown): msg is ContextTranslateMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: unknown; data?: { srcUrl?: unknown; clickedAt?: unknown } };
  if (m.type === MSG_CONTEXT_TRANSLATE_PAGE) return true;
  if (m.type !== MSG_CONTEXT_TRANSLATE_IMAGE) return false;
  if (m.data === undefined || m.data === null || typeof m.data !== "object") return false;
  if (m.data.srcUrl !== undefined && typeof m.data.srcUrl !== "string") return false;
  if (m.data.clickedAt !== undefined && typeof m.data.clickedAt !== "number") return false;
  return true;
}
