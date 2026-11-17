import { BASELINE_PROMPT_VERSION, buildBaselinePrompt } from './baseline'
import { LMT_PROMPT_VERSION } from './lmt'

export { BASELINE_PROMPT_VERSION, buildBaselinePrompt } from './baseline'
export { CONTEXT_LIMITS, truncateUtf8, utf8ByteLength } from './limits'
export {
  LMT_PROMPT_VERSION,
  ZH_STYLE_RULES,
  buildBareMtPrompt,
  buildBatchPrompt,
  buildContext,
  buildIndexPrompt,
  buildSeriesBackground,
  looksLikePromptEcho,
  maxTokensFor,
  maxTokensForBatch,
  parseBatchOutput,
  BATCH_MAX_ITEMS,
  stripThinking,
  zhLangName,
} from './lmt'
export { normalizeOcrForPrompt } from './ocr-text'

export type PromptVariant = 'lmt' | 'baseline'

/** The value that goes into the cache key for a prompt variant. */
export function promptVersionFor(variant: PromptVariant): string {
  return variant === 'baseline' ? BASELINE_PROMPT_VERSION : LMT_PROMPT_VERSION
}
