/**
 * Which package this is, set at build time (electron.vite.config.ts, from RAWREADER_FLAVOR):
 * - "full": the default local models ship inside the package; local engine by default.
 * - "lite": no model files; the setup wizard suggests Gemini first. Every engine stays available.
 * Tests and builds without the define count as "full".
 */
declare const __RAWREADER_FLAVOR__: string | undefined

export type Flavor = 'full' | 'lite'

export const FLAVOR: Flavor = typeof __RAWREADER_FLAVOR__ !== 'undefined' && __RAWREADER_FLAVOR__ === 'lite' ? 'lite' : 'full'
