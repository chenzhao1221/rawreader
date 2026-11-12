---
inclusion: always
---

# Product: RawReader

RawReader is a Windows-first Electron desktop app that translates raw manga, manhwa and webtoons to Simplified Chinese locally while the user reads them in a built-in browser. All inference runs on the user's machine. Licence: AGPL-3.0 (see `LICENSE`).

"RawReader" is a working name and may change before the first public build. Never hard-code the name, `appId` or the userData folder name outside the single app-identity source (see `structure.md`).

## Users and the core flow

The user is a Chinese-speaking reader of untranslated comics on websites they already use.

1. Open RawReader and type a URL in the address bar. The page loads in the built-in browser.
2. Log in by hand if the site needs it. Cookies and logins persist across restarts in the app's own session partition `persist:browse`. CAPTCHAs are always solved by the user and never automated.
3. Turn on auto-translate. As page images scroll into view, RawReader captures each image, detects bubbles, runs OCR, translates each bubble, and draws the Chinese text over the bubbles.
4. One global toggle hides the overlay and shows the original page.

## Phase 1 scope (approved, do not reopen)

- Built-in browser: address bar, back/forward/reload, persistent partition `persist:browse`.
- Auto-translate toggle; translate-as-you-scroll (images entering the viewport, nearest first).
- Image capture prefers bytes the browser already loaded (CDP `Network.getResponseBody`), with `session.fetch` on the same partition as the fallback. No screenshots.
- Bubble detection: RT-DETR detector `ogkalu/comic-text-and-bubble-detector` (11 MB int8, bundled), ported LMT preprocessing, long-strip tiling and box restore, on onnxruntime-node and sharp. Bubble-only boxes (a bubble with no text box inside) are kept and OCR'd as the whole bubble.
- OCR: llama-server #1 running PaddleOCR-VL-1.5 GGUF, prompt `OCR:`.
- Translation: llama-server #2 running Index-Translate-2B Q4_K_M, ported LMT prompt logic, one request per bubble, bubbles in parallel with bounded concurrency.
- Overlay: simple text overlay fitted to each bubble; a global toggle turns it off to show the original.
- Cache: results keyed by image content hash, capped at 2 GB. Raw images are never stored long-term.
- Two llama-server child processes are spawned by the app and cleanly killed on exit.
- llama.cpp backend is swappable. The installer bundles the Vulkan build only. NVIDIA users download the CUDA build on demand from settings.
- Models are downloaded on first run from hf-mirror.com with resume, ModelScope as fallback. The user may pick a model folder or point at files they already have.
- NSIS installer via electron-builder (per-user, `oneClick: false`).

## Phase 1 exclusions

Inpainting, glossary editor, third-party translation APIs, local folders/files, series-level glossary or name table (phase 2), canvas-based readers, automatic CAPTCHA handling, auto-update, code signing.

## Product rules

- UI language is Simplified Chinese. All docs, code, identifiers, comments, commit messages and logs are English.
- Local-first and private: no telemetry, no cloud calls except model and backend downloads the user starts or approves.
- Never store raw page images beyond the current session. Never log cookies, auth headers or full image URLs with query strings.
- Defaults: target language Simplified Chinese; translation model Index-Translate-2B Q4_K_M. A Q8 comparison is later work, not a phase-1 default.
- Reuse open-source code where the module plan says so. Every ported piece of libre-manga-translator (LMT) carries a source/licence header and a `THIRD_PARTY_NOTICES.md` entry.
- Source of truth for module choices: `.kiro/specs/module-plan/module-plan.md`. Phase-1 spec: `.kiro/specs/phase1-mvp/`.
