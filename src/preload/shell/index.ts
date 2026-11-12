import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { isEventChannel, isInvokeChannel } from '../../shared/ipc/channels'
import type { RawReaderApi } from '../../shared/ipc/api'

// Only channel names are imported at runtime; payload types are compile-time only.
const api: RawReaderApi = {
  invoke(channel, ...args) {
    if (!isInvokeChannel(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown IPC channel' },
      })
    }
    return ipcRenderer.invoke(channel, args[0])
  },
  on(event, callback) {
    if (!isEventChannel(event)) return () => {}
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      callback(payload as never)
    }
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.removeListener(event, listener)
    }
  },
}

contextBridge.exposeInMainWorld('rawreader', api)
