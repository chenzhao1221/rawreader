import { dialog, net } from 'electron'
import type { BrowserWindow } from 'electron'
import type { FetchLike } from './download'
import type { ModelPickers } from './service'

/** Electron `net.fetch`: follows redirects and honours the system proxy (needed for GitHub from China). */
export const netFetch: FetchLike = (url, init) =>
  net.fetch(url, {
    headers: init.headers,
    signal: init.signal,
    ...(init.method ? { method: init.method } : {}),
  })

/** Native folder and file dialogs. Only called from an IPC handler after a click in the settings UI. */
export function createDialogPickers(getWindow: () => BrowserWindow | null): ModelPickers {
  const options = { properties: ['openDirectory'] as Array<'openDirectory'> }
  return {
    async pickFolder() {
      const win = getWindow()
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null)
    },
    async pickFile() {
      const fileOptions = { properties: ['openFile'] as Array<'openFile'>, filters: [{ name: 'GGUF / ONNX', extensions: ['gguf', 'onnx'] }] }
      const win = getWindow()
      const result = win ? await dialog.showOpenDialog(win, fileOptions) : await dialog.showOpenDialog(fileOptions)
      return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null)
    },
  }
}