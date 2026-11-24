// Browse-view preload. It runs in an isolated world next to untrusted pages and
// deliberately exposes nothing to them (no contextBridge). It discovers images,
// reports them to main over IPC, receives its settings from main and draws the
// translation overlay (Shadow DOM hosts, see overlay.ts).
import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { IpcResult, PageConfig, PageImage } from '../../shared/ipc/contract'
import { OverlayManager, isOverlayResult } from './overlay'
import { imageMatchesUrl, normalizeUrl, pickBackgroundTarget, pickContextImage } from './context-image'
import { ScrollQueue } from './scroll-queue'
import { WebTextTranslator, sampleText } from './webtext'

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

const webText = new WebTextTranslator({
  doc: document,
  async translate(texts) {
    const result = (await ipcRenderer.invoke('webtext:translate', { docId, texts })) as IpcResult<{ translations: string[] }>
    if (!result.ok) throw new Error(result.error.code)
    return result.value.translations
  },
  done(state) {
    void ipcRenderer.invoke('webtext:done', { docId, state })
  },
})

/** Tells main the page language once the document is parsed, so it can offer a translation. */
function reportLanguage(): void {
  const lang = (document.documentElement.getAttribute('lang') ?? '').slice(0, 35)
  void ipcRenderer.invoke('webtext:page', { docId, lang, sample: lang ? '' : sampleText(document) }).catch(() => {})
}

// Settings pushed from main (auto-translate toggled, config changed).
ipcRenderer.on('page:config', (_event: IpcRendererEvent, config: PageConfig) => {
  applyConfig(config)
})

// A finished image from the pipeline. Results for another document are ignored.
ipcRenderer.on('overlay:result', (_event: IpcRendererEvent, payload: unknown) => {
  if (isOverlayResult(payload) && payload.docId === docId) void overlay.show(payload)
})

// Right-click "translate this image": main sends the click position and the URL the browser reported.
// Find that image, tag it and ask main to translate it now (whatever the auto-translate switch says).
ipcRenderer.on('page:translate-request', (_event: IpcRendererEvent, request: unknown) => {
  const { x, y, srcUrl } = (request ?? {}) as { x?: unknown; y?: unknown; srcUrl?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number' || typeof srcUrl !== 'string') return
  const atPoint = document.elementsFromPoint(x, y).filter((el): el is HTMLImageElement => el instanceof HTMLImageElement)
  const reportNone = (): void => void ipcRenderer.invoke('page:translate-none', { docId }).catch(() => {})
  let image = null as ReturnType<typeof queue.describeImage>
  const img = pickContextImage(atPoint, document.images, srcUrl, document.baseURI)
  if (img) {
    const matched = imageMatchesUrl(img, srcUrl, document.baseURI) ? normalizeUrl(srcUrl, document.baseURI) : null
    image = queue.describeImage(img, matched ?? undefined)
  } else {
    // No <img> there: a reader that paints the page as a CSS background (or under a transparent layer) has the URL
    // in the computed style of an element stacked at the click.
    const bg = pickBackgroundTarget(document.elementsFromPoint(x, y), (el) => getComputedStyle(el).backgroundImage, document.baseURI)
    if (bg) image = queue.describeElement(bg.el, bg.url)
  }
  if (!image) {
    reportNone()
    return
  }
  void ipcRenderer.invoke('page:translate-image', { docId, pageUrl: location.href, image }).catch(() => {})
})

/** Only top-level documents are scanned; sandboxed iframes get no preload anyway. */
if (window.top === window) {
  // Commands from the translate bar. Only the top document has a bar.
  ipcRenderer.on('webtext:command', (_event: IpcRendererEvent, command: unknown) => {
    const action = (command as { action?: unknown } | null)?.action
    if (action === 'translate') void webText.translatePage()
    else if (action === 'restore') webText.restore()
  })

  void ipcRenderer
    .invoke('page:hello', { docId, url: location.href })
    .then((result: IpcResult<PageConfig>) => {
      if (result.ok) applyConfig(result.value)
    })
    .catch(() => {})

  // Wait a moment after parsing: many sites set <html lang> or render their text with scripts.
  const scheduleReport = (): void => {
    setTimeout(reportLanguage, 800)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scheduleReport, { once: true })
  else scheduleReport()
}
