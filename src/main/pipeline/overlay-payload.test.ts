import { describe, expect, it } from 'vitest'
import { OverlayResultSchema } from '../../shared/ipc/contract'
import { toOverlayPayload } from './overlay-payload'
import type { ImageResult, UnitResult } from './types'

const box = { x1: 1, y1: 2, x2: 30, y2: 40, confidence: 0.9 }
const unit = (patch: Partial<UnitResult>): UnitResult => ({
  kind: 'bubble',
  bubbleOnly: false,
  drawBox: box,
  ocrBox: box,
  ocrText: 'secret source text',
  translation: '你好',
  status: 'ok',
  ...patch,
})

const result = (units: UnitResult[]): ImageResult => ({
  hash: 'h'.repeat(64),
  width: 800,
  height: 1100,
  units,
  timings: { captureMs: 0, detectMs: 0, ocrMs: 0, translateMs: 0 },
  captureSource: 'cdp',
})

describe('toOverlayPayload', () => {
  const subscriber = { docId: 'doc-12345678', elId: 'rr7' }

  it('keeps only translated units and omits the source text', () => {
    const payload = toOverlayPayload(
      subscriber,
      result([
        unit({}),
        unit({ status: 'no-text', translation: '' }),
        unit({ status: 'echo', translation: '' }),
        unit({ status: 'translate-failed', translation: '' }),
        unit({ kind: 'free', translation: '  再见  ' }),
      ]),
    )
    expect(payload.units).toHaveLength(2)
    expect(payload.units[1]).toEqual({ kind: 'free', box: { x1: 1, y1: 2, x2: 30, y2: 40 }, text: '再见' })
    expect(JSON.stringify(payload)).not.toContain('secret')
    expect(OverlayResultSchema.safeParse(payload).success).toBe(true)
  })

  it('addresses the element and carries the analysed image size', () => {
    const payload = toOverlayPayload(subscriber, result([]))
    expect(payload).toMatchObject({ docId: 'doc-12345678', elId: 'rr7', width: 800, height: 1100, units: [] })
  })
})
