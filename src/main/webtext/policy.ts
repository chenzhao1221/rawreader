/** Pure rules for the "translate this page?" bar. */

export interface WebTranslatePrefs {
  /** Languages translated without asking ("always translate English"). */
  alwaysLangs: readonly string[]
  /** Languages never offered ("never translate Korean"). */
  neverLangs: readonly string[]
  /** Hosts never offered ("never translate this site"). */
  neverSites: readonly string[]
}

export type PageDecision = 'auto' | 'offer' | 'none'

/** Primary language subtag, lower case: "en-US" -> "en", "zh_Hant" -> "zh". '' when unknown. */
export function baseLang(lang: string): string {
  const base = lang.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return /^[a-z]{2,3}$/.test(base) ? base : ''
}

/** What to do for a page in `lang` on `host`. Chinese pages and unknown languages get nothing. */
export function decide(prefs: WebTranslatePrefs, host: string, lang: string): PageDecision {
  const base = baseLang(lang)
  if (base === '' || base === 'zh') return 'none'
  if (host && prefs.neverSites.includes(host.toLowerCase())) return 'none'
  if (prefs.neverLangs.includes(base)) return 'none'
  if (prefs.alwaysLangs.includes(base)) return 'auto'
  return 'offer'
}

export type BarAction = 'always' | 'never-lang' | 'never-site'

/** Applies a bar choice to the prefs. Always and never for one language exclude each other. */
export function applyChoice(prefs: WebTranslatePrefs, action: BarAction, host: string, lang: string): WebTranslatePrefs {
  const base = baseLang(lang)
  const add = (list: readonly string[], value: string): string[] => (value && !list.includes(value) ? [...list, value] : [...list])
  const drop = (list: readonly string[], value: string): string[] => list.filter((x) => x !== value)
  switch (action) {
    case 'always':
      return { ...prefs, alwaysLangs: add(prefs.alwaysLangs, base), neverLangs: drop(prefs.neverLangs, base) }
    case 'never-lang':
      return { ...prefs, neverLangs: add(prefs.neverLangs, base), alwaysLangs: drop(prefs.alwaysLangs, base) }
    case 'never-site':
      return { ...prefs, neverSites: add(prefs.neverSites, host.toLowerCase()) }
  }
}

/** Page-text limits for one IPC call from the page side. */
export const WEBTEXT_LIMITS = { maxItems: 400, maxItemChars: 5000, maxTotalChars: 60_000 } as const
