import { Menu, clipboard } from 'electron'
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron'
import { isHttpUrl } from './address'
import { buildMenuEntries } from './context-menu'
import type { MenuAction } from './context-menu'

export interface BrowseMenuHooks {
  /** Opens a URL in a new, active tab. */
  openInNewTab(url: string): void
  /** Starts the app's translation for the image at the click (view coordinates). */
  translateImage(request: { x: number; y: number; srcUrl: string }): void
  /** Development build: the menu offers Inspect. */
  isDev: boolean
}

/**
 * Shows the page context menu for a browse view. The entries come from `buildMenuEntries` (pure, unit-tested);
 * this function only turns them into a native menu and runs the chosen action. It uses Electron's public
 * `webContents` methods only: no page script runs and no webPreferences change.
 */
export function showBrowseMenu(win: BrowserWindow, wc: WebContents, params: ContextMenuParams, hooks: BrowseMenuHooks): void {
  if (win.isDestroyed() || wc.isDestroyed()) return
  const run = (action: MenuAction): void => {
    if (wc.isDestroyed()) return
    switch (action) {
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
        break
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
        break
      case 'reload':
        wc.reload()
        break
      case 'cut':
        wc.cut()
        break
      case 'copy':
        wc.copy()
        break
      case 'paste':
        wc.paste()
        break
      case 'select-all':
        wc.selectAll()
        break
      case 'copy-link':
        if (isHttpUrl(params.linkURL)) clipboard.writeText(params.linkURL)
        break
      case 'copy-image':
        wc.copyImageAt(params.x, params.y)
        break
      case 'open-image':
        if (isHttpUrl(params.srcURL)) hooks.openInNewTab(params.srcURL)
        break
      case 'translate-image':
        hooks.translateImage({ x: Math.max(0, Math.round(params.x)), y: Math.max(0, Math.round(params.y)), srcUrl: params.srcURL })
        break
      case 'inspect':
        if (hooks.isDev) wc.inspectElement(params.x, params.y)
        break
    }
  }

  const entries = buildMenuEntries(params, {
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    isDev: hooks.isDev,
  })
  const template: MenuItemConstructorOptions[] = entries.map((entry) =>
    entry.type === 'separator'
      ? { type: 'separator' }
      : { label: entry.label, enabled: entry.enabled, click: () => run(entry.action) },
  )
  Menu.buildFromTemplate(template).popup({ window: win })
}
