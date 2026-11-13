// Portions ported from libre-manga-translator src/lib/webllm.ts (prompt-only functions: `zhLangName`,
// `stripThinking`, `buildMtBackground`, `buildMtPrompt` Index branch, `looksLikePromptEcho`,
// `buildBareMtPrompt`, and the token cap in `runPlainChat`) @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: only the Index-Translate branch is ported (no Hy-MT). Background context is the
// source text of previous bubbles on the same image (series name, dictionary and previous page are
// phase 2). The context rule line in `buildIndexPrompt` is ours and uses LMT's constrained prompt layout.
// `ZH_STYLE_RULES` is condensed from LMT src/lib/prompts.ts (style rules for Chinese output).
// The engine code (WebLLM, ensureEngine, runPlainChat) is not ported; HTTP lives in translate/client.ts.

import { CONTEXT_LIMITS, truncateUtf8, utf8ByteLength } from './limits'

/** Bump when any prompt text below changes. Part of the cache key (design section 12). */
export const LMT_PROMPT_VERSION = 'lmt-2'

/**
 * Style constraints for Chinese output, condensed from LMT `src/lib/prompts.ts` ("STYLE RULES FOR CHINESE OUTPUT"):
 * small models default to stiff, literal translation without them. They go into the constraint list of the Index prompt.
 */
export const ZH_STYLE_RULES: readonly string[] = [
  '用自然、口语化的中文，读起来像正规汉化组的译文，不要翻译腔。',
  '按人物关系翻译敬语和称呼；网络流行语和俚语按意思翻译，不要按字面直译。',
  '保留骂人、吐槽、惊叹的语气强弱；拟声词译成中文拟声词。',
  '原文来自 OCR，可能有错字或断词；先按上下文猜出原句再翻译，不要把读不通的字母音译成人名。',
]

function isChineseTarget(lang: string): boolean {
  return /^zh|chinese/i.test(lang)
}

const ZH_LANG_NAMES: Record<string, string> = {
  'zh-Hans': '简体中文',
  'Chinese (Simplified)': '简体中文',
  'Chinese (Traditional)': '繁体中文',
  English: '英语',
  Japanese: '日语',
  Korean: '韩语',
  Spanish: '西班牙语',
  French: '法语',
  German: '德语',
  Portuguese: '葡萄牙语',
  Russian: '俄语',
  Italian: '意大利语',
  Vietnamese: '越南语',
  Thai: '泰语',
  Indonesian: '印尼语',
}

export function zhLangName(lang: string | null | undefined): string {
  if (!lang) return ''
  return ZH_LANG_NAMES[lang] ?? lang
}

/** Removes `<think>` blocks: keeps what follows the last `</think>` and drops a dangling opening tag. */
export function stripThinking(text: string): string {
  let out = text
  if (out.includes('</think>')) out = out.split('</think>').pop() ?? out
  return out.replace(/^<think>/, '').trim()
}

/**
 * Selects the background for bubble `index`: the source text of up to
 * `maxUnits` earlier bubbles on the same image, empty ones skipped, each and
 * all of them capped in UTF-8 bytes. Source text only, so bubbles can be
 * translated in parallel and results stay deterministic for caching.
 */
export function buildContext(sources: readonly string[], index: number, maxUnits: number): string[] {
  if (maxUnits <= 0) return []
  const picked: string[] = []
  let total = 0
  for (let i = index - 1; i >= 0 && picked.length < maxUnits; i--) {
    const text = (sources[i] ?? '').trim()
    if (text.length === 0) continue
    const clipped = truncateUtf8(text, CONTEXT_LIMITS.unitBytes)
    const size = utf8ByteLength(clipped)
    if (total + size > CONTEXT_LIMITS.totalBytes) break
    total += size
    picked.unshift(clipped)
  }
  return picked
}

/**
 * Index-Translate prompt (model card format, as ported by LMT).
 *
 * Without context this is the card's standard prompt. With context it uses
 * LMT's constrained layout (source block plus a numbered constraint list). LMT
 * notes that the 2B model sometimes echoes the constraint block back; the echo
 * guard below catches that and the caller retries with the bare prompt.
 */
export function buildIndexPrompt(text: string, targetLang: string, context: readonly string[] = []): string {
  const tgt = zhLangName(targetLang)
  const rules = [...(isChineseTarget(targetLang) ? ZH_STYLE_RULES : [])]
  if (context.length > 0) {
    rules.push(`【参考前文】同一页前面的对白，仅供理解语气和指代，不要翻译，不要输出: ${context.join(' / ')}`)
  }
  if (rules.length === 0) {
    return `请将以下文本翻译为${tgt}，直接输出翻译结果，不要进行任何解释。\n\n${text}`
  }
  const numbered = rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')
  return `请将以下漫画对白翻译成${tgt}，并且严格遵循所有约束要求。\n【源文】\n${text}\n【约束要求】\n${numbered}\n只输出译文，不要有任何额外说明。`
}

/** Plain prompt with no context, used as the retry after an echo. */
export function buildBareMtPrompt(text: string, targetLang: string): string {
  return `请将以下文本翻译为${zhLangName(targetLang)}，直接输出翻译结果，不要进行任何解释。\n\n${text}`
}

/**
 * Small MT models sometimes echo the prompt scaffolding (or run on until
 * max_tokens) instead of translating. Such output must never reach a bubble.
 */
export function looksLikePromptEcho(output: string, source: string): boolean {
  if (/【(约束要求|注意|硬性要求|背景信息|待翻译文本|源文|参考前文)】/.test(output)) return true
  if (/请将以下|只输出译文|直接输出翻译结果|不要进行任何解释/.test(output)) return true
  return output.length > source.length * 4 + 60
}

/** `min(256, max(48, sourceLength * 3))`: a tight cap bounds the damage when the model never emits its stop token. */
export function maxTokensFor(sourceLength: number): number {
  return Math.min(256, Math.max(48, sourceLength * 3))
}
