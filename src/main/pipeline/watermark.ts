/**
 * Scanlation groups stamp their site on pages ("TEMPLESCANESP.NET", "read at xyz.com"). A unit whose
 * OCR text contains a web address is dropped whole: not translated, not drawn, not used as context.
 */

/** Top-level domains seen on scan sites. Short ones that are common words ("to", "es", "me", "co") are left out. */
const TLDS = 'com|net|org|xyz|club|site|top|info|online|vip|biz|moe|cc|tv|io|gg|ru'

/** A label of 3+ letters/digits/hyphens, a dot, a TLD, as whole words. */
const DOMAIN = new RegExp(`\\b[a-z0-9][a-z0-9-]{2,}\\.(?:${TLDS})\\b`, 'i')

/** "esp.\nnet": a dot, a line break, then a TLD that ends the line. A plain space ("know. Net") is not joined. */
const SPLIT_TLD = new RegExp(`\\.[ \\t]*\\r?\\n\\s*(?=(?:${TLDS})\\s*$)`, 'gim')

/**
 * True when the text contains a web address. Vertical stamps come out of OCR split over lines
 * ("Te-\nmpl-\nes-\ncan-\nesp.\nnet", "Te- mpl- esc- ane- sp.n- et"), so a hyphen followed by
 * white space is joined first, and a dot followed by a line-final TLD is closed up. Other spaces
 * stay, so a sentence end ("know. Net income") does not glue into an address.
 */
export function looksLikeWatermark(text: string): boolean {
  const joined = text
    .normalize('NFKC')
    .replace(/[\u200b\u00ad]/g, '')
    .replace(/-\s+/g, '')
    .replace(SPLIT_TLD, '.')
  if (joined.trim().length === 0) return false
  if (/https?:\/\/|\bwww\./i.test(joined)) return true
  return DOMAIN.test(joined)
}
