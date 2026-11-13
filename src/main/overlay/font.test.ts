import { describe, expect, it, vi } from 'vitest'
import { OVERLAY_FONT_FILE, createFontProvider, overlayFontPath } from './font'

describe('createFontProvider', () => {
  it('reads the font once and serves it from memory', async () => {
    const readFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    const get = createFontProvider('C:\\res', readFile)
    expect(await get()).toEqual(new Uint8Array([1, 2, 3]))
    expect(await get()).toEqual(new Uint8Array([1, 2, 3]))
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith(overlayFontPath('C:\\res'))
    expect(overlayFontPath('C:\\res')).toContain(OVERLAY_FONT_FILE)
  })

  it('returns null for a missing file and retries later', async () => {
    const readFile = vi.fn().mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValue(new Uint8Array([9]))
    const get = createFontProvider('C:\\res', readFile)
    expect(await get()).toBeNull()
    expect(await get()).toEqual(new Uint8Array([9]))
  })
})