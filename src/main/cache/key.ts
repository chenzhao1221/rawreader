import type { Config } from '../../shared/config/schema'
import { MODEL_FILE_NAMES } from '../config/model-path'
import type { ModelPathResult, ModelRole } from '../config/model-path'
import { promptVersionFor } from '../translate/prompts'

/** Everything that decides whether a stored result is still valid for the current setup. */
export interface CacheIdentity {
  lang: string
  detectorId: string
  ocrModelId: string
  mtModelId: string
  promptVersion: string
}

/**
 * Key of one cached image: `sha256(content) | lang | detectorId | ocrModelId | mtModelId | promptVersion`
 * (design section 12), plus `|ctx:<hash>` when a series context was sent. A change in any part is a different key, so old results are never served after the
 * models or the prompt change. The separator is not allowed inside any part.
 */
export function buildCacheKey(contentHash: string, identity: CacheIdentity, contextHash?: string): string {
  const parts = [
    contentHash,
    identity.lang,
    identity.detectorId,
    identity.ocrModelId,
    identity.mtModelId,
    identity.promptVersion,
    // Only requests with series context get this part, so plain requests keep sharing the desktop's entries.
    ...(contextHash ? [`ctx:${contextHash}`] : []),
  ]
  return parts.map((part) => part.replaceAll('|', '/')).join('|')
}

/** `<file name>:<size>` of a model file, or `<file name>:missing` when it cannot be found. */
export function modelFileId(role: ModelRole, path: ModelPathResult, sizeOf: (path: string) => number | null): string {
  if (typeof path !== 'string') return `${MODEL_FILE_NAMES[role]}:missing`
  const size = sizeOf(path)
  const name = path.split(/[\\/]/).pop() ?? MODEL_FILE_NAMES[role]
  return `${name}:${size ?? 'unknown'}`
}

/** The part of the prompt setup that changes translations (prompt version, context length, reading order). */
export function promptIdentity(config: Config): string {
  const { promptVariant, contextUnits, batch } = config.translate
  return `${promptVersionFor(promptVariant)}+ctx${contextUnits}${batch && promptVariant === 'lmt' ? '+batch' : ''}+${config.pipeline.readingDirection}+cov${config.pipeline.maxBoxImageCoverage}`
}

export function buildCacheIdentity(
  config: Config,
  paths: Record<'detector' | 'ocr' | 'translator', ModelPathResult>,
  sizeOf: (path: string) => number | null,
): CacheIdentity {
  return {
    lang: config.translate.targetLang,
    detectorId: modelFileId('detector', paths.detector, sizeOf),
    ocrModelId: modelFileId('ocr', paths.ocr, sizeOf),
    mtModelId: modelFileId('translator', paths.translator, sizeOf),
    promptVersion: promptIdentity(config),
  }
}