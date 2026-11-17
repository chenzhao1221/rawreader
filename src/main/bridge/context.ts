import { createHash } from 'node:crypto'
import type { TranslateContext } from '../pipeline/types'
import { buildSeriesBackground, truncateUtf8 } from '../translate/prompts'

/** Series context as the extension sends it (LMT's `SeriesContext` subset the prompt uses). */
export interface BridgeContext {
  seriesName?: string | undefined
  summary?: string | undefined
  dictionary?: string | undefined
}

/** UTF-8 byte caps, the same numbers as LMT's `SERIES_CONTEXT_LIMITS` (the name cap is ours). */
export const BRIDGE_CONTEXT_LIMITS = { seriesNameBytes: 200, summaryBytes: 2000, dictionaryBytes: 2000 } as const

/**
 * Caps the context and turns it into prompt lines plus a stable hash for the cache identity. Returns
 * `undefined` when nothing is left, so an empty context behaves exactly like no context (and shares the
 * desktop's cache entries).
 */
export function normalizeContext(raw: BridgeContext | undefined): TranslateContext | undefined {
  if (!raw) return undefined
  const capped = {
    seriesName: truncateUtf8((raw.seriesName ?? '').trim(), BRIDGE_CONTEXT_LIMITS.seriesNameBytes),
    summary: truncateUtf8((raw.summary ?? '').trim(), BRIDGE_CONTEXT_LIMITS.summaryBytes),
    dictionary: truncateUtf8((raw.dictionary ?? '').trim(), BRIDGE_CONTEXT_LIMITS.dictionaryBytes),
  }
  const background = buildSeriesBackground(capped)
  if (background.length === 0) return undefined
  const hash = createHash('sha256').update(JSON.stringify(capped), 'utf8').digest('hex').slice(0, 16)
  return { background, hash }
}
