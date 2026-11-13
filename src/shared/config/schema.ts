import { z } from 'zod'
import { TRANSLATOR_IDS } from '../models/translators'
import { THEMES } from '../theme'
import { findForbiddenExtraArgs } from './extra-args'

/** Detector boxes covering at least this share of the image area are discarded as whole-image false positives. */
export const DEFAULT_MAX_BOX_IMAGE_COVERAGE = 0.85

/**
 * Field-level schemas without defaults. The main schema adds defaults, the
 * patch schema reuses them as-is. Reusing a schema that has `.default()` inside
 * `.partial()` would inject defaults into patches, so the two are kept apart.
 */
const f = {
  port: z.number().int().min(1024).max(65535),
  ctxSize: z.number().int().positive(),
  nGpuLayers: z.number().int().min(0),
  parallel: z.number().int().min(1),
  flashAttn: z.enum(['on', 'off', 'auto']),
  alias: z.string().min(1),
  extraArgs: z
    .array(z.string())
    .refine((args) => findForbiddenExtraArgs(args).length === 0, {
      message: '--host and --port are managed by the app and cannot be set in extra args',
    }),
  autostart: z.boolean(),
  temp: z.number().min(0).max(2),
  reasoning: z.enum(['on', 'off']),
  backend: z.enum(['vulkan', 'cuda', 'custom']),
  path: z.string().min(1).nullable(),
  startupTimeoutMs: z.number().int().min(1000),
  concurrency: z.number().int().min(1).nullable(),
  minImageSize: z.number().int().min(1),
  readingDirection: z.enum(['ltr', 'rtl']),
  /** Ratio in (0, 1]. */
  maxBoxImageCoverage: z.number().gt(0).max(1),
  maxBytes: z.number().int().min(0),
  url: z.url(),
  bool: z.boolean(),
}

export const BackendSchema = f.backend
export type Backend = z.infer<typeof BackendSchema>

function serverShape(d: { port: number; ctxSize: number; alias: string; flashAttn: 'on' | 'off' | 'auto' }) {
  return {
    port: f.port.default(d.port),
    ctxSize: f.ctxSize.default(d.ctxSize),
    nGpuLayers: f.nGpuLayers.default(99),
    parallel: f.parallel.default(1),
    /**
     * `--cache-ram` in MiB: llama-server keeps old prompts in RAM to reuse them. Its own default is
     * 8192, which grew the translation server to ~10 GB, because every bubble is a new prompt.
     * 0 turns the cache off, -1 means no limit.
     */
    cacheRamMb: z.number().int().min(-1).default(256),
    // 'auto' omits the flag so llama-server picks its own default.
    flashAttn: f.flashAttn.default(d.flashAttn),
    alias: f.alias.default(d.alias),
    extraArgs: f.extraArgs.default([]),
    autostart: f.autostart.default(true),
  }
}

export const OcrServerSchema = z.object(
  serverShape({ port: 18791, ctxSize: 4096, alias: 'PaddleOCR-VL-1.5', flashAttn: 'auto' }),
)

export const TranslateServerSchema = z.object({
  ...serverShape({ port: 18792, ctxSize: 8192, alias: 'Index-Translate-2B', flashAttn: 'on' }),
  temp: f.temp.default(0),
  reasoning: f.reasoning.default('off'),
})

export type OcrServerConfig = z.infer<typeof OcrServerSchema>
export type TranslateServerConfig = z.infer<typeof TranslateServerSchema>

/** Fields shared by both roles. Used by code that handles either role. */
export type ServerConfig = OcrServerConfig | TranslateServerConfig

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ui: z
    .object({
      autoTranslate: f.bool.default(false),
      overlayVisible: f.bool.default(true),
      /** Skip free-text units: no OCR, no translation, no overlay for them. Detection and the cache still keep them. */
      bubblesOnly: f.bool.default(false),
      /** Ad and tracker blocking in the browse session (Ghostery engine). */
      adBlock: f.bool.default(true),
      /** Colour theme of the shell: night (dark), paper (light) or follow Windows. */
      theme: z.enum(THEMES).default('night'),
      lastUrl: z.string().nullable().default(null),
      /** Tabs open at the last exit, reopened on start; main-process only. */
      openTabs: z
        .object({ urls: z.array(z.string()).max(100).default([]), active: z.number().int().min(0).default(0) })
        .prefault({}),
      /** Choices made on the Google translate bar; main-process only. */
      webTranslate: z
        .object({
          alwaysLangs: z.array(z.string().max(8)).max(200).default([]),
          neverLangs: z.array(z.string().max(8)).max(200).default([]),
          neverSites: z.array(z.string().max(253)).max(2000).default([]),
        })
        .prefault({}),
      /** The "still running in the tray" balloon was shown once; main-process only. */
      trayHintShown: f.bool.default(false),
      /** The first-run wizard was finished or skipped; it does not open on later starts. */
      setupDone: f.bool.default(false),
    })
    .prefault({}),
  llama: z
    .object({
      build: z.string().default('b12318'),
      backend: f.backend.default('vulkan'),
      binDirs: z
        .object({
          vulkan: f.path.default(null), // null = <resources>/llama/vulkan
          cuda: f.path.default(null), // null = <userData>/llama/cuda-<build>
          custom: f.path.default(null),
        })
        .prefault({}),
      startupTimeoutMs: f.startupTimeoutMs.default(120_000),
      ocr: OcrServerSchema.prefault({}),
      translate: TranslateServerSchema.prefault({}),
    })
    .prefault({}),
  models: z
    .object({
      dir: f.path.default(null), // null = <userData>/models
      paths: z
        .object({
          detector: f.path.default(null), // null = bundled copy
          ocr: f.path.default(null),
          ocrMmproj: f.path.default(null),
          translator: f.path.default(null),
        })
        .prefault({}),
      autoDownload: f.bool.default(true),
      /** Which local translation model the translation server runs (see shared/models/translators.ts). */
      translator: z.enum(TRANSLATOR_IDS).default('index-2b'),
      /** Files the user picked for the other translation models (`paths.translator` is the default model's). */
      translatorPaths: z.partialRecord(z.enum(TRANSLATOR_IDS), f.path).default({}),
      mirrors: z
        .object({
          huggingface: f.url.default('https://hf-mirror.com'),
          modelscope: f.url.default('https://modelscope.cn'),
        })
        .prefault({}),
    })
    .prefault({}),
  pipeline: z
    .object({
      detectConcurrency: z.literal(1).default(1),
      ocrConcurrency: f.concurrency.default(null), // null = llama.ocr.parallel
      translateConcurrency: f.concurrency.default(null), // null = llama.translate.parallel
      minImageSize: f.minImageSize.default(200),
      /** How far below and above the viewport images start translating, in CSS pixels (settings: off / near / far). */
      rootMarginPx: z.number().int().min(0).max(20_000).default(1000),
      maxImageBytes: z.number().int().positive().default(50 * 1024 * 1024),
      readingDirection: f.readingDirection.default('ltr'),
      maxBoxImageCoverage: f.maxBoxImageCoverage.default(DEFAULT_MAX_BOX_IMAGE_COVERAGE),
    })
    .prefault({}),
  translate: z
    .object({
      targetLang: z.literal('zh-Hans').default('zh-Hans'),
      promptVariant: z.enum(['lmt', 'baseline']).default('lmt'),
      contextUnits: z.number().int().min(0).default(3),
      /** Translate all bubbles of an image in one numbered request (falls back per bubble). */
      batch: f.bool.default(true),
      /**
       * Who reads and translates: local llama servers, an OpenAI-compatible API for translation
       * (OCR stays local), or Gemini for both (no local model at all).
       */
      engine: z.enum(['local', 'openai', 'gemini']).default('local'),
      /** OpenAI-compatible endpoint (DeepSeek, OpenRouter, a local LM Studio ...). The key lives in secrets. */
      api: z
        .object({
          baseUrl: z.string().max(500).default('https://api.deepseek.com/v1'),
          model: z.string().min(1).max(200).default('deepseek-chat'),
        })
        .prefault({}),
      gemini: z.object({ model: z.string().min(1).max(200).default('gemini-2.5-flash') }).prefault({}),
    })
    .prefault({}),
  cache: z.object({ maxBytes: f.maxBytes.default(2 * 1024 ** 3) }).prefault({}),
})

export type Config = z.infer<typeof ConfigSchema>

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** Whitelisted, user-editable subset of the config accepted over IPC. Unknown keys are rejected. */
const serverPatchShape = {
  port: f.port,
  ctxSize: f.ctxSize,
  nGpuLayers: f.nGpuLayers,
  parallel: f.parallel,
  flashAttn: f.flashAttn,
  alias: f.alias,
  extraArgs: f.extraArgs,
  autostart: f.autostart,
}

export const ConfigPatchSchema = z
  .strictObject({
    ui: z.strictObject({ autoTranslate: f.bool, overlayVisible: f.bool, bubblesOnly: f.bool, adBlock: f.bool, setupDone: f.bool, theme: z.enum(THEMES) }).partial(),
    llama: z
      .strictObject({
        backend: f.backend,
        binDirs: z.strictObject({ vulkan: f.path, cuda: f.path, custom: f.path }).partial(),
        startupTimeoutMs: f.startupTimeoutMs,
        ocr: z.strictObject(serverPatchShape).partial(),
        translate: z
          .strictObject({ ...serverPatchShape, temp: f.temp, reasoning: f.reasoning })
          .partial(),
      })
      .partial(),
    models: z
      .strictObject({
        dir: f.path,
        paths: z
          .strictObject({ detector: f.path, ocr: f.path, ocrMmproj: f.path, translator: f.path })
          .partial(),
        mirrors: z.strictObject({ huggingface: f.url, modelscope: f.url }).partial(),
        translator: z.enum(TRANSLATOR_IDS),
        translatorPaths: z.partialRecord(z.enum(TRANSLATOR_IDS), f.path),
      })
      .partial(),
    pipeline: z
      .strictObject({
        ocrConcurrency: f.concurrency,
        translateConcurrency: f.concurrency,
        readingDirection: f.readingDirection,
        rootMarginPx: z.number().int().min(0).max(20_000),
        maxBoxImageCoverage: f.maxBoxImageCoverage,
      })
      .partial(),
    translate: z
      .strictObject({
        engine: z.enum(['local', 'openai', 'gemini']),
        batch: f.bool,
        api: z
          .strictObject({
            baseUrl: z
              .string()
              .max(500)
              .refine(isAllowedApiBase, { message: 'Use https://, or http:// to this computer only' }),
            model: z.string().min(1).max(200),
          })
          .partial(),
        gemini: z.strictObject({ model: z.string().min(1).max(200).regex(/^[\w.-]+$/) }).partial(),
      })
      .partial(),
    cache: z.strictObject({ maxBytes: f.maxBytes }).partial(),
  })
  .partial()

/** API base URLs: https anywhere, plain http only to this computer (LM Studio, Ollama). */
export function isAllowedApiBase(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

export type ConfigPatch = z.infer<typeof ConfigPatchSchema>
