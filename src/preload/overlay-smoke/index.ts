// Preload of the headless overlay smoke window (`--headless-smoke=overlay`, development builds only).
// It drives the real OverlayManager inside a hidden window whose page has a strict CSP, then reports the
// measurements to the main process. Not part of the shipped app: excluded from the installer by electron-builder.
import { ipcRenderer } from 'electron'
import type { OverlayResult } from '../../shared/ipc/contract'
import { OVERLAY_FONT_FAMILY, OverlayManager } from '../browse/overlay'

const box = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 })

/** Boxes of the three bubbles found on fixtures/smoke/panel.png (800 x 1100), with sample translations. */
const payload: OverlayResult = {
  docId: 'smoke-doc-0001',
  elId: 'rr1',
  width: 800,
  height: 1100,
  units: [
    { kind: 'bubble', box: box(72, 75, 507, 285), text: '你好，今天怎么样？' },
    { kind: 'bubble', box: box(271, 476, 727, 695), text: '今天天气真好，我们一起去公园玩吧，顺便买点好吃的回来！' },
    { kind: 'free', box: box(82, 795, 457, 985), text: '在这儿等我。' },
  ],
}

window.addEventListener('DOMContentLoaded', () => {
  void run()
})

async function run(): Promise<void> {
  const violations: string[] = []
  document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective))
  const report: Record<string, unknown> = { ok: false }
  try {
    const img = document.querySelector('img')
    if (!img) throw new Error('The smoke page has no <img>')
    if (!img.complete) await new Promise((resolve) => img.addEventListener('load', resolve, { once: true }))

    const manager = new OverlayManager({
      doc: document,
      win: window,
      async loadFont() {
        return (await ipcRenderer.invoke('overlay-smoke:font')) as Uint8Array | null
      },
    })
    const rectOf = (): Record<string, number> => {
      const r = img.getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    }

    await manager.show(payload)
    report['imageRect'] = rectOf()
    report['shown'] = manager.snapshot()
    report['fontLoaded'] = [...document.fonts].some((f) => f.family.includes(OVERLAY_FONT_FAMILY) && f.status === 'loaded')

    // Click-through: the point in the middle of the first bubble must hit the image, not the overlay host.
    const first = (report['shown'] as ReturnType<typeof manager.snapshot>)[0]
    const hit = first
      ? document.elementFromPoint(first.rect.left + first.rect.width * 0.2, first.rect.top + first.rect.height * 0.15)
      : null
    report['hitIsImage'] = hit === img

    manager.setVisible(false)
    report['hidden'] = manager.snapshot()
    manager.setVisible(true)
    report['reshown'] = manager.snapshot()

    // Layout change: the image becomes half as large; the overlay must follow without a new result.
    img.width = Math.round(img.width / 2)
    img.height = Math.round(img.height / 2)
    manager.syncAll()
    report['resizedImageRect'] = rectOf()
    report['resized'] = manager.snapshot()

    img.remove()
    manager.syncAll()
    report['countAfterImageRemoved'] = manager.count

    report['violations'] = violations
    report['ok'] = true
  } catch (error) {
    report['error'] = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
  ipcRenderer.send('overlay-smoke:report', report)
}