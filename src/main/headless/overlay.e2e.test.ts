import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getProcessInfo } from '../llama/win-process'
import type { OverlaySnapshot } from '../../preload/browse/overlay'
import { runElectronSmoke } from './electron-runner'

/**
 * Headless check of the overlay renderer in a HIDDEN Electron window (show: false) whose page has the CSP
 * `default-src 'none'`. No llama-server. Needs `out/` (npm run build).
 *
 *   npm run smoke:overlay
 *
 * What it proves: the Shadow DOM host is created and styled without CSP violations, the bundled Noto Sans SC loads
 * through FontFace, the host follows the image (size and scale), hiding keeps the results, text fits its box,
 * the overlay lets clicks through, and removing the image removes the overlay. What it cannot prove (manual):
 * how it looks and lines up on a live site.
 */
interface Report {
  ok: boolean
  error?: string
  windowVisible: boolean
  imageRect: { left: number; top: number; width: number; height: number }
  resizedImageRect: { left: number; top: number; width: number; height: number }
  shown: OverlaySnapshot[]
  hidden: OverlaySnapshot[]
  reshown: OverlaySnapshot[]
  resized: OverlaySnapshot[]
  fontLoaded: boolean
  hitIsImage: boolean
  countAfterImageRemoved: number
  violations: string[]
}

describe('headless overlay smoke (hidden window)', () => {
  it('draws, follows, hides and removes the overlay without CSP violations', async () => {
    expect(existsSync(join(import.meta.dirname, '../../../out/preload/overlay-smoke.cjs')), 'run npm run build first').toBe(true)
    const run = await runElectronSmoke<Report>('overlay', 90_000)
    console.log(run.output.trim())
    const r = run.report
    console.log(JSON.stringify({ ...r, shown: r.shown?.map((s) => ({ ...s, units: s.units.map((u) => ({ ...u, text: u.text.replace(/\n/g, '|') })) })) }, null, 2))

    expect(r.error).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(run.code).toBe(0)
    expect(r.windowVisible).toBe(false)

    // The host sits exactly on the image and ignores the mouse.
    const host = r.shown[0] as OverlaySnapshot
    expect(r.shown).toHaveLength(1)
    expect(host.position).toBe('fixed')
    expect(host.pointerEvents).toBe('none')
    expect(host.display).toBe('block')
    expect(host.rect.width).toBeCloseTo(r.imageRect.width, 0)
    expect(host.rect.height).toBeCloseTo(r.imageRect.height, 0)
    expect(host.rect.left).toBeCloseTo(r.imageRect.left, 0)
    expect(host.rect.top).toBeCloseTo(r.imageRect.top, 0)
    expect(r.hitIsImage).toBe(true)

    // Bundled font loaded through FontFace; the page CSP did not interfere.
    expect(r.fontLoaded).toBe(true)
    expect(r.violations).toEqual([])

    // Text is fitted: three units, non-trivial font sizes, the long text wrapped to several lines inside its area.
    expect(host.units).toHaveLength(3)
    for (const unit of host.units) {
      expect(unit.fontSizePx).toBeGreaterThan(4)
      expect(unit.lines * unit.lineHeightPx).toBeLessThanOrEqual(unit.box.height + 1)
    }
    expect(host.units[1]?.lines).toBeGreaterThan(1)
    expect(host.units[1]?.text).toContain('\n')

    // Global toggle: hidden keeps the result, showing again restores it.
    expect(r.hidden[0]?.display).toBe('none')
    expect(r.hidden[0]?.units).toHaveLength(3)
    expect(r.reshown[0]?.display).toBe('block')

    // Layout change: image at half size, host and font sizes follow (scale 0.5 relative to the first layout).
    expect(r.resized[0]?.rect.width).toBeCloseTo(r.resizedImageRect.width, 0)
    expect(r.resizedImageRect.width).toBeCloseTo(r.imageRect.width / 2, 0)
    const before = host.units[0]?.fontSizePx ?? 0
    const after = r.resized[0]?.units[0]?.fontSizePx ?? 0
    expect(after / before).toBeCloseTo(0.5, 1)

    expect(r.countAfterImageRemoved).toBe(0)

    // Nothing may survive the run.
    expect(await getProcessInfo(run.pid)).toBeNull()
  }, 150_000)
})
