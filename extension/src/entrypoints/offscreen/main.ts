// Portions ported from libre-manga-translator src/entrypoints/offscreen/main.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: only OFFSCREEN_INPAINT_IMAGE is kept. Detection, OCR, WebLLM, Gemini, api mode and the
// model status handlers are gone (the RawReader app does that work). The LaMa model rung is gone too.
import "@/assets/app.css";
import { inpaintImageAuto } from "@/lib/inpaint/ladder";

browser.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg.type === "OFFSCREEN_INPAINT_IMAGE") {
    const { src, bboxes, alwaysInpaint } = msg.data;
    inpaintImageAuto(src, bboxes, { alwaysInpaint })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  return false;
});
