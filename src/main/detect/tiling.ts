// Portions ported from libre-manga-translator src/lib/detections/tiling.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: typed with the local `Bbox`, no behavioural change.

import type { Bbox } from './types'
import { containmentNMS } from './utils'

/**
 * Detection tiling (sliding window). Webtoon strips can be 10,000-30,000 px
 * tall. Letterboxing such a strip into 640x640 reduces its width to a few dozen
 * pixels, so tall or wide pages are split into overlapping tiles at native
 * resolution, detected per tile, offset back to page space, and de-duplicated
 * across seams with IoU and containment fusion.
 */

export interface DetectionTile {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Thresholds for triggering tiling:
 * - Standard manga pages (aspect 1.3 to 1.6) run in a single pass.
 * - Webtoon strips (aspect >= 1.8 or a side above 2000 px) are tiled.
 */
export const TILE_ASPECT_THRESHOLD = 1.8
export const TILE_MAX_DIMENSION = 2000
export const DEFAULT_TILE_SIZE = 1000
export const DEFAULT_TILE_OVERLAP = 200

export function shouldTile(
  width: number,
  height: number,
  maxAspect = TILE_ASPECT_THRESHOLD,
  maxDim = TILE_MAX_DIMENSION,
): boolean {
  if (width <= 0 || height <= 0) return false
  const aspect = Math.max(width / height, height / width)
  return aspect >= maxAspect || width > maxDim || height > maxDim
}

/**
 * Computes 1-D tile spans along an axis of `totalLength`. If `totalLength` is at
 * most `tileSize`, returns one span. Otherwise uses a uniform step so every tile
 * has `tileSize` and neighbours overlap by at least `minOverlap`.
 */
export function computeTileOrigins(
  totalLength: number,
  tileSize: number,
  minOverlap: number,
): { start: number; size: number }[] {
  if (totalLength <= tileSize) {
    return [{ start: 0, size: totalLength }]
  }
  const stride = tileSize - minOverlap
  const count = Math.ceil((totalLength - tileSize) / stride) + 1
  const step = (totalLength - tileSize) / (count - 1)
  const origins: { start: number; size: number }[] = []
  for (let i = 0; i < count; i++) {
    origins.push({ start: Math.round(i * step), size: tileSize })
  }
  return origins
}

/**
 * Plans detection tiles for a page. For vertical webtoons (width <= tile size)
 * tiles span the full width and slide vertically with overlap.
 */
export function planDetectionTiles(
  pageW: number,
  pageH: number,
  maxTileSize = DEFAULT_TILE_SIZE,
  minOverlap = DEFAULT_TILE_OVERLAP,
): DetectionTile[] {
  const xSpans = computeTileOrigins(pageW, maxTileSize, minOverlap)
  const ySpans = computeTileOrigins(pageH, maxTileSize, minOverlap)

  const tiles: DetectionTile[] = []
  for (const y of ySpans) {
    for (const x of xSpans) {
      tiles.push({ x: x.start, y: y.start, w: x.size, h: y.size })
    }
  }
  return tiles
}

export type BboxCoords = Pick<Bbox, 'x1' | 'y1' | 'x2' | 'y2'>

export function boxIoU(a: BboxCoords, b: BboxCoords): number {
  const ix1 = Math.max(a.x1, b.x1)
  const iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2)
  const iy2 = Math.min(a.y2, b.y2)

  if (ix2 <= ix1 || iy2 <= iy1) return 0
  const inter = (ix2 - ix1) * (iy2 - iy1)
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

export function boxContainment(a: BboxCoords, b: BboxCoords): { inA: number; inB: number } {
  const ix1 = Math.max(a.x1, b.x1)
  const iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2)
  const iy2 = Math.min(a.y2, b.y2)

  if (ix2 <= ix1 || iy2 <= iy1) return { inA: 0, inB: 0 }
  const inter = (ix2 - ix1) * (iy2 - iy1)
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
  return {
    inA: areaA > 0 ? inter / areaA : 0,
    inB: areaB > 0 ? inter / areaB : 0,
  }
}

/**
 * Merges boxes across overlapping tile boundaries. Two boxes with high IoU, or
 * one heavily contained in the other (for example cut by a tile seam), become
 * their bounding union with the higher confidence.
 */
export function mergeTiledBoxes(boxes: Bbox[], iouThreshold = 0.35, containmentThreshold = 0.7): Bbox[] {
  if (boxes.length <= 1) return boxes

  const parent = boxes.map((_, i) => i)
  const find = (i: number): number => {
    const p = parent[i] as number
    if (p === i) return i
    const root = find(p)
    parent[i] = root
    return root
  }
  const union = (i: number, j: number): void => {
    const rootI = find(i)
    const rootJ = find(j)
    if (rootI !== rootJ) parent[rootJ] = rootI
  }

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i] as Bbox
      const b = boxes[j] as Bbox
      if (boxIoU(a, b) >= iouThreshold) {
        union(i, j)
        continue
      }
      const { inA, inB } = boxContainment(a, b)
      if (inA >= containmentThreshold || inB >= containmentThreshold) union(i, j)
    }
  }

  const groups = new Map<number, Bbox[]>()
  for (let i = 0; i < boxes.length; i++) {
    const root = find(i)
    const list = groups.get(root) ?? []
    list.push(boxes[i] as Bbox)
    groups.set(root, list)
  }

  const merged: Bbox[] = []
  for (const group of groups.values()) {
    const first = group[0] as Bbox
    let { x1, y1, x2, y2 } = first
    let confidence = first.confidence

    for (let i = 1; i < group.length; i++) {
      const b = group[i] as Bbox
      x1 = Math.min(x1, b.x1)
      y1 = Math.min(y1, b.y1)
      x2 = Math.max(x2, b.x2)
      y2 = Math.max(y2, b.y2)
      confidence = Math.max(confidence, b.confidence)
    }

    merged.push({ x1, y1, x2, y2, confidence })
  }

  return containmentNMS(merged)
}
