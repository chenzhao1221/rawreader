import { describe, expect, it } from 'vitest'
import { PAIRING_CODE_LENGTH, formatPairingCode, generatePairingCode, normalizePairingCode, pairingCodesMatch } from './pairing'

const fixed = (bytes: number[]) => () => Uint8Array.from(bytes)

describe('generatePairingCode', () => {
  it('encodes 10 injected bytes as 16 Crockford base32 characters', () => {
    expect(generatePairingCode(fixed(new Array(10).fill(0)))).toBe('0'.repeat(16))
    expect(generatePairingCode(fixed(new Array(10).fill(255)))).toBe('Z'.repeat(16))
    const code = generatePairingCode(fixed([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    expect(code).toHaveLength(PAIRING_CODE_LENGTH)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/)
  })

  it('asks the injected source for 10 bytes and uses nothing else', () => {
    const sizes: number[] = []
    const a = generatePairingCode((size) => {
      sizes.push(size)
      return new Uint8Array(size).fill(7)
    })
    const b = generatePairingCode(fixed(new Array(10).fill(7)))
    expect(sizes).toEqual([10])
    expect(a).toBe(b)
    expect(generatePairingCode(fixed(new Array(10).fill(8)))).not.toBe(a)
  })

  it('rejects a source that returns too few bytes', () => {
    expect(() => generatePairingCode(fixed([1, 2, 3]))).toThrow()
  })
})

describe('formatPairingCode and normalizePairingCode', () => {
  it('groups by four and reads the grouped form back', () => {
    const code = 'ABCDEFGHJKMNPQRS'
    expect(formatPairingCode(code)).toBe('ABCD-EFGH-JKMN-PQRS')
    expect(normalizePairingCode('abcd-efgh jkmn-pqrs')).toBe(code)
  })

  it('folds look-alikes and rejects malformed input', () => {
    expect(normalizePairingCode('OIlO-0000-0000-0000')).toBe('0110000000000000')
    expect(normalizePairingCode('ABCD')).toBeNull()
    expect(normalizePairingCode('ABCD-EFGH-JKMN-PQRU')).toBeNull()
    expect(normalizePairingCode('')).toBeNull()
  })
})

describe('pairingCodesMatch', () => {
  it.each([
    ['ABCDEFGHJKMNPQRS', 'ABCDEFGHJKMNPQRS', true],
    ['ABCDEFGHJKMNPQRS', 'ABCDEFGHJKMNPQRT', false],
    ['ABCDEFGHJKMNPQRS', 'ABCDEFGHJKMNPQR', false],
    ['ABCDEFGHJKMNPQRS', '', false],
    ['ABCDEFGHJKMNPQRS', 'abcdefghjkmnpqrs', false],
  ])('%s vs %s -> %s', (expected, provided, result) => {
    expect(pairingCodesMatch(expected, provided)).toBe(result)
  })
})
