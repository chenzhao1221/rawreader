import { createHash, timingSafeEqual } from 'node:crypto'

/** Crockford base32: no I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 16 characters of 5 bits each = 80 bits. */
export const PAIRING_CODE_LENGTH = 16
const PAIRING_CODE_BYTES = 10

/** Source of random bytes. Production passes `crypto.randomBytes`; tests pass a fixed sequence. */
export type RandomBytes = (size: number) => Uint8Array

/** Generates a pairing code (16 Crockford base32 characters, no separators) from injected random bytes. */
export function generatePairingCode(randomBytes: RandomBytes): string {
  const bytes = randomBytes(PAIRING_CODE_BYTES)
  if (bytes.length < PAIRING_CODE_BYTES) throw new Error('Not enough random bytes for a pairing code')
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < PAIRING_CODE_BYTES; i++) {
    value = (value << 8) | (bytes[i] as number)
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  return out
}

/** Shows a code in groups of four: `ABCD-EFGH-JKMN-PQRS`. */
export function formatPairingCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join('-')
}

/**
 * Brings user input to the canonical form: upper case, separators removed, and the Crockford look-alikes
 * (I, L -> 1; O -> 0) folded. Returns null when the result is not a well-formed code.
 */
export function normalizePairingCode(input: string): string | null {
  const folded = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (folded.length !== PAIRING_CODE_LENGTH) return null
  for (const char of folded) if (!ALPHABET.includes(char)) return null
  return folded
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

/**
 * Constant-time comparison. Both sides are hashed first so a length mismatch takes the same path and
 * `timingSafeEqual` always sees equal-length buffers.
 */
export function pairingCodesMatch(expected: string, provided: string): boolean {
  const a = digest(expected)
  const b = digest(provided)
  return timingSafeEqual(a, b) && expected.length === provided.length
}
