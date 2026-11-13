import { STATUS_HEIGHT, TOP_CHROME_HEIGHT } from '../../shared/constants'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** The browse view fills the window content area between the tab strip + toolbar and the status bar. */
export function computeBrowseBounds(
  content: { width: number; height: number },
  topHeight: number = TOP_CHROME_HEIGHT,
  statusHeight: number = STATUS_HEIGHT,
): Bounds {
  return {
    x: 0,
    y: topHeight,
    width: Math.max(0, Math.floor(content.width)),
    height: Math.max(0, Math.floor(content.height) - topHeight - statusHeight),
  }
}
