// Portions ported from libre-manga-translator src/entrypoints/background/utils.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
export async function ensureOffscreen() {
  if (await browser.offscreen.hasDocument()) return;

  await browser.offscreen.createDocument({
    url: "/offscreen.html",
    reasons: [browser.offscreen.Reason.BLOBS],
    justification: "Image Processing",
  });
}
export async function detectHardware() {
  if ("ml" in navigator) {
    try {
      const mlContext = await (navigator.ml as any).createContext({
        deviceType: "npu",
      });
      if (mlContext) {
        return "npu";
      }
    } catch (error) {
      console.warn("WebNN NPU not available or context creation failed.");
    }
  }

  if ("gpu" in navigator) {
    try {
      const adapter = await (navigator.gpu as any).requestAdapter();
      if (adapter) {
        return "gpu";
      }
    } catch (error) {
      console.warn("GPU adapter request failed.");
    }
  }

  return "cpu";
}