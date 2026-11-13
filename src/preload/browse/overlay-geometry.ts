// Portions ported from libre-manga-translator src/entrypoints/content/utils.ts (syncWrapperGeometry:
// usable-layout check and the 0.5 px epsilon guard; createImageObservers: rAF-throttled size sync)
// @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: pure functions on plain rectangles (no DOM), fixed-position hosts instead of a wrapper
// element around the image (the page DOM is not modified), position tracked as well as size, viewport culling.

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** Same epsilon as LMT: a change below half a pixel is not a change. */
export const GEOMETRY_EPSILON = 0.5

export interface HostGeometry {
  rect: Rect
  scaleX: number
  scaleY: number
}

/**
 * LMT `syncWrapperGeometry`, pure: an image without layout (zero rendered size or unknown natural
 * size) cannot carry an overlay yet. Returns `null` then, else the host rectangle and the
 * display/natural scale.
 */
export function computeHostGeometry(rendered: Rect, natural: Size): HostGeometry | null {
  if (rendered.width <= 0 || rendered.height <= 0 || natural.width <= 0 || natural.height <= 0) return null
  return {
    rect: { left: rendered.left, top: rendered.top, width: rendered.width, height: rendered.height },
    scaleX: rendered.width / natural.width,
    scaleY: rendered.height / natural.height,
  }
}

/** True when `next` differs from `previous` by more than the epsilon in position or size. */
export function rectChanged(previous: Rect | null, next: Rect, epsilon = GEOMETRY_EPSILON): boolean {
  if (previous === null) return true
  return (
    Math.abs(previous.left - next.left) >= epsilon ||
    Math.abs(previous.top - next.top) >= epsilon ||
    Math.abs(previous.width - next.width) >= epsilon ||
    Math.abs(previous.height - next.height) >= epsilon
  )
}

/**
 * Whether the host should be visible. Hosts of images far outside the viewport are hidden so a long
 * strip does not keep hundreds of large fixed layers alive. `margin` is in CSS pixels.
 */
export function isNearViewport(rect: Rect, viewport: Size, margin: number): boolean {
  return (
    rect.top + rect.height >= -margin &&
    rect.top <= viewport.height + margin &&
    rect.left + rect.width >= -margin &&
    rect.left <= viewport.width + margin
  )
}

export interface BoxLike {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** A box in image pixels mapped to host-relative CSS pixels. */
export function scaleBox(box: BoxLike, scaleX: number, scaleY: number): Rect {
  return {
    left: box.x1 * scaleX,
    top: box.y1 * scaleY,
    width: Math.max(0, (box.x2 - box.x1) * scaleX),
    height: Math.max(0, (box.y2 - box.y1) * scaleY),
  }
}

/**
 * The area unit text is drawn into, in image pixels. A bubble is usually an ellipse, so the text area is
 * the bubble box shrunk towards its centre (a rectangle inscribed in an ellipse is about 70 % of its box).
 * A free text box is grown a little so the original glyphs under it are covered.
 */
export function textAreaFor(kind: 'bubble' | 'free', box: BoxLike, image: Size): BoxLike {
  const w = box.x2 - box.x1
  const h = box.y2 - box.y1
  if (kind === 'bubble') {
    const insetX = w * 0.08
    const insetY = h * 0.08
    return { x1: box.x1 + insetX, y1: box.y1 + insetY, x2: box.x2 - insetX, y2: box.y2 - insetY }
  }
  const growX = Math.max(3, w * 0.04)
  const growY = Math.max(3, h * 0.06)
  return {
    x1: Math.max(0, box.x1 - growX),
    y1: Math.max(0, box.y1 - growY),
    x2: Math.min(image.width, box.x2 + growX),
    y2: Math.min(image.height, box.y2 + growY),
  }
}
