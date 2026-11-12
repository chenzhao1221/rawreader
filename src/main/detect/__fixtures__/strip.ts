import type { Bbox } from '../types'

/** A synthetic 800 x 3000 webtoon strip: expected tile plan with 1000 px tiles and 200 px minimum overlap. */
export const STRIP = {
  width: 800,
  height: 3000,
  expectedTiles: [
    { x: 0, y: 0, w: 800, h: 1000 },
    { x: 0, y: 667, w: 800, h: 1000 },
    { x: 0, y: 1333, w: 800, h: 1000 },
    { x: 0, y: 2000, w: 800, h: 1000 },
  ],
} as const

const box = (x1: number, y1: number, x2: number, y2: number, confidence = 0.9): Bbox => ({ x1, y1, x2, y2, confidence })

/** The same bubble text seen by two overlapping tiles; tile A cuts it at its bottom edge. */
export const SEAM_TEXT_TILE_A = box(100, 900, 300, 1000, 0.8) // page coordinates, tile y = 0
export const SEAM_TEXT_TILE_B = box(100, 900, 300, 1050, 0.9) // page coordinates, tile y = 667

/** Page with one bubble holding a text box, one bubble without text, one free text box. */
export const PAGE_WITH_BUBBLE_ONLY = {
  width: 800,
  height: 1000,
  bubbleWithText: box(100, 100, 400, 300),
  textInBubble: box(150, 150, 350, 250),
  bubbleOnly: box(450, 400, 700, 600),
  freeText: box(100, 700, 300, 780),
}
