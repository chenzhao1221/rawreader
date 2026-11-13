import { DEFAULT_MAX_BOX_IMAGE_COVERAGE } from '../../shared/config/schema'
import type { Bbox, DetectedGroups } from './types'

export { DEFAULT_MAX_BOX_IMAGE_COVERAGE }

const areaOf = (b: Bbox): number => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)

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
  return { textBoxes: groups.textBoxes.filter(keep), bubbleBoxes: groups.bubbleBoxes.filter(keep) }
}
