import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { appIdentity } from '../../shared/app-identity'

export interface ShellWindow {
  win: BrowserWindow
  /** `webContents.id` of the shell renderer, used by the IPC sender check. */
  readonly webContentsId: number
  /** Resolves when the shell renderer finished loading. */
  loaded: Promise<void>
}

/** Creates the main window that hosts the shell UI (toolbar, status bar). */
export function createShellWindow(iconPath?: string): ShellWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: appIdentity.productName,
    ...(iconPath ? { icon: iconPath } : {}),
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/shell.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  const wc = win.webContents
  // The shell loads local files only: block navigation away and any new window.
  wc.on('will-navigate', (event) => event.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  wc.session.setPermissionCheckHandler(() => false)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loaded =
    !app.isPackaged && devUrl
      ? wc.loadURL(devUrl)
      : wc.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  return { win, webContentsId: wc.id, loaded }
}
