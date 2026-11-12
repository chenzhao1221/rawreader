import { zhLangName } from './lmt'

/** Bump when the baseline prompt changes. Part of the cache key. */
export const BASELINE_PROMPT_VERSION = 'baseline-1'

/**
 * The WorkBuddy-verified smoke prompt: no context and no style rules. Kept as
 * a regression fallback (`translate.promptVariant: 'baseline'`, spike S6). It
 * is our own text, not ported from LMT.
 * `{src}` is empty because the source language is not known.
 */
export function buildBaselinePrompt(text: string, targetLang = 'zh-Hans', sourceLangName = ''): string {
  return `请将以下${sourceLangName}文本翻译为${zhLangName(targetLang)}，直接输出翻译结果，不要进行任何解释。\n\n${text}`
}
