/** Pure tab-order rules, kept apart from Electron so they can be unit tested. */

/** Keyboard shortcuts the browse view hands to the tab manager. */
export type TabShortcut = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab' | 'reload' | 'focus-address'

/** Maps a key press to a tab shortcut (Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, F5, Ctrl+L). */
export function shortcutFor(input: { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }): TabShortcut | null {
  if (input.type !== 'keyDown' || input.alt || input.meta) return null
  const key = input.key.toLowerCase()
  if (key === 'f5') return 'reload'
  if (!input.control) return null
  if (key === 'tab') return input.shift ? 'previous-tab' : 'next-tab'
  if (input.shift) return null
  if (key === 't') return 'new-tab'
  if (key === 'w') return 'close-tab'
  if (key === 'l') return 'focus-address'
  return null
}

/** Where a new tab goes: right after the active tab, or at the end when there is none. */
export function insertIndex(order: readonly number[], activeId: number | null): number {
  if (activeId === null) return order.length
  const at = order.indexOf(activeId)
  return at === -1 ? order.length : at + 1
}

/** Tab to activate after `closingId` closes: the right neighbour, else the left one, else none. */
export function nextAfterClose(order: readonly number[], closingId: number, activeId: number | null): number | null {
  const remaining = order.filter((id) => id !== closingId)
  if (closingId !== activeId) return activeId !== null && remaining.includes(activeId) ? activeId : (remaining[0] ?? null)
  const at = order.indexOf(closingId)
  if (at === -1) return remaining[0] ?? null
  return remaining[at] ?? remaining[at - 1] ?? null
}

/** The tab `step` places away from the active one, wrapping around (Ctrl+Tab / Ctrl+Shift+Tab). */
export function cycle(order: readonly number[], activeId: number | null, step: 1 | -1): number | null {
  if (order.length === 0) return null
  const at = activeId === null ? -1 : order.indexOf(activeId)
  if (at === -1) return order[0] ?? null
  return order[(at + step + order.length) % order.length] ?? null
}

/** Saved tabs to reopen: http(s) URLs only, at most `max`, with the active index clamped. */
export function restorePlan(
  saved: { urls: readonly string[]; active: number },
  lastUrl: string | null,
  isHttp: (url: string) => boolean,
  max: number,
): { urls: string[]; active: number } {
  let urls = saved.urls.filter(isHttp).slice(0, max)
  if (urls.length === 0 && lastUrl && isHttp(lastUrl)) urls = [lastUrl]
  const active = Math.min(Math.max(0, saved.active), Math.max(0, urls.length - 1))
  return { urls, active }
}
