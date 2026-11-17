// Portions ported from libre-manga-translator src/lib/timeouts.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: the per-mode model budgets are gone. One stage budget covers the whole bridge call
// (detect, OCR and translate run in the app), plus a budget for the offscreen cleaning step.

/** One `POST /translate` round trip, queue wait inside the app included. */
export const BRIDGE_TRANSLATE_TIMEOUT_MS = 180_000;

/** Text cleaning of one page in the offscreen document. */
export const INPAINT_TIMEOUT_MS = 120_000;

/** Requests one tab may have in flight at the app (design 5.1); the rest wait by priority. */
export const MAX_BRIDGE_REQUESTS_PER_TAB = 2;
