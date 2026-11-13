import { LLAMA_HOST } from '../../shared/constants'
import { findForbiddenExtraArgs } from '../../shared/config/extra-args'
import type { OcrServerConfig, TranslateServerConfig } from '../../shared/config/schema'

/*
 * llama-server is used through POST /v1/chat/completions and GET /health only.
 * Never /completion: it echoes the source text for Index-Translate-2B.
 * Servers always bind to 127.0.0.1.
 */

export interface OcrPaths {
  /** Main OCR model (GGUF). */
  ocr: string
  /** Vision projector for the OCR model (`--mmproj`). */
  ocrMmproj: string
}

export interface TranslatePaths {
  translator: string
}

function assertSafeExtraArgs(extraArgs: readonly string[]): void {
  const forbidden = findForbiddenExtraArgs(extraArgs)
  if (forbidden.length > 0) {
    throw new Error(`extraArgs must not contain ${forbidden.join(', ')}`)
  }
}

function flashAttnArgs(value: 'on' | 'off' | 'auto'): string[] {
  // 'auto' omits the flag so llama-server uses its own default.
  return value === 'auto' ? [] : ['--flash-attn', value]
}

/**
 * OCR server (PaddleOCR-VL-1.5). Defaults reproduce the WorkBuddy launch:
 * `-m <ocr> --mmproj <mmproj> --host 127.0.0.1 --port 18791 --ctx-size 4096 -np 1 -ngl 99`.
 * `port` is the effective port, which may differ from `cfg.port` after a free-port fallback.
 */
export function buildOcrArgs(cfg: OcrServerConfig, paths: OcrPaths, port: number = cfg.port): string[] {
  assertSafeExtraArgs(cfg.extraArgs)
  return [
    '-m', paths.ocr,
    '--mmproj', paths.ocrMmproj,
    '--host', LLAMA_HOST,
    '--port', String(port),
    '--ctx-size', String(cfg.ctxSize),
    '-np', String(cfg.parallel),
    '-ngl', String(cfg.nGpuLayers),
    '--cache-ram', String(cfg.cacheRamMb),
    ...flashAttnArgs(cfg.flashAttn),
    '--alias', cfg.alias,
    ...cfg.extraArgs,
  ]
}

/**
 * Translation server (Index-Translate-2B). Defaults reproduce the WorkBuddy launch:
 * `-m <model> --host 127.0.0.1 --port 18792 --temp 0 -ngl 99 --ctx-size 8192 -np 1
 *  --flash-attn on --reasoning off --alias Index-Translate-2B`.
 */
export function buildTranslateArgs(
  cfg: TranslateServerConfig,
  paths: TranslatePaths,
  port: number = cfg.port,
): string[] {
  assertSafeExtraArgs(cfg.extraArgs)
  return [
    '-m', paths.translator,
    '--host', LLAMA_HOST,
    '--port', String(port),
    '--temp', String(cfg.temp),
    '-ngl', String(cfg.nGpuLayers),
    '--ctx-size', String(cfg.ctxSize),
    '-np', String(cfg.parallel),
    '--cache-ram', String(cfg.cacheRamMb),
    ...flashAttnArgs(cfg.flashAttn),
    '--reasoning', cfg.reasoning,
    '--alias', cfg.alias,
    ...cfg.extraArgs,
  ]
}
