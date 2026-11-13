// Portions ported from libre-manga-translator src/lib/canvas/text-fit.ts (calculateFittedTextLayout, wrapText)
// @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: text measurement is an injected function (no canvas context in the maths, so it is unit
// tested), wrapping is CJK aware (a break is allowed between any two hanzi; closing punctuation never starts a
// line and opening brackets never end one), the font-size loop stops at the minimum size instead of leaving the
// layout one step too small, and the loop checks the width as well as the height.

/** Width in CSS pixels of `text` at `fontSize`. Built on a canvas 2D context in the preload; fake in tests. */
export type MeasureFn = (text: string, fontSize: number) => number

export interface FittedTextLayout {
  fontSize: number
  lines: string[]
  lineH: number
  blockH: number
  pad: number
  maxW: number
  maxH: number
}

export interface FitOptions {
  /** Inner padding on every side. LMT uses 8. */
  pad?: number
  maxFontSize?: number
  minFontSize?: number
}

const DEFAULT_PAD = 8
const DEFAULT_MAX_FONT = 40
const DEFAULT_MIN_FONT = 4

/** LMT line height rule: tight below 6 px, 1.25 above. */
export function lineHeightFor(fontSize: number): number {
  return fontSize <= 6 ? fontSize * 1.1 : fontSize * 1.25
}

/** Characters that must not start a line (closing punctuation and marks). */
const NO_LINE_START = new Set('，。、；：！？）】》」』”’…—～·,.;:!?)]}%'.split(''))
/** Characters that must not end a line (opening brackets and quotes). */
const NO_LINE_END = new Set('（【《「『“‘([{'.split(''))

const LATIN_WORD = /[A-Za-z0-9\u00C0-\u024F'’_\-./@#&+%$]/

interface Token {
  text: string
  /** A single space preceded this token. */
  spaceBefore: boolean
  /** Latin word (kept whole when it fits) as opposed to a single CJK or symbol character. */
  word: boolean
}

function tokenize(paragraph: string): Token[] {
  const tokens: Token[] = []
  let spaceBefore = false
  let i = 0
  const chars = [...paragraph]
  while (i < chars.length) {
    const ch = chars[i] as string
    if (ch === ' ' || ch === '\t' || ch === '\u3000') {
      spaceBefore = true
      i++
      continue
    }
    if (LATIN_WORD.test(ch)) {
      let word = ch
      i++
      while (i < chars.length && LATIN_WORD.test(chars[i] as string)) {
        word += chars[i]
        i++
      }
      tokens.push({ text: word, spaceBefore, word: true })
    } else {
      tokens.push({ text: ch, spaceBefore, word: false })
      i++
    }
    spaceBefore = false
  }
  return tokens
}

/** Splits a paragraph into lines no wider than `maxW` according to `width`. */
function wrapParagraph(paragraph: string, maxW: number, width: (text: string) => number): string[] {
  const lines: string[] = []
  let line = ''

  const flush = (): void => {
    // Opening brackets stay with what follows them.
    let carry = ''
    while (line.length > 1 && NO_LINE_END.has(line.slice(-1))) {
      carry = line.slice(-1) + carry
      line = line.slice(0, -1)
    }
    if (line) lines.push(line)
    line = carry
  }

  for (const token of tokenize(paragraph)) {
    const joiner = line && token.spaceBefore && token.word ? ' ' : ''
    const candidate = line + joiner + token.text
    if (width(candidate) <= maxW) {
      line = candidate
      continue
    }

    if (token.word && width(token.text) > maxW) {
      // A word wider than the box: fill the current line, then break inside the word (LMT hyphenation).
      if (line) flush()
      let chunk = line
      line = ''
      for (const ch of token.text) {
        const prev = chunk.slice(-1)
        const needsHyphen = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(ch)
        const suffix = needsHyphen ? '-' : ''
        if (width(chunk + ch + suffix) > maxW && chunk) {
          lines.push(chunk + suffix)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      line = chunk
      continue
    }

    if (!token.word && NO_LINE_START.has(token.text) && line) {
      // Hang closing punctuation on the full line rather than starting a line with it.
      line = candidate
      continue
    }

    flush()
    line = line + token.text
  }
  if (line) lines.push(line)
  return lines
}

/** Closing punctuation may hang past the edge of a full line, so it is not counted when checking the width. */
function withoutHangingMarks(line: string): string {
  let end = line.length
  while (end > 1 && NO_LINE_START.has(line.charAt(end - 1))) end--
  return line.slice(0, end)
}

/** Wraps `text` (paragraphs split by newlines) to `maxW`. `width` measures a string at the size being tried. */
export function wrapText(text: string, maxW: number, width: (text: string) => number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const lines = wrapParagraph(paragraph, maxW, width)
    out.push(...(lines.length > 0 ? lines : ['']))
  }
  return out
}

/**
 * Finds the largest font size at which `text` fits a `width` x `height` box, and the wrapped lines at that
 * size. Sizes are in the units of the box (image pixels in the overlay; the caller scales to the display).
 */
export function calculateFittedTextLayout(
  text: string,
  width: number,
  height: number,
  measure: MeasureFn,
  options: FitOptions = {},
): FittedTextLayout {
  const pad = options.pad ?? DEFAULT_PAD
  const maxFont = options.maxFontSize ?? DEFAULT_MAX_FONT
  const minFont = options.minFontSize ?? DEFAULT_MIN_FONT
  const maxW = width - pad * 2
  const maxH = height - pad * 2

  if (maxW <= 0 || maxH <= 0 || !text) {
    const size = Math.max(minFont, 14)
    return { fontSize: size, lines: text ? [text] : [], lineH: size * 1.25, blockH: size * 1.25, pad, maxW, maxH }
  }

  let fontSize = Math.floor(Math.min(maxFont, maxH))
  fontSize = Math.max(fontSize, minFont)
  let lines: string[] = []
  for (; ; fontSize--) {
    const size = fontSize
    lines = wrapText(text, maxW, (s) => measure(s, size))
    const lineH = lineHeightFor(size)
    const fitsHeight = lines.length * lineH <= maxH
    const fitsWidth = lines.every((l) => measure(withoutHangingMarks(l), size) <= maxW + 0.5)
    if ((fitsHeight && fitsWidth) || size <= minFont) break
  }
  const lineH = lineHeightFor(fontSize)
  return { fontSize, lines, lineH, blockH: lines.length * lineH, pad, maxW, maxH }
}
