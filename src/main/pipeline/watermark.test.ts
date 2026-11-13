import { describe, expect, it } from 'vitest'
import { looksLikeWatermark } from './watermark'

describe('looksLikeWatermark', () => {
  describe('detects scan-site stamps', () => {
    it('recognizes a bare domain', () => {
      expect(looksLikeWatermark('TEMPLESCANESP.NET')).toBe(true)
    })

    it('joins a vertical stamp OCR split over lines', () => {
      expect(looksLikeWatermark('Te-\nmpl-\nes-\ncan-\nesp.\nnet')).toBe(true)
    })

    it('joins a vertical stamp split by hyphens and spaces', () => {
      expect(looksLikeWatermark('Te- mpl- esc- ane- sp.n- et')).toBe(true)
    })

    it('finds an address in the middle of a sentence', () => {
      expect(looksLikeWatermark('ESCRIBE EN TU NAVEGADOR TEMPLESCANESP.NET PARA LEER')).toBe(true)
    })

    it('recognizes http and www addresses', () => {
      expect(looksLikeWatermark('https://example.org/a')).toBe(true)
      expect(looksLikeWatermark('www.mangaread')).toBe(true)
    })

    it('normalizes a full-width dot', () => {
      expect(looksLikeWatermark('templescanesp．net')).toBe(true)
    })

    it('recognizes a domain after other words', () => {
      expect(looksLikeWatermark('Read at manga18.club')).toBe(true)
      expect(looksLikeWatermark('toonily.com')).toBe(true)
    })
  })

  describe('leaves dialogue alone', () => {
    it('ignores empty and blank text', () => {
      expect(looksLikeWatermark('')).toBe(false)
      expect(looksLikeWatermark('   ')).toBe(false)
    })

    it('ignores Korean', () => {
      expect(looksLikeWatermark('오늘부터 1일')).toBe(false)
    })

    it('ignores words after a sentence-ending period', () => {
      expect(looksLikeWatermark("I don't know. Net income is low")).toBe(false)
      expect(looksLikeWatermark("I don't know. Net")).toBe(false)
    })

    it('ignores a sentence with ellipses and an exclamation mark', () => {
      expect(looksLikeWatermark('Wait... come on!')).toBe(false)
    })

    it('ignores "ok" because it is not a top-level domain', () => {
      expect(looksLikeWatermark('Hm.ok')).toBe(false)
    })

    it('ignores a comma-joined phrase', () => {
      expect(looksLikeWatermark('pero,es verdad')).toBe(false)
    })

    it('ignores a label shorter than three characters', () => {
      expect(looksLikeWatermark('ab.com')).toBe(false)
    })
  })
})
