// Portions ported from libre-manga-translator src/lib/series-context.ts (`utf8ByteLength`, `truncateUtf8`)
// @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: only the byte-length helpers are ported. Series context (names, summaries) is phase 2.
// `CONTEXT_LIMITS` is ours.

/** Limits for the in-page context sent with each bubble (previous bubbles of the same image). */
export const CONTEXT_LIMITS = {
  /** Bytes (UTF-8) kept per previous bubble. */
  unitBytes: 240,
  /** Bytes (UTF-8) kept for all previous bubbles together. */
  totalBytes: 720,
} as const

/** UTF-8 byte length of one code point (surrogates count as 3, matching `TextEncoder`). */
function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

/** UTF-8 byte length of a string, without allocating an encoder buffer. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    bytes += utf8Length(char.codePointAt(0) as number)
  }
  return bytes
}

/**
 * Truncates to at most `maxBytes` UTF-8 bytes. Iterates code points, so a
 * surrogate pair (emoji, rare CJK) is kept or dropped whole, never split.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (!text || maxBytes <= 0) return ''
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = utf8Length(char.codePointAt(0) as number)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return end >= text.length ? text : text.slice(0, end)
}
