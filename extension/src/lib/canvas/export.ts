// Portions ported from libre-manga-translator src/lib/canvas/export.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
export type MangaTargetElement = HTMLImageElement | HTMLCanvasElement;

let taintedCanvasCounter = 0;

export function getElementSrc(
  el: MangaTargetElement,
  forceRefresh = false,
): string {
  if (el instanceof HTMLImageElement) return el.src;
  if (el instanceof HTMLCanvasElement) {
    if (!forceRefresh && (el as any).__lmt_src) {
      return (el as any).__lmt_src;
    }
    try {
      const dataUrl = el.toDataURL("image/jpeg", 0.95);
      (el as any).__lmt_src = dataUrl;
      return dataUrl;
    } catch {
      if (!(el as any).__lmt_src) {
        taintedCanvasCounter += 1;
        (el as any).__lmt_src = `canvas://lmt-tainted-${taintedCanvasCounter}-${el.width}x${el.height}`;
      }
      return (el as any).__lmt_src;
    }
  }
  return "";
}

/**
 * Draws the element on a canvas and returns a JPEG data URL. Throws with the reason when that is not possible
 * (a cross-origin image without CORS taints the canvas and toDataURL throws a SecurityError).
 */
export function imageToDataUrl(img: MangaTargetElement, quality = 0.95): string {
  if (img instanceof HTMLCanvasElement) {
    const dataUrl = img.toDataURL("image/jpeg", quality);
    if (!(img as any).__lmt_src || String((img as any).__lmt_src).startsWith("data:")) {
      (img as any).__lmt_src = dataUrl;
    }
    return dataUrl;
  }
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error("the image has no pixels yet (not loaded)");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas available");

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.toDataURL("image/jpeg", quality);
}

export function imageToBase64(img: MangaTargetElement, quality = 0.95): string | null {
  try {
    return imageToDataUrl(img, quality);
  } catch {
    return null;
  }
}

export function exportCanvasToJpeg(
  canvas: HTMLCanvasElement,
  quality = 0.85,
  filename?: string,
): void {
  const link = document.createElement("a");
  link.download = filename || `rawreader-export-${Date.now()}.jpg`;
  link.href = canvas.toDataURL("image/jpeg", quality);
  document.body.appendChild(link);
  link.click();
  link.remove();
}
