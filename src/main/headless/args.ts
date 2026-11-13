/**
 * Command-line flags for headless runs. A headless run never creates a window.
 *
 *   npm run smoke:detect-worker
 *   (= npm run build, then: npx electron . --headless-smoke=detect-worker)
 *   npm run smoke:overlay
 *   (= npm run build, then: npx electron . --headless-smoke=overlay; uses a HIDDEN window, never shown)
 *
 * Optional: `--smoke-out=<file>` overrides the JSON report location
 * (default `<repo>/.e2e-out/<kind>-smoke.json`).
 */

export const HEADLESS_SMOKE_KINDS = ['detect-worker', 'overlay'] as const
export type HeadlessSmokeKind = (typeof HEADLESS_SMOKE_KINDS)[number]

export interface HeadlessSmokeArgs {
  kind: HeadlessSmokeKind
  /** Report file chosen with `--smoke-out`, or null for the default. */
  outFile: string | null
}

const SMOKE_PREFIX = '--headless-smoke='
const OUT_PREFIX = '--smoke-out='

/** Parses `--headless-smoke=<kind>`; returns null when the flag is absent or the kind is unknown. */
export function parseHeadlessSmokeArgs(argv: readonly string[]): HeadlessSmokeArgs | null {
  let kind: string | null = null
  let outFile: string | null = null
  for (const arg of argv) {
    if (arg.startsWith(SMOKE_PREFIX)) kind = arg.slice(SMOKE_PREFIX.length)
    else if (arg.startsWith(OUT_PREFIX)) outFile = arg.slice(OUT_PREFIX.length) || null
  }
  if (kind === null) return null
  return (HEADLESS_SMOKE_KINDS as readonly string[]).includes(kind) ? { kind: kind as HeadlessSmokeKind, outFile } : null
}

/** True when the flag is present at all, even with an unknown kind (the app must then refuse to open a window). */
export function hasHeadlessSmokeFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.startsWith(SMOKE_PREFIX))
}
