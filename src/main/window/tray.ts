import { Menu, Tray, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'
import { appIdentity } from '../../shared/app-identity'

export const TRAY_LABELS = {
  show: '显示主界面',
  quit: '退出',
  hintTitle: 'RawReader 已最小化到托盘',
  hintBody: '程序仍在后台运行，右键右下角图标可彻底退出。',
} as const

export interface AppTrayOptions {
  iconPath: string
  getWindow: () => BrowserWindow | null
  /** Real quit: stops the servers through the before-quit guard. */
  quit: () => void
}

export interface AppTray {
  /** Shows the "still running" balloon (Windows). */
  showHint(): void
  destroy(): void
}

/** Brings a hidden or minimised window back to the front. */
export function showWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/** Tray icon with "show" and "quit". A click on the icon also shows the window. */
export function createAppTray(options: AppTrayOptions): AppTray {
  const icon = nativeImage.createFromPath(options.iconPath)
  const tray = new Tray(icon)
  tray.setToolTip(appIdentity.productName)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: TRAY_LABELS.show, click: () => showWindow(options.getWindow()) },
      { type: 'separator' },
      { label: TRAY_LABELS.quit, click: () => options.quit() },
    ]),
  )
  tray.on('click', () => showWindow(options.getWindow()))

  return {
    showHint() {
      if (tray.isDestroyed()) return
      tray.displayBalloon({ iconType: 'info', title: TRAY_LABELS.hintTitle, content: TRAY_LABELS.hintBody })
    },
    destroy() {
      if (!tray.isDestroyed()) tray.destroy()
    },
  }
}
