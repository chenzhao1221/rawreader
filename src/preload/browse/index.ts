// Browse-view preload. It runs in an isolated world next to untrusted pages and
// deliberately exposes nothing to them (no contextBridge). It discovers images,
// reports them to main over IPC and receives its settings from main. Later
// slices add the overlay here.
import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { IpcResult, PageConfig, PageImage } from '../../shared/ipc/contract'
import { ScrollQueue } from './scroll-queue'

/** New random id for every document load; main drops results for stale ids (R5.5). */
const docId = crypto.randomUUID()

const queue = new ScrollQueue({
  report(images: PageImage[]) {
    void ipcRenderer.invoke('page:images', { docId, pageUrl: location.href, images })
  },
})

// Settings pushed from main (auto-translate toggled, config changed).
ipcRenderer.on('page:config', (_event: IpcRendererEvent, config: PageConfig) => {
  queue.setConfig(config)
})

/** Only top-level documents are scanned; sandboxed iframes get no preload anyway. */
if (window.top === window) {
  void ipcRenderer
    .invoke('page:hello', { docId, url: location.href })
    .then((result: IpcResult<PageConfig>) => {
      if (result.ok) queue.setConfig(result.value)
    })
    .catch(() => {})
}
