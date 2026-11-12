/** Product tokens a normal desktop Chrome user agent contains. Everything else is dropped. */
const KEEP_TOKENS = new Set(['Mozilla', 'AppleWebKit', 'Chrome', 'Safari', 'Version', 'Mobile'])

/**
 * Removes the `Electron/x.y.z` token and the app's own `name/version` token
 * from a user agent string, so sites see a plain Chrome. Parenthesised
 * platform comments are kept untouched.
 */
export function sanitizeUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\s+([A-Za-z][\w.-]*)\/[\w.+-]+/g, (match: string, name: string) =>
      KEEP_TOKENS.has(name) ? match : '',
    )
    .replace(/\s{2,}/g, ' ')
    .trim()
}
