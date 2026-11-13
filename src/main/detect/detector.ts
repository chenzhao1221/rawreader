// Portions ported from libre-manga-translator src/lib/detections/rtdetr.ts (`runRtDetrSingle`,
// `runRtDetrDetection` control flow) @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: onnxruntime-web + OffscreenCanvas replaced by onnxruntime-node (CPU EP) + sharp;
// bubble-only boxes are kept (see rtdetr.ts); the result also carries OCR crops.

import { performance } from 'node:perf_hooks'
import * as ortNamespace from 'onnxruntime-node'
import sharp from 'sharp'
import { DEFAULT_MAX_BOX_IMAGE_COVERAGE, dropOversizedBoxes } from './coverage'
import { cropRaw, paddedRect } from './raw'
import type { PixelRect } from './raw'
import { DEFAULT_MIN_CONFIDENCE, INPUT_SIZE, LETTERBOX_FILL, decodeRtDetrOutputs, finalizeDetections, offsetBoxes, rgbToChw } from './rtdetr'
import { planDetectionTiles, shouldTile } from './tiling'
import type { Bbox, DetectedGroups, DetectedUnit } from './types'
import { buildUnits } from './units'
import type { ReadingDirection } from './units'
import { letterboxLayout } from './utils'

// onnxruntime-node is CommonJS; depending on the loader the API is on the namespace or on `default`.
type Ort = typeof import('onnxruntime-node')
const ort: Ort = ((ortNamespace as unknown as { default?: Ort }).default ?? ortNamespace) as Ort

/** A decoded page: interleaved 8-bit RGB. */
export interface RawImage {
  data: Uint8Array
  width: number
  height: number
  channels: 3
}

export interface DetectOptions {
  minConfidence?: number
  readingDirection?: ReadingDirection
  /** Boxes covering at least this share of the image are dropped. Defaults to DEFAULT_MAX_BOX_IMAGE_COVERAGE. */
  maxBoxImageCoverage?: number
}

export interface DetectResult {
  width: number
  height: number
  tiled: boolean
  tileCount: number
  groups: DetectedGroups
  units: DetectedUnit[]
  timings: { decodeMs: number; inferMs: number }
}

/** Decodes any supported format to RGB, applying EXIF orientation like a browser and flattening alpha onto white. */
export async function decodeToRaw(bytes: Uint8Array): Promise<RawImage> {
  const { data, info } = await sharp(bytes, { failOn: 'none' })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, channels: 3 }
}

/** Encodes a padded crop of the page as PNG for the OCR request. Returns `null` when the crop is empty. */
export async function cropToPng(image: RawImage, box: Bbox, padding: number): Promise<Uint8Array | null> {
  const rect: PixelRect | null = paddedRect(box, padding, image.width, image.height)
  if (rect === null) return null
  const pixels = cropRaw(image.data, image.width, image.channels, rect)
  const png = await sharp(pixels, { raw: { width: rect.width, height: rect.height, channels: 3 } })
    .png()
    .toBuffer()
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength)
}

export class Detector {
  private constructor(private readonly session: import('onnxruntime-node').InferenceSession) {}

  /** Loads the ONNX model on the CPU execution provider (the baseline, design section 9). */
  static async create(modelPath: string): Promise<Detector> {
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    })
    return new Detector(session)
  }

  async dispose(): Promise<void> {
    await this.session.release()
  }

  /** Detects units on an already decoded page. */
  async detectRaw(image: RawImage, options: DetectOptions = {}): Promise<Omit<DetectResult, 'timings'> & { inferMs: number }> {
    const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    const started = performance.now()
    const tiled = shouldTile(image.width, image.height)

    let rawGroups: DetectedGroups
    let tileCount = 1
    if (!tiled) {
      rawGroups = await this.runSingle(image.data, image.width, image.height, minConfidence)
    } else {
      const tiles = planDetectionTiles(image.width, image.height)
      tileCount = tiles.length
      const textBoxes: Bbox[] = []
      const bubbleBoxes: Bbox[] = []
      for (const tile of tiles) {
        const pixels = cropRaw(image.data, image.width, image.channels, { left: tile.x, top: tile.y, width: tile.w, height: tile.h })
        const result = await this.runSingle(pixels, tile.w, tile.h, minConfidence)
        textBoxes.push(...offsetBoxes(result.textBoxes, tile, image.width, image.height))
        bubbleBoxes.push(...offsetBoxes(result.bubbleBoxes, tile, image.width, image.height))
      }
      rawGroups = { textBoxes, bubbleBoxes }
    }

    const finalized = finalizeDetections(rawGroups, image.width, image.height, tiled)
    const groups = dropOversizedBoxes(finalized, image.width, image.height, options.maxBoxImageCoverage ?? DEFAULT_MAX_BOX_IMAGE_COVERAGE)
    const units = buildUnits(groups, options.readingDirection ?? 'ltr')
    return { width: image.width, height: image.height, tiled, tileCount, groups, units, inferMs: performance.now() - started }
  }

  /** Decodes `bytes` and detects units. */
  async detect(bytes: Uint8Array, options: DetectOptions = {}): Promise<{ image: RawImage; result: DetectResult }> {
    const decodeStart = performance.now()
    const image = await decodeToRaw(bytes)
    const decodeMs = performance.now() - decodeStart
    const { inferMs, ...rest } = await this.detectRaw(image, options)
    return { image, result: { ...rest, timings: { decodeMs, inferMs } } }
  }

  /** One RT-DETR pass over an interleaved RGB image of any size (letterboxed into 640 x 640). */
  private async runSingle(pixels: Uint8Array, width: number, height: number, minConfidence: number): Promise<DetectedGroups> {
    const layout = letterboxLayout(width, height, INPUT_SIZE)
    const square = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .resize(layout.newWidth, layout.newHeight, { fit: 'fill' })
      .extend({
        top: layout.top,
        bottom: layout.bottom,
        left: layout.left,
        right: layout.right,
        background: { r: LETTERBOX_FILL, g: LETTERBOX_FILL, b: LETTERBOX_FILL },
      })
      .raw()
      .toBuffer()

    const imageTensor = new ort.Tensor('float32', rgbToChw(new Uint8Array(square.buffer, square.byteOffset, square.byteLength), INPUT_SIZE), [1, 3, INPUT_SIZE, INPUT_SIZE])
    // Pixels and output coordinates both use the letterboxed square, so the "original size" fed to the
    // model is the square. restoreBoundingBox performs the one transform back to page coordinates.
    const sizeTensor = new ort.Tensor('int64', new BigInt64Array([BigInt(INPUT_SIZE), BigInt(INPUT_SIZE)]), [1, 2])

    const names = this.session.inputNames
    const feeds: Record<string, import('onnxruntime-node').Tensor> = {
      [names[0] ?? 'images']: imageTensor,
      [names[1] ?? 'orig_target_sizes']: sizeTensor,
    }
    const results = await this.session.run(feeds)
    const labels = results['labels']
    const boxes = results['boxes']
    const scores = results['scores']
    if (!labels || !boxes || !scores) throw new Error('Detector output is missing labels, boxes or scores')

    return decodeRtDetrOutputs(
      {
        labels: labels.data as ArrayLike<number | bigint>,
        boxes: boxes.data as ArrayLike<number>,
        scores: scores.data as ArrayLike<number>,
      },
      width,
      height,
      minConfidence,
    )
  }
}
