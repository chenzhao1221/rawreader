import { join } from 'node:path'

/** File name of the bundled Noto Sans SC Bold subset (OFL-1.1, see resources/fonts/OFL.txt). */
export const OVERLAY_FONT_FILE = 'NotoSansSC-Bold-subset.woff'

export function overlayFontPath(resourcesDir: string): string {
  return join(resourcesDir, 'fonts', OVERLAY_FONT_FILE)
}

/**
 * Returns a function that reads the bundled overlay font on first use and then serves it from memory.
 * A missing or unreadable file yields `null` (the overlay falls back to the system CJK fonts) and is
 * retried on the next call.
 */
export function createFontProvider(
  resourcesDir: string,
  readFile: (path: string) => Promise<Uint8Array>,
): () => Promise<Uint8Array | null> {
  let cached: Uint8Array | null = null
  return async () => {
    if (cached) return cached
    try {
      cached = await readFile(overlayFontPath(resourcesDir))
      return cached
    } catch {
      return null
    }
  }
}