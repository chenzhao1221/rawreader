import { WebContentsView } from 'electron'
import type { BrowserWindow } from 'electron'
import { BROWSE_PARTITION } from '../../shared/constants'
import type { BrowseState, ShellNotice } from '../../shared/ipc/contract'
import { createLogger } from '../log/log'
import { isHttpUrl } from './address'
import { computeBrowseBounds } from './layout'

const log = createLogger('browse')

/** Chromium reports a user-cancelled or superseded load as ERR_ABORTED (-3). */
const ERR_ABORTED = -3

export type BrowseAction = 'back' | 'forward' | 'reload' | 'stop'

export interface BrowseViewOptions {
  win: BrowserWindow
  /** Absolute path of the (currently empty) browse preload bundle. */
  preloadPath: string
  onState: (state: BrowseState) => void
  onNotice: (notice: ShellNotice) => void
  /** Called with the URL after each main-frame navigation to an http(s) page. */
  onNavigated: (url: string) => void
}

export interface BrowseView {
  /** `webContents.id` of the browse view, used by the IPC sender check. */
  readonly webContentsId: number
  /** The browse webContents, for the capture and pipeline wiring. Check isDestroyed() before use. */
  readonly webContents: Electron.WebContents
  navigate(url: string): void
  go(action: BrowseAction): void
  setVisible(visible: boolean): void
  updateBounds(): void
  getState(): BrowseState
  destroy(): void
  /** Registers a listener for the browse webContents being destroyed (diagnostics). */
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

  // --- Navigation guards: http(s) only, no new windows, no webview tags. ---
  const guard = (event: { url: string; preventDefault: () => void }): void => {
    if (!isHttpUrl(event.url)) {
      event.preventDefault()
      options.onNotice({ code: 'NAVIGATION_BLOCKED' })
    }
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) load(url)
    else options.onNotice({ code: 'NAVIGATION_BLOCKED' })
    return { action: 'deny' }
  })

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
    const [width, height] = win.getContentSize()
    view.setBounds(computeBrowseBounds({ width: width ?? 0, height: height ?? 0 }))
  }
  updateBounds()
  win.on('resize', updateBounds)

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
      if (win.isDestroyed()) return
      win.off('resize', updateBounds)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}
