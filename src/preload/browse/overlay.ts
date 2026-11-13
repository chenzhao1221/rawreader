// Overlay renderer of the browse preload (design section 11, R9).
//
// One fixed-position host element per translated image, appended to <html> (never inside the page's
// own containers, so framework re-renders cannot remove it and body transforms cannot offset it).
// Each host has a closed Shadow DOM, `pointer-events: none`, and is kept glued to the live <img> by an
// rAF-throttled sync (ResizeObserver, scroll, resize, load, slow poll). Styles use CSSOM calls and a
// constructable stylesheet only, so a strict page CSP (style-src without 'unsafe-inline') cannot block them.
// Geometry maths: overlay-geometry.ts. Text fitting: text-fit.ts. Bundled Noto Sans SC arrives from main
// as bytes and is registered with FontFace, which no page CSP governs.

import type { OverlayResult, OverlayUnit } from '../../shared/ipc/contract'
import { computeHostGeometry, isNearViewport, rectChanged, scaleBox, textAreaFor } from './overlay-geometry'
import type { Rect } from './overlay-geometry'
import { calculateFittedTextLayout } from './text-fit'
import type { FittedTextLayout, MeasureFn } from './text-fit'

export const OVERLAY_FONT_FAMILY = 'RawReader Noto Sans SC'
const FONT_STACK = `"${OVERLAY_FONT_FAMILY}", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`
const ELEMENT_ID_ATTR = 'data-rr-id'
const HOST_Z_INDEX = '2147483646'
const POLL_INTERVAL_MS = 500
/** Hosts of images farther than this from the viewport are hidden. */
const CULL_MARGIN_PX = 1200
const FONT_LOAD_TIMEOUT_MS = 8000

const SHEET_CSS = `
.bg { position: absolute; box-sizing: border-box; background: rgba(255, 255, 255, 0.92); }
.txt { position: absolute; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
  text-align: center; white-space: pre; overflow: visible; color: #111; font-weight: 700;
  font-family: ${FONT_STACK}; }
`

export interface OverlayOptions {
  doc: Document
  win: Window & typeof globalThis
  /** Returns the bundled font bytes from main, or null when unavailable. */
  loadFont: () => Promise<Uint8Array | null>
}

interface UnitView {
  bg: HTMLDivElement
  txt: HTMLDivElement
  unit: OverlayUnit
  layout: FittedTextLayout
  /** Where the text is drawn, in image pixels. */
  area: { x1: number; y1: number; x2: number; y2: number }
}

interface Entry {
  el: HTMLImageElement
  host: HTMLDivElement
  payload: OverlayResult
  units: UnitView[]
  rect: Rect | null
}

export interface OverlaySnapshot {
  elId: string
  display: string
  pointerEvents: string
  position: string
  rect: Rect
  units: Array<{ text: string; fontSizePx: number; lineHeightPx: number; lines: number; box: Rect }>
}

/** Light shape check; the message comes from our own main process, but it crosses an IPC boundary. */
export function isOverlayResult(value: unknown): value is OverlayResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<OverlayResult>
  return (
    typeof v.docId === 'string' &&
    typeof v.elId === 'string' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number' &&
    Array.isArray(v.units)
  )
}

export class OverlayManager {
  private readonly entries = new Map<string, Entry>()
  private visible = true
  private raf = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private resizeObserver: ResizeObserver | null = null
  private sheet: CSSStyleSheet | null = null
  private fontReady: Promise<void> | null = null
  private measure: MeasureFn | null = null
  private disposed = false
  private readonly onScrollOrResize = (): void => this.scheduleSync()

  constructor(private readonly options: OverlayOptions) {}

  /** Global "show translation" switch (R3.3). Hiding keeps every result so showing again is instant. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.syncAll()
  }

  get count(): number {
    return this.entries.size
  }

  /**
   * Read-only view of what is on screen, for the headless overlay smoke test (the shadow root is closed, so a
   * page cannot look inside; this is the only way to inspect it). Values come from the inline styles set by the sync.
   */
  snapshot(): OverlaySnapshot[] {
    const px = (value: string): number => Number.parseFloat(value)
    return [...this.entries.entries()].map(([elId, entry]) => ({
      elId,
      display: entry.host.style.getPropertyValue('display'),
      pointerEvents: entry.host.style.getPropertyValue('pointer-events'),
      position: entry.host.style.getPropertyValue('position'),
      rect: {
        left: px(entry.host.style.getPropertyValue('left')),
        top: px(entry.host.style.getPropertyValue('top')),
        width: px(entry.host.style.getPropertyValue('width')),
        height: px(entry.host.style.getPropertyValue('height')),
      },
      units: entry.units.map((view) => ({
        text: view.txt.textContent ?? '',
        fontSizePx: px(view.txt.style.getPropertyValue('font-size')),
        lineHeightPx: px(view.txt.style.getPropertyValue('line-height')),
        lines: view.layout.lines.length,
        box: {
          left: px(view.txt.style.getPropertyValue('left')),
          top: px(view.txt.style.getPropertyValue('top')),
          width: px(view.txt.style.getPropertyValue('width')),
          height: px(view.txt.style.getPropertyValue('height')),
        },
      })),
    }))
  }

  /** Draws (or redraws) the overlay of one image. Ignored when the element is gone. */
  async show(payload: OverlayResult): Promise<void> {
    if (this.disposed) return
    const el = this.findElement(payload.elId)
    if (!el) return
    await this.ensureFont()
    if (this.disposed || !el.isConnected) return

    this.remove(payload.elId)
    if (payload.units.length === 0 || payload.width < 1 || payload.height < 1) return

    const host = this.options.doc.createElement('div')
    const shadow = host.attachShadow({ mode: 'closed' })
    shadow.adoptedStyleSheets = [this.getSheet()]
    this.styleHost(host)

    const measure = this.getMeasure()
    const maxFont = Math.round(Math.max(28, Math.min(64, payload.width / 20)))
    const units: UnitView[] = []
    for (const unit of payload.units) {
      if (!unit.text) continue
      const area = textAreaFor(unit.kind, unit.box, { width: payload.width, height: payload.height })
      const layout = calculateFittedTextLayout(unit.text, area.x2 - area.x1, area.y2 - area.y1, measure, {
        pad: unit.kind === 'bubble' ? 6 : 3,
        maxFontSize: maxFont,
      })
      const bg = this.options.doc.createElement('div')
      bg.className = 'bg'
      const txt = this.options.doc.createElement('div')
      txt.className = 'txt'
      txt.textContent = layout.lines.join('\n')
      shadow.append(bg, txt)
      units.push({ bg, txt, unit, layout, area })
    }
    if (units.length === 0) return

    const entry: Entry = { el, host, payload, units, rect: null }
    this.entries.set(payload.elId, entry)
    this.options.doc.documentElement.appendChild(host)
    this.startObserving(el)
    this.syncAll()
  }

  /** Removes the overlay of one element. */
  remove(elId: string): void {
    const entry = this.entries.get(elId)
    if (!entry) return
    this.resizeObserver?.unobserve(entry.el)
    entry.host.remove()
    this.entries.delete(elId)
    if (this.entries.size === 0) this.stopObserving()
  }

  /** Removes every overlay (document teardown). */
  dispose(): void {
    this.disposed = true
    for (const id of [...this.entries.keys()]) this.remove(id)
    this.stopObserving()
  }

  // -------------------------------------------------------------------------

  private findElement(elId: string): HTMLImageElement | null {
    const selector = `img[${ELEMENT_ID_ATTR}="${this.options.win.CSS.escape(elId)}"]`
    return this.options.doc.querySelector<HTMLImageElement>(selector)
  }

  private getSheet(): CSSStyleSheet {
    if (!this.sheet) {
      this.sheet = new this.options.win.CSSStyleSheet()
      this.sheet.replaceSync(SHEET_CSS)
    }
    return this.sheet
  }

  private styleHost(host: HTMLDivElement): void {
    const s = host.style
    s.setProperty('all', 'initial')
    s.setProperty('position', 'fixed')
    s.setProperty('z-index', HOST_Z_INDEX)
    s.setProperty('pointer-events', 'none')
    s.setProperty('overflow', 'hidden')
    s.setProperty('margin', '0')
    s.setProperty('padding', '0')
    s.setProperty('border', '0')
    s.setProperty('display', 'none')
    s.setProperty('contain', 'layout style')
  }

  /** Loads the bundled font once. Failures fall back to the system CJK fonts in the stack. */
  private ensureFont(): Promise<void> {
    this.fontReady ??= (async () => {
      try {
        const bytes = await this.options.loadFont()
        if (!bytes || bytes.byteLength === 0) return
        const copy = bytes.slice().buffer as ArrayBuffer
        const face = new this.options.win.FontFace(OVERLAY_FONT_FAMILY, copy, { weight: '700' })
        await Promise.race([
          face.load(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('font load timeout')), FONT_LOAD_TIMEOUT_MS)),
        ])
        this.options.doc.fonts.add(face)
      } catch {
        // Keep going with the fallback fonts.
      }
    })()
    return this.fontReady
  }

  private getMeasure(): MeasureFn {
    if (this.measure) return this.measure
    const ctx = this.options.doc.createElement('canvas').getContext('2d')
    if (!ctx) {
      this.measure = (text, size) => [...text].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x2000 ? size * 0.55 : size), 0)
      return this.measure
    }
    let currentSize = -1
    this.measure = (text, size) => {
      if (size !== currentSize) {
        ctx.font = `700 ${size}px ${FONT_STACK}`
        currentSize = size
      }
      return ctx.measureText(text).width
    }
    return this.measure
  }

  // -------------------------------------------------------------------------
  // Geometry sync (LMT syncWrapperGeometry + createImageObservers, see overlay-geometry.ts)

  private startObserving(el: HTMLImageElement): void {
    const { win } = this.options
    if (!this.resizeObserver) {
      this.resizeObserver = new win.ResizeObserver(() => this.scheduleSync())
      win.addEventListener('scroll', this.onScrollOrResize, { capture: true, passive: true })
      win.addEventListener('resize', this.onScrollOrResize, { passive: true })
      this.pollTimer = setInterval(() => this.scheduleSync(), POLL_INTERVAL_MS)
    }
    this.resizeObserver.observe(el)
    el.addEventListener('load', this.onScrollOrResize, { once: true })
  }

  private stopObserving(): void {
    const { win } = this.options
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    win.removeEventListener('scroll', this.onScrollOrResize, { capture: true })
    win.removeEventListener('resize', this.onScrollOrResize)
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.raf) win.cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private scheduleSync(): void {
    if (this.raf || this.disposed) return
    this.raf = this.options.win.requestAnimationFrame(() => {
      this.raf = 0
      this.syncAll()
    })
  }

  /** Brings every host in line with its image and the visibility switch. */
  syncAll(): void {
    const viewport = { width: this.options.win.innerWidth, height: this.options.win.innerHeight }
    for (const [id, entry] of [...this.entries]) {
      if (!entry.el.isConnected) {
        this.remove(id)
        continue
      }
      const box = entry.el.getBoundingClientRect()
      const geometry = computeHostGeometry(
        { left: box.left, top: box.top, width: box.width, height: box.height },
        { width: entry.payload.width, height: entry.payload.height },
      )
      const hostStyle = entry.host.style
      if (!geometry || !this.visible || !isNearViewport(geometry.rect, viewport, CULL_MARGIN_PX)) {
        hostStyle.setProperty('display', 'none')
        continue
      }
      if (rectChanged(entry.rect, geometry.rect)) {
        hostStyle.setProperty('left', `${geometry.rect.left}px`)
        hostStyle.setProperty('top', `${geometry.rect.top}px`)
        const resized =
          entry.rect === null ||
          Math.abs(entry.rect.width - geometry.rect.width) >= 0.5 ||
          Math.abs(entry.rect.height - geometry.rect.height) >= 0.5
        if (resized) {
          hostStyle.setProperty('width', `${geometry.rect.width}px`)
          hostStyle.setProperty('height', `${geometry.rect.height}px`)
          this.layoutUnits(entry, geometry.scaleX, geometry.scaleY)
        }
        entry.rect = geometry.rect
      }
      hostStyle.setProperty('display', 'block')
    }
  }

  private layoutUnits(entry: Entry, scaleX: number, scaleY: number): void {
    const textScale = (scaleX + scaleY) / 2
    for (const view of entry.units) {
      const draw = view.unit.kind === 'bubble' ? scaleBox(view.unit.box, scaleX, scaleY) : scaleBox(view.area, scaleX, scaleY)
      const bg = view.bg.style
      bg.setProperty('left', `${draw.left}px`)
      bg.setProperty('top', `${draw.top}px`)
      bg.setProperty('width', `${draw.width}px`)
      bg.setProperty('height', `${draw.height}px`)
      const radius = view.unit.kind === 'bubble' ? Math.min(draw.width, draw.height) * 0.3 : Math.min(draw.width, draw.height) * 0.1
      bg.setProperty('border-radius', `${radius}px`)

      const area = scaleBox(view.area, scaleX, scaleY)
      const txt = view.txt.style
      txt.setProperty('left', `${area.left}px`)
      txt.setProperty('top', `${area.top}px`)
      txt.setProperty('width', `${area.width}px`)
      txt.setProperty('height', `${area.height}px`)
      txt.setProperty('font-size', `${view.layout.fontSize * textScale}px`)
      txt.setProperty('line-height', `${view.layout.lineH * textScale}px`)
    }
  }
}
