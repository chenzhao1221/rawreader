// RawReader extension: direct API mode. Cuts a long vertical strip (webtoon) into overlapping segments and maps
// the model's boxes back to the whole image (pure, no browser APIs).
import type { NormBox } from "./prompt";

/** Images taller than this multiple of their width are sent in segments. */
export const TILE_ASPECT = 2;

/** Share of a segment's height that the next segment repeats, so a bubble on a cut is seen whole at least once. */
export const TILE_OVERLAP = 0.08;

/** Two boxes from neighbouring segments with at least this IoU are the same bubble. */
export const DUPLICATE_IOU = 0.3;

export interface Segment {
  index: number;
  /** Top edge in pixels of the original image. */
  top: number;
  /** Height in pixels of the original image. */
  height: number;
  /** Size of the segment as it is sent, in pixels. Its longest side is at most the `maxSide` it was planned with. */
  sendWidth: number;
  sendHeight: number;
}

export function shouldTile(width: number, height: number): boolean {
  return width > 0 && height / width > TILE_ASPECT;
}

/**
 * Segments of a strip, top to bottom. Each segment is at most `maxSide` pixels on its longest side when sent. The
 * strip is never scaled down more than the width needs; the segments keep the original resolution where they can.
 */
export function planSegments(width: number, height: number, maxSide: number): Segment[] {
  const scale = Math.min(1, maxSide / width);
  const sendWidth = Math.max(1, Math.round(width * scale));
  const segmentPx = Math.max(1, Math.floor(maxSide / scale));
  const overlapPx = Math.round(segmentPx * TILE_OVERLAP);
  const step = Math.max(1, segmentPx - overlapPx);

  const tops: number[] = [];
  let top = 0;
  for (;;) {
    // The last segment ends at the bottom edge instead of leaving a sliver that only repeats the one before.
    if (top + segmentPx >= height) {
      tops.push(Math.max(0, height - segmentPx));
      break;
    }
    tops.push(top);
    top += step;
  }

  return tops.map((segTop, index) => {
    const segHeight = Math.min(segmentPx, height - segTop);
    return {
      index,
      top: segTop,
      height: segHeight,
      sendWidth,
      sendHeight: Math.max(1, Math.round(segHeight * scale)),
    };
  });
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** A box in fractions of a segment, as fractions of the whole image. */
export function segmentBoxToWhole(box: NormBox, segment: Segment, imageHeight: number): NormBox {
  return {
    x1: clamp01(box.x1),
    x2: clamp01(box.x2),
    y1: clamp01((segment.top + box.y1 * segment.height) / imageHeight),
    y2: clamp01((segment.top + box.y2 * segment.height) / imageHeight),
  };
}

/** A box in fractions of the whole image, as fractions of a segment (clipped to the segment). */
export function wholeBoxToSegment(box: NormBox, segment: Segment, imageHeight: number): NormBox {
  const top = segment.top / imageHeight;
  const bottom = (segment.top + segment.height) / imageHeight;
  const span = bottom - top;
  return {
    x1: clamp01(box.x1),
    x2: clamp01(box.x2),
    y1: clamp01((clamp01(box.y1) - top) / span),
    y2: clamp01((clamp01(box.y2) - top) / span),
  };
}

/** The segment that owns a region: the one that holds the region's vertical centre. */
export function segmentOwning(box: NormBox, segments: Segment[], imageHeight: number): number {
  const centre = ((box.y1 + box.y2) / 2) * imageHeight;
  const found = segments.find((s) => centre >= s.top && centre < s.top + s.height);
  return found ? found.index : segments.length - 1;
}

export function iou(a: NormBox, b: NormBox): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

export interface SegmentUnit<T> {
  segment: number;
  box: NormBox;
  value: T;
}

/**
 * Drops a unit that a neighbouring segment already reported: the segments overlap, so one bubble can come back
 * twice. Units from the same segment are never merged, so two real bubbles stay apart.
 */
export function mergeSegmentUnits<T>(units: SegmentUnit<T>[]): SegmentUnit<T>[] {
  const kept: SegmentUnit<T>[] = [];
  for (const unit of units) {
    const duplicate = kept.some((k) => k.segment !== unit.segment && iou(k.box, unit.box) >= DUPLICATE_IOU);
    if (!duplicate) kept.push(unit);
  }
  return kept;
}
