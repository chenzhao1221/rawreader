import { WebContentsView } from 'electron'
import type { BrowserWindow, HandlerDetails, WindowOpenHandlerResponse } from 'electron'
import { BROWSE_PARTITION } from '../../shared/constants'
import type { BrowseState, ShellNotice } from '../../shared/ipc/contract'
import { createLogger } from '../log/log'
import { isHttpUrl } from './address'
import { computeBrowseBounds } from './layout'
import { shortcutFor } from './tab-order'
import type { TabShortcut } from './tab-order'

const log = createLogger('browse')

/** Chromium reports a user-cancelled or superseded load as ERR_ABORTED (-3). */
const ERR_ABORTED = -3

export type BrowseAction = 'back' | 'forward' | 'reload' | 'stop'

export interface BrowseViewOptions {
  win: BrowserWindow
  /** Absolute path of the browse preload bundle. */
  preloadPath: string
  onState: (state: BrowseState) => void
  onNotice: (notice: ShellNotice) => void
  /** Called with the URL after each main-frame navigation to an http(s) page. */
  onNavigated: (url: string) => void
  /** Decides what a `window.open` / target=_blank does (new tab, popup window, or nothing). */
  onWindowOpen: (details: HandlerDetails) => WindowOpenHandlerResponse
  onShortcut: (shortcut: TabShortcut) => void
}

export interface BrowseView {
  /** `webContents.id` of the browse view, used by the IPC sender check and as the tab id. */
  readonly webContentsId: number
  /** The browse webContents, for the capture and pipeline wiring. Check isDestroyed() before use. */
  readonly webContents: Electron.WebContents
  navigate(url: string): void
  go(action: BrowseAction): void
  setVisible(visible: boolean): void
  updateBounds(): void
  getState(): BrowseState
  destroy(): void
  /** Registers a listener for the browse webContents being destroyed. */
  onDestroyed(listener: () => void): void
}

export function createBrowseView(options: BrowseViewOptions): BrowseView {
  const { win } = options
  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSE_PARTITION,
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // A hidden, occluded or background window would otherwise pause rAF (overlay geometry) and
      // IntersectionObserver (image discovery). Same reason as in headless/overlay-smoke.ts.
      backgroundThrottling: false,
    },
  })
  const wc = view.webContents
  win.contentView.addChildView(view)

  const closedState: BrowseState = { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }
  const getState = (): BrowseState => wc.isDestroyed() ? closedState : ({
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  })
  // A page can destroy its own webContents (window.close()); every later call must tolerate that.
  const pushState = (): void => {
    if (!wc.isDestroyed()) options.onState(getState())
  }

  const load = (url: string): void => {
    // Failures surface through `did-fail-load`; the rejection carries no extra information.
    if (wc.isDestroyed()) return
    wc.loadURL(url).catch(() => {})
  }

  // --- Navigation guards: http(s) only, no webview tags. New windows go to the tab manager. ---
  const guard = (event: { url: string; preventDefault: () => void }): void => {
    if (!isHttpUrl(event.url)) {
      event.preventDefault()
      options.onNotice({ code: 'NAVIGATION_BLOCKED' })
    }
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.setWindowOpenHandler((details) => options.onWindowOpen(details))

  wc.on('before-input-event', (event, input) => {
    const shortcut = shortcutFor(input)
    if (!shortcut) return
    event.preventDefault()
    options.onShortcut(shortcut)
  })

  // --- Diagnostics: a crashed page must leave a trace in main.log. ---
  wc.on('render-process-gone', (_event, details) => {
    log.error(`Browse page process gone: ${details.reason} (exit code ${details.exitCode})`)
  })
  wc.on('unresponsive', () => log.warn('Browse page is not responding'))

  // --- State pushed to the shell. ---
  wc.on('did-start-loading', pushState)
  wc.on('did-stop-loading', pushState)
  wc.on('page-title-updated', pushState)
  wc.on('did-navigate', (_event, url) => {
    if (isHttpUrl(url)) options.onNavigated(url)
    pushState()
  })
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && isHttpUrl(url)) options.onNavigated(url)
    pushState()
  })
  wc.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) {
      log.warn(`Main-frame load failed (error ${errorCode})`)
      options.onNotice({ code: 'LOAD_FAILED' })
    }
  })

  const updateBounds = (): void => {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    view.setBounds(computeBrowseBounds({ width: width ?? 0, height: height ?? 0 }))
  }
  updateBounds()
  win.on('resize', updateBounds)

  let removed = false
  const remove = (): void => {
    if (removed) return
    removed = true
    if (!win.isDestroyed()) {
      win.off('resize', updateBounds)
      win.contentView.removeChildView(view)
    }
  }
  wc.once('destroyed', remove)

  return {
    webContentsId: wc.id,
    webContents: wc,
    navigate: load,
    go(action) {
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
        case 'stop':
          wc.stop()
          break
      }
    },
    setVisible: (visible) => view.setVisible(visible),
    updateBounds,
    getState,
    onDestroyed: (listener) => {
      wc.once('destroyed', listener)
    },
    destroy() {
      remove()
      if (!wc.isDestroyed()) wc.close()
    },
  }
}
