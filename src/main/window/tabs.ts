import type { BrowserWindow, HandlerDetails, WebContents, WindowOpenHandlerResponse } from 'electron'
import { MAX_TABS } from '../../shared/constants'
import type { BrowseState, ShellNotice, TabsState } from '../../shared/ipc/contract'
import { createLogger } from '../log/log'
import { isHttpUrl } from './address'
import { createBrowseView } from './browse-view'
import type { BrowseAction, BrowseView } from './browse-view'
import { cycle, insertIndex, nextAfterClose } from './tab-order'
import type { TabShortcut } from './tab-order'

const log = createLogger('tabs')

/** Size of a sign-in popup when the page does not ask for one. */
const POPUP_DEFAULT = { width: 520, height: 680 }

export interface TabManagerOptions {
  win: BrowserWindow
  preloadPath: string
  /** State of the active tab (back/forward, title ...), for the toolbar. */
  onActiveState: (state: BrowseState) => void
  /** The tab strip changed (titles, order, active tab). */
  onTabs: (state: TabsState) => void
  onNotice: (notice: ShellNotice) => void
  /** Open tab URLs changed: persist them so the next start reopens them. */
  onSession: (urls: string[], activeIndex: number) => void
  /** A tab was created; the pipeline attaches its capture here. */
  onTabCreated: (view: BrowseView) => void
  /** A tab is about to go away; the pipeline detaches here. */
  onTabClosed: (view: BrowseView) => void
  /** The active tab changed (null when none is left). */
  onActiveChanged: (next: BrowseView | null) => void
  /** Ctrl+L inside a page: focus the shell's address bar. */
  onFocusAddress: () => void
  /** True while the settings panel covers the browse area: views stay hidden. */
  isPanelOpen: () => boolean
  /** True once the app is quitting: closed tabs are not replaced by an empty one. */
  isQuitting: () => boolean
}

export interface TabManager {
  open(url: string | null, activate?: boolean): BrowseView | null
  close(id: number): void
  activate(id: number): void
  /** Opens `url` in the active tab, or in a new tab when there is none. */
  navigate(url: string): void
  go(action: BrowseAction): void
  active(): BrowseView | null
  isTab(webContentsId: number): boolean
  all(): BrowseView[]
  state(): TabsState
  /** Shows or hides the active view (settings panel). */
  setVisible(visible: boolean): void
  shortcut(shortcut: TabShortcut): void
  destroyAll(): void
}

export function createTabManager(options: TabManagerOptions): TabManager {
  const { win } = options
  const views = new Map<number, BrowseView>()
  let order: number[] = []
  let activeId: number | null = null
  let destroying = false

  const tabsState = (): TabsState => ({
    activeId,
    tabs: order.flatMap((id) => {
      const view = views.get(id)
      if (!view) return []
      const s = view.getState()
      return [{ id, url: s.url, title: s.title, loading: s.loading }]
    }),
  })

  const pushTabs = (): void => {
    if (destroying) return
    options.onTabs(tabsState())
    const urls: string[] = []
    let activeIndex = 0
    for (const id of order) {
      const url = views.get(id)?.getState().url ?? ''
      if (!isHttpUrl(url)) continue
      if (id === activeId) activeIndex = urls.length
      urls.push(url)
    }
    options.onSession(urls, activeIndex)
  }

  const pushActive = (): void => {
    const view = activeId === null ? null : views.get(activeId)
    options.onActiveState(view ? view.getState() : { url: '', title: '', canGoBack: false, canGoForward: false, loading: false })
  }

  const applyVisibility = (): void => {
    const show = !options.isPanelOpen()
    for (const [id, view] of views) view.setVisible(show && id === activeId)
  }

  /** A real popup window (sign-in dialogs need `window.opener` and close themselves). */
  const popupResponse = (): WindowOpenHandlerResponse => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: win,
      width: POPUP_DEFAULT.width,
      height: POPUP_DEFAULT.height,
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
    },
  })

  /**
   * Links and plain `window.open(url)` become tabs. `window.open` with window features (a sign-in
   * popup) becomes a real child window so the opener relationship survives; it may close itself.
   */
  const handleWindowOpen = (details: HandlerDetails): WindowOpenHandlerResponse => {
    if (!isHttpUrl(details.url)) {
      options.onNotice({ code: 'NAVIGATION_BLOCKED' })
      return { action: 'deny' }
    }
    if (details.disposition === 'new-window') return popupResponse()
    open(details.url, details.disposition !== 'background-tab')
    return { action: 'deny' }
  }

  /** Popups get the same guards as tabs: http(s) only, and their own new windows follow the same rules. */
  const guardPopup = (child: WebContents): void => {
    const block = (event: { url: string; preventDefault: () => void }): void => {
      if (!isHttpUrl(event.url)) event.preventDefault()
    }
    child.on('will-navigate', block)
    child.on('will-redirect', block)
    child.on('will-attach-webview', (event) => event.preventDefault())
    child.setWindowOpenHandler(handleWindowOpen)
    child.on('did-create-window', (popup) => guardPopup(popup.webContents))
    child.on('render-process-gone', (_event, details) => log.warn(`Popup process gone: ${details.reason}`))
  }

  function open(url: string | null, activate = true): BrowseView | null {
    if (destroying || win.isDestroyed()) return null
    if (views.size >= MAX_TABS) {
      log.warn(`Tab limit (${MAX_TABS}) reached; not opening another tab`)
      if (url) {
        const current = activeId === null ? null : views.get(activeId)
        current?.navigate(url)
      }
      return null
    }
    let id = -1
    const view = createBrowseView({
      win,
      preloadPath: options.preloadPath,
      onState: (state) => {
        if (id === activeId) options.onActiveState(state)
        pushTabs()
      },
      onNotice: options.onNotice,
      onNavigated: () => pushTabs(),
      onWindowOpen: handleWindowOpen,
      onShortcut: (s) => manager.shortcut(s),
    })
    id = view.webContentsId
    view.webContents.on('did-create-window', (popup) => guardPopup(popup.webContents))
    // The page closed itself (window.close()) or its process ended for good: drop the tab.
    view.onDestroyed(() => {
      if (views.has(id)) removeTab(id)
    })

    views.set(id, view)
    order.splice(insertIndex(order, activeId), 0, id)
    view.setVisible(false)
    options.onTabCreated(view)
    if (url) view.navigate(url)
    if (activate || activeId === null) setActive(id)
    else pushTabs()
    return view
  }

  function setActive(id: number | null): void {
    activeId = id
    applyVisibility()
    const view = id === null ? null : (views.get(id) ?? null)
    options.onActiveChanged(view)
    pushActive()
    pushTabs()
  }

  /** Removes a tab from the strip. Opens an empty tab when it was the last one. */
  function removeTab(id: number): void {
    const view = views.get(id)
    if (!view) return
    const next = nextAfterClose(order, id, activeId)
    options.onTabClosed(view)
    views.delete(id)
    order = order.filter((x) => x !== id)
    view.destroy()
    if (destroying || options.isQuitting() || win.isDestroyed()) return
    if (order.length === 0) {
      activeId = null
      open(null, true)
      options.onFocusAddress()
      return
    }
    if (next !== activeId) setActive(next)
    else pushTabs()
  }

  const manager: TabManager = {
    open,
    close: removeTab,
    activate(id) {
      if (views.has(id) && id !== activeId) setActive(id)
    },
    navigate(url) {
      const view = activeId === null ? null : views.get(activeId)
      if (view) view.navigate(url)
      else open(url, true)
    },
    go(action) {
      const view = activeId === null ? null : views.get(activeId)
      view?.go(action)
    },
    active: () => (activeId === null ? null : (views.get(activeId) ?? null)),
    isTab: (webContentsId) => views.has(webContentsId),
    all: () => order.flatMap((id) => views.get(id) ?? []),
    state: tabsState,
    setVisible() {
      applyVisibility()
    },
    shortcut(shortcut) {
      switch (shortcut) {
        case 'new-tab':
          open(null, true)
          options.onFocusAddress()
          break
        case 'close-tab':
          if (activeId !== null) removeTab(activeId)
          break
        case 'next-tab':
        case 'previous-tab': {
          const target = cycle(order, activeId, shortcut === 'next-tab' ? 1 : -1)
          if (target !== null) manager.activate(target)
          break
        }
        case 'reload':
          manager.go('reload')
          break
        case 'focus-address':
          options.onFocusAddress()
          break
      }
    },
    destroyAll() {
      destroying = true
      for (const id of [...order]) {
        const view = views.get(id)
        if (!view) continue
        options.onTabClosed(view)
        view.destroy()
      }
      views.clear()
      order = []
      activeId = null
    },
  }
  return manager
}
