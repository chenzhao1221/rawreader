import { inReadingOrder } from './boxes'
import type { Bbox, DetectedGroups, DetectedUnit } from './types'

export type ReadingDirection = 'ltr' | 'rtl'

const centreOf = (b: Bbox): [number, number] => [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2]
const areaOf = (b: Bbox): number => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
const heightOf = (b: Bbox): number => Math.max(0, b.y2 - b.y1)
const insideBox = (box: Bbox, x: number, y: number): boolean => x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2

function unionBox(boxes: Bbox[]): Bbox {
  const first = boxes[0] as Bbox
  let { x1, y1, x2, y2 } = first
  let confidence = first.confidence
  for (const b of boxes.slice(1)) {
    x1 = Math.min(x1, b.x1)
    y1 = Math.min(y1, b.y1)
    x2 = Math.max(x2, b.x2)
    y2 = Math.max(y2, b.y2)
    confidence = Math.max(confidence, b.confidence)
  }
  return { x1, y1, x2, y2, confidence }
}

/**
 * Builds translatable units from detector groups (design section 9):
 * - a bubble with text boxes inside: OCR the union of those text boxes, draw in the bubble;
 * - a bubble with no text box: OCR the whole bubble ("bubble-only"), draw in the bubble;
 * - text boxes outside every bubble: free units.
 * A text box belongs to the smallest bubble that contains its centre.
 * Units are returned in reading order.
 */
export function buildUnits(groups: DetectedGroups, direction: ReadingDirection = 'ltr'): DetectedUnit[] {
  const bubbles = inReadingOrder(groups.bubbleBoxes)
  const texts = inReadingOrder(groups.textBoxes)
  const assigned: Bbox[][] = bubbles.map(() => [])
  const free: Bbox[] = []

  for (const text of texts) {
    const [cx, cy] = centreOf(text)
    let best = -1
    let bestArea = Number.POSITIVE_INFINITY
    bubbles.forEach((bubble, index) => {
      if (!insideBox(bubble, cx, cy)) return
      const area = areaOf(bubble)
      if (area < bestArea) {
        best = index
        bestArea = area
      }
    })
    if (best === -1) free.push(text)
    else (assigned[best] as Bbox[]).push(text)
  }

  const units: DetectedUnit[] = []
  bubbles.forEach((bubble, index) => {
    const inside = assigned[index] as Bbox[]
    units.push({
      kind: 'bubble',
      drawBox: bubble,
      ocrBox: inside.length > 0 ? unionBox(inside) : bubble,
      bubbleOnly: inside.length === 0,
    })
  })
  for (const text of free) units.push({ kind: 'free', drawBox: text, ocrBox: text, bubbleOnly: false })

  return sortReadingOrder(units, direction)
}

/** Row bands of 0.5 x the median unit height, then x ascending (ltr) or descending (rtl). */
export function sortReadingOrder(units: DetectedUnit[], direction: ReadingDirection): DetectedUnit[] {
  if (units.length <= 1) return units
  const heights = units.map((u) => heightOf(u.drawBox)).sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)] as number
  const band = Math.max(1, 0.5 * median)

  // Sequential banding: walk the units by vertical centre and open a new band once a unit is
  // `band` or more below the first unit of the current band. Fixed grid cells would split
  // two units on the same visual row whenever a cell boundary happens to fall between them.
  const byY = units
    .map((unit) => {
      const [cx, cy] = centreOf(unit.drawBox)
      return { unit, cx, cy }
    })
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx)

  const bands: (typeof byY)[] = []
  let bandStart = Number.NEGATIVE_INFINITY
  for (const item of byY) {
    if (bands.length === 0 || item.cy - bandStart >= band) {
      bands.push([])
      bandStart = item.cy
    }
    ;(bands[bands.length - 1] as typeof byY).push(item)
  }

  const out: DetectedUnit[] = []
  for (const row of bands) {
    row.sort((a, b) => (direction === 'ltr' ? a.cx - b.cx : b.cx - a.cx) || a.cy - b.cy)
    for (const item of row) out.push(item.unit)
  }
  return out
}
