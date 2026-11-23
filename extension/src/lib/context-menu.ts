// RawReader extension: right-click menu entries and the message the background worker sends to the page.
// This is the manual fallback for images that auto-detection missed. Pure logic; the chrome.* calls are in the
// background worker.

export const MENU_TRANSLATE_IMAGE = "rawreader-translate-image";
export const MENU_TRANSLATE_PAGE = "rawreader-translate-page";

export const MSG_CONTEXT_TRANSLATE_IMAGE = "CONTEXT_TRANSLATE_IMAGE";
export const MSG_CONTEXT_TRANSLATE_PAGE = "CONTEXT_TRANSLATE_PAGE";

export type ContextTranslateMessage =
  | { type: typeof MSG_CONTEXT_TRANSLATE_IMAGE; data: { srcUrl: string; clickedAt?: number } }
  | { type: typeof MSG_CONTEXT_TRANSLATE_PAGE };

type MenuContext = "image" | "page";

export interface MenuItemDef {
  id: string;
  title: string;
  contexts: [MenuContext, ...MenuContext[]];
}

/** The two entries. Titles are UI strings (Simplified Chinese). The page entry also shows on images, where a link or overlay hides the plain page menu. */
export const CONTEXT_MENU_ITEMS: readonly MenuItemDef[] = [
  { id: MENU_TRANSLATE_IMAGE, title: "翻译这张图片", contexts: ["image"] },
  { id: MENU_TRANSLATE_PAGE, title: "翻译本页图片", contexts: ["page", "image"] },
];

/** The minimal part of chrome.contextMenus.OnClickData that is used here. */
export interface MenuClickInfo {
  menuItemId: string | number;
  srcUrl?: string;
}

/** Message for the page for a click, or null when the click is not ours or has nothing to translate. `now` is the click time. */
export function messageForMenuClick(info: MenuClickInfo, now: number = Date.now()): ContextTranslateMessage | null {
  if (info.menuItemId === MENU_TRANSLATE_IMAGE) {
    const srcUrl = info.srcUrl?.trim();
    return srcUrl ? { type: MSG_CONTEXT_TRANSLATE_IMAGE, data: { srcUrl, clickedAt: now } } : null;
  }
  if (info.menuItemId === MENU_TRANSLATE_PAGE) return { type: MSG_CONTEXT_TRANSLATE_PAGE };
  return null;
}

/** Narrows an incoming runtime message to a context-menu command. */
export function isContextTranslateMessage(msg: unknown): msg is ContextTranslateMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: unknown; data?: { srcUrl?: unknown } };
  if (m.type === MSG_CONTEXT_TRANSLATE_PAGE) return true;
  return m.type === MSG_CONTEXT_TRANSLATE_IMAGE && typeof m.data?.srcUrl === "string" && m.data.srcUrl.length > 0;
}
