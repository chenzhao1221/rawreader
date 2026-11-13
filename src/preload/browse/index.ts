// Browse-view preload. It runs in an isolated world next to untrusted pages and
// deliberately exposes nothing to them (no contextBridge). It discovers images,
// reports them to main over IPC, receives its settings from main and draws the
// translation overlay (Shadow DOM hosts, see overlay.ts).
import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { IpcResult, PageConfig, PageImage } from '../../shared/ipc/contract'
import { OverlayManager, isOverlayResult } from './overlay'
import { ScrollQueue } from './scroll-queue'

/** New random id for every document load; main drops results for stale ids (R5.5). */
const docId = crypto.randomUUID()

const queue = new ScrollQueue({
  report(images: PageImage[]) {
    void ipcRenderer.invoke('page:images', { docId, pageUrl: location.href, images })
  },
})

const overlay = new OverlayManager({
  doc: document,
  win: window,
  async loadFont() {
    const result = (await ipcRenderer.invoke('overlay:font')) as IpcResult<Uint8Array | null>
    return result.ok ? result.value : null
  },
})

function applyConfig(config: PageConfig): void {
  queue.setConfig(config)
  overlay.setVisible(config.overlayVisible)
}

// Settings pushed from main (auto-translate toggled, config changed).
ipcRenderer.on('page:config', (_event: IpcRendererEvent, config: PageConfig) => {
  applyConfig(config)
})

// A finished image from the pipeline. Results for another document are ignored.
ipcRenderer.on('overlay:result', (_event: IpcRendererEvent, payload: unknown) => {
  if (isOverlayResult(payload) && payload.docId === docId) void overlay.show(payload)
})

/** Only top-level documents are scanned; sandboxed iframes get no preload anyway. */
if (window.top === window) {
  void ipcRenderer
    .invoke('page:hello', { docId, url: location.href })
    .then((result: IpcResult<PageConfig>) => {
      if (result.ok) applyConfig(result.value)
    })
    .catch(() => {})
}
