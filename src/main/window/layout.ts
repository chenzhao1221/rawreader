import { STATUS_HEIGHT, TOOLBAR_HEIGHT } from '../../shared/constants'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** The browse view fills the window content area between the toolbar and the status bar. */
export function computeBrowseBounds(
  content: { width: number; height: number },
  toolbarHeight: number = TOOLBAR_HEIGHT,
  statusHeight: number = STATUS_HEIGHT,
): Bounds {
  return {
    x: 0,
    y: toolbarHeight,
    width: Math.max(0, Math.floor(content.width)),
    height: Math.max(0, Math.floor(content.height) - toolbarHeight - statusHeight),
  }
}
