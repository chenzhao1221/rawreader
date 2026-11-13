import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { overlayFontPath } from '../overlay/font'

export interface OverlaySmokeOptions {
  /** Repository root (`app.getAppPath()`). */
  root: string
  timeoutMs?: number
}

/**
 * Loads the SFW panel into a HIDDEN window (`show: false`, never shown, not in the taskbar) whose page has a strict
 * CSP, runs the real OverlayManager through `out/preload/overlay-smoke.cjs` and returns what the preload measured.
 * No llama-server is started. The window is destroyed before this resolves.
 */
export function runOverlaySmoke(options: OverlaySmokeOptions): Promise<Record<string, unknown>> {
  const { root } = options
  const fontBytes = readFileSync(overlayFontPath(join(root, 'resources')))
  const panel = readFileSync(join(root, 'fixtures', 'smoke', 'panel.png')).toString('base64')
  // default-src 'none': no scripts, inline styles or fonts from the page itself. Only data: images are allowed.
  const html =
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:">` +
    `<body><img data-rr-id="rr1" width="400" height="550" src="data:image/png;base64,${panel}"></body>`

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      focusable: false,
      width: 900,
      height: 700,
      webPreferences: {
        preload: join(root, 'out', 'preload', 'overlay-smoke.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // A hidden window would otherwise stop requestAnimationFrame, which the geometry sync uses.
        backgroundThrottling: false,
      },
    })
    let settled = false
    const done = (report: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeHandler('overlay-smoke:font')
      ipcMain.removeAllListeners('overlay-smoke:report')
      if (!win.isDestroyed()) win.destroy()
      resolve(report)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'Timed out waiting for the overlay smoke report' }), options.timeoutMs ?? 60_000)
    ipcMain.handle('overlay-smoke:font', () => new Uint8Array(fontBytes))
    ipcMain.once('overlay-smoke:report', (_event, report: Record<string, unknown>) => done({ ...report, windowVisible: win.isVisible() }))
    win.webContents.on('preload-error', (_event, path, error) => done({ ok: false, error: `preload error in ${path}: ${error.message}` }))
    void win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`).catch((error: unknown) => {
      done({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
  })
}