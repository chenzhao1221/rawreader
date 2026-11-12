// Portions ported from libre-manga-translator src/lib/ocr-text.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: none in behaviour; typed and reformatted.

/**
 * Cleans OCR text before it goes into a translation prompt.
 *
 * Comic lettering in Latin scripts is usually ALL CAPS and hyphenates words
 * across bubble lines ("RESIS- TIRME"). Small models tokenise ALL CAPS into
 * many short fragments and read a split word as two unknown words, which is how
 * a line ends up transliterated into made-up names. Only the prompt sees this
 * cleaned text; the OCR result shown to the user is left as read.
 */
const LATIN_LETTER = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF\u0100-\u017E\u0180-\u024F]/g

export function normalizeOcrForPrompt(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return text

  // Re-join words hyphenated across a line break: "RESIS- TIRME" -> "RESISTIRME".
  text = text.replace(/([A-Za-z\u00C0-\u00FF])[-\u2010\u2011]\s+([A-Za-z\u00C0-\u00FF])/g, '$1$2')

  // ALL CAPS Latin lettering -> sentence case.
  const letters = text.match(LATIN_LETTER) ?? []
  if (letters.length >= 4) {
    const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length
    if (upper / letters.length >= 0.8) {
      text = text
        .toLowerCase()
        .replace(/(^|[.!?\u2026]\s+|[\u00BF\u00A1]\s*)(\p{L})/gu, (_match, lead: string, ch: string) => lead + ch.toUpperCase())
    }
  }
  return text
}
