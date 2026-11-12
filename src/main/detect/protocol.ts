import { z } from 'zod'

const Bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'expected bytes')

export const BboxSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  confidence: z.number(),
})

/** Main to utility process. */
export const DetectRequestSchema = z.discriminatedUnion('type', [
  z.object({ id: z.number().int(), type: z.literal('init'), modelPath: z.string().min(1) }),
  z.object({
    id: z.number().int(),
    type: z.literal('detect'),
    bytes: Bytes,
    /** Pixels added around each OCR crop. */
    ocrPadding: z.number().int().min(0).max(64),
    readingDirection: z.enum(['ltr', 'rtl']),
  }),
  z.object({ id: z.number().int(), type: z.literal('dispose') }),
])
export type DetectRequest = z.infer<typeof DetectRequestSchema>

export const WireUnitSchema = z.object({
  kind: z.enum(['bubble', 'free']),
  bubbleOnly: z.boolean(),
  drawBox: BboxSchema,
  ocrBox: BboxSchema,
  /** PNG crop of `ocrBox` plus padding, or null when the crop is empty. */
  ocrPng: Bytes.nullable(),
})
export type WireUnit = z.infer<typeof WireUnitSchema>

export const DetectOkSchema = z.object({
  width: z.number().int(),
  height: z.number().int(),
  tiled: z.boolean(),
  tileCount: z.number().int(),
  units: z.array(WireUnitSchema),
  timings: z.object({ decodeMs: z.number(), inferMs: z.number(), cropMs: z.number() }),
})
export type DetectOk = z.infer<typeof DetectOkSchema>

/** Utility process to main. */
export const DetectResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int(), ok: z.literal(true), result: DetectOkSchema.nullable() }),
  z.object({ id: z.number().int(), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])
export type DetectResponse = z.infer<typeof DetectResponseSchema>
