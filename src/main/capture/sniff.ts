// Portions ported from libre-manga-translator src/lib/utils.ts (`sniffMime`) @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: unknown content returns `null` instead of defaulting to JPEG (R4.4),
// AVIF needs an `avif`/`avis` brand, and the header bytes are bounds-checked.

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif'

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0)
  return out
}

/** Identifies JPEG, PNG, WebP, GIF and AVIF from the first bytes. Returns `null` for anything else. */
export function sniffMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp'
  if (ascii(bytes, 0, 3) === 'GIF') return 'image/gif'
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  return null
}
