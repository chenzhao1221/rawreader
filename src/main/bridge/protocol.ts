import { z } from 'zod'
import type { TranslateBytesResult } from '../pipeline/scheduler'

/** Protocol version carried in every request and response. */
export const BRIDGE_PROTOCOL_VERSION = 1

/** Stable error codes (design 4.2). Stage failures use the pipeline's own code under 502. */
export const BridgeErrorCodes = [
  'bad-request',
  'unauthorized',
  'forbidden-origin',
  'forbidden-host',
  'unknown-extension',
  'not-found',
  'too-large',
  'unsupported-image',
  'rate-limited',
  'internal',
] as const

export interface BridgeError {
  code: string
  message: string
}

const finite = z.number().refine(Number.isFinite, 'must be finite')

/** A region in natural image pixels. */
export const BridgeBoxSchema = z
  .strictObject({ x1: finite, y1: finite, x2: finite, y2: finite, confidence: z.number().min(0).max(1).default(1) })
  .refine((b) => b.x2 > b.x1 && b.y2 > b.y1, 'box must have a positive size')

export const BridgeContextSchema = z.strictObject({
  seriesName: z.string().max(1000).optional(),
  summary: z.string().max(10_000).optional(),
  dictionary: z.string().max(10_000).optional(),
})

/** Most boxes one request may carry; the pipeline caps units per image the same way. */
export const MAX_REQUEST_BOXES = 60

export const TranslateRequestSchema = z.strictObject({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  /** Base64 of the image file bytes. */
  image: z.string().min(8),
  priority: z.number().min(-1_000_000).max(1_000_000).optional(),
  context: BridgeContextSchema.optional(),
  boxes: z.array(BridgeBoxSchema).min(1).max(MAX_REQUEST_BOXES).optional(),
})
export type TranslateRequest = z.infer<typeof TranslateRequestSchema>

const BoxOut = z.strictObject({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), confidence: z.number() })

export const TranslateResponseSchema = z.strictObject({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  hash: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  cached: z.boolean(),
  units: z.array(
    z.strictObject({
      kind: z.enum(['bubble', 'free']),
      bubbleOnly: z.boolean(),
      drawBox: BoxOut,
      ocrBox: BoxOut,
      ocrText: z.string(),
      translation: z.string(),
      status: z.enum(['ok', 'no-text', 'ocr-failed', 'translate-failed', 'echo', 'skipped', 'watermark']),
    }),
  ),
  timings: z.strictObject({ detectMs: z.number(), ocrMs: z.number(), translateMs: z.number() }),
})
export type TranslateResponse = z.infer<typeof TranslateResponseSchema>

export const PingResponseSchema = z.strictObject({
  v: z.literal(BRIDGE_PROTOCOL_VERSION),
  app: z.string(),
  version: z.string(),
  ready: z.boolean(),
  engine: z.enum(['local', 'openai', 'gemini']),
  reason: z.strictObject({ code: z.string(), message: z.string() }).optional(),
})
export type PingResponse = z.infer<typeof PingResponseSchema>

const box = (b: { x1: number; y1: number; x2: number; y2: number; confidence: number }) => ({
  x1: b.x1,
  y1: b.y1,
  x2: b.x2,
  y2: b.y2,
  confidence: b.confidence,
})

/** Pipeline result to wire response. Copies named fields only, so no image bytes or capture details can leak. */
export function toBridgeResult(result: TranslateBytesResult): TranslateResponse {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    hash: result.hash,
    width: result.width,
    height: result.height,
    cached: result.cached,
    units: result.units.map((unit) => ({
      kind: unit.kind,
      bubbleOnly: unit.bubbleOnly,
      drawBox: box(unit.drawBox),
      ocrBox: box(unit.ocrBox),
      ocrText: unit.ocrText,
      translation: unit.translation,
      status: unit.status,
    })),
    timings: {
      detectMs: Math.round(result.timings.detectMs),
      ocrMs: Math.round(result.timings.ocrMs),
      translateMs: Math.round(result.timings.translateMs),
    },
  }
}
