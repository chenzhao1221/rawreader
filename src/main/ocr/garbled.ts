/**
 * PaddleOCR-VL was trained on documents with formulas. On odd hand lettering ("흣, 으응…") it sometimes
 * answers with LaTeX ("$\frac{1}{a}$, $\frac{1}{b}$…"). The original text is lost in such an answer,
 * so it is never translated: the crop is read again larger, and dropped if it is still a formula.
 */

/** LaTeX commands seen in such answers, plus math-mode dollars around a short expression. */
const LATEX = /\\(?:frac|dfrac|sqrt|sum|int|cdot|times|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega|left|right|mathrm|mathbf|text|overline|hat|vec|ldots|cdots|leq|geq|neq|infty)\b|\$[^$\n]{0,40}[\\{}^_][^$\n]{0,40}\$|[\^_]\{[^}]*\}/

/** True when OCR text looks like a formula rather than lettering. Exported for tests. */
export function looksLikeFormula(text: string): boolean {
  return LATEX.test(text)
}

/** Factor the crop is enlarged by for the second reading. */
export const RETRY_SCALE = 2
