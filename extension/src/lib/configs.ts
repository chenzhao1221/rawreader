// Portions ported from libre-manga-translator src/lib/configs.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: the model lists (WebLLM, detectors, OCR packs, Gemini), the server defaults and the
// per-mode timeouts are gone. The default mode is "rawreader" (the app bridge).

export const DefaultConfig = {
  /** "rawreader": detection, OCR and translation run in the RawReader app on this computer. */
  currentMode: "rawreader",
  sourceLang: "Auto-Detect",
  targetLang: "Chinese (Simplified)",

  modes: [
    {
      id: "rawreader",
      label: "RawReader 应用",
      color: "emerald",
      classes: "text-emerald-700 dark:text-emerald-400",
      activeClasses: "bg-emerald-100 dark:bg-emerald-900/30",
    },
  ],


  autoTranslate: false,
  autoTranslateConcurrency: 1,

  // Inpainting: the model-free ladder (fitted mask -> planar fill -> denoise -> Telea), each rung decline-gated.
  inpaintMethod: "fast",
  alwaysInpaint: false,

  minTranslations: 5, // number of translations per series before resetting context

  bundleFonts: [
    { id: "system", label: "系统默认", stack: "'Segoe UI', sans-serif" },
    { id: "noto", label: "Noto Sans", stack: "'Noto Sans', sans-serif" },
    { id: "bangers", label: "Bangers", stack: "'Bangers', cursive" },
    { id: "comic", label: "Comic Neue", stack: "'Comic Neue', cursive" },
  ],
};

export interface ResolvedLangGroup {
  group: string;
  fellBack: boolean;
}

/** The app reads every script itself, so there is no per-language model pack to pick. Kept for the debug log. */
export function resolveLangGroup(_sourceLang: string): ResolvedLangGroup {
  return { group: "rawreader", fellBack: false };
}
