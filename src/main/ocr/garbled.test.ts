import { describe, expect, it } from 'vitest'
import { looksLikeFormula } from './garbled'

describe('looksLikeFormula', () => {
  it('spots LaTeX answers from the OCR model', () => {
    expect(looksLikeFormula('$\\frac{1}{a}$, $\\frac{1}{b}$...')).toBe(true)
    expect(looksLikeFormula('\\sqrt{2}')).toBe(true)
    expect(looksLikeFormula('x^{2}')).toBe(true)
  })

  it('leaves lettering alone, dollar amounts and smileys included', () => {
    expect(looksLikeFormula('흣, 으응...')).toBe(false)
    expect(looksLikeFormula('It costs $5, not $10!')).toBe(false)
    expect(looksLikeFormula('^_^ 좋아')).toBe(false)
    expect(looksLikeFormula('WHAT?!')).toBe(false)
  })
})
