import { DEFAULT_MAX_BOX_IMAGE_COVERAGE } from '../../shared/config/schema'
import type { Bbox, DetectedGroups } from './types'

export { DEFAULT_MAX_BOX_IMAGE_COVERAGE }

const areaOf = (b: Bbox): number => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)

/**
 * Text boxes (lettering outside or inside bubbles) covering at least this share of the image are dropped too.
 * Narration and sound effects never cover half a page; a header logo read as one text box does (67% seen).
 */
export const MAX_TEXT_BOX_IMAGE_COVERAGE = 0.5

/** True when a box covers at least `share` of the image. Exported for the overlay filter. */
export function coversAtLeast(box: Bbox, imageWidth: number, imageHeight: number, share: number): boolean {
  const imageArea = imageWidth * imageHeight
  if (!(imageArea > 0) || !Number.isFinite(imageArea)) return false
  return areaOf(box) / imageArea >= share
}

/**
 * Drops bubble and text boxes whose area is at least `maxCoverage` of the image area.
 * Such boxes are whole-image false positives (header logos, covers). Boxes below the
 * threshold are kept untouched. An invalid image area or threshold drops nothing.
 */
export function dropOversizedBoxes(
  groups: DetectedGroups,
  imageWidth: number,
  imageHeight: number,
  maxCoverage: number = DEFAULT_MAX_BOX_IMAGE_COVERAGE,
): DetectedGroups {
  const imageArea = imageWidth * imageHeight
  if (!(imageWidth > 0) || !(imageHeight > 0) || !Number.isFinite(imageArea)) return groups
  if (!Number.isFinite(maxCoverage) || maxCoverage <= 0) return groups
  const keep = (b: Bbox): boolean => areaOf(b) / imageArea < maxCoverage
  const keepText = (b: Bbox): boolean => keep(b) && areaOf(b) / imageArea < Math.min(maxCoverage, MAX_TEXT_BOX_IMAGE_COVERAGE)
  return { textBoxes: groups.textBoxes.filter(keepText), bubbleBoxes: groups.bubbleBoxes.filter(keep) }
}
