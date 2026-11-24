---
inclusion: always
---

# Product: RawReader

RawReader is a Windows-first Electron desktop app that translates raw manga, manhwa and webtoons to Simplified Chinese while the user reads them in a built-in browser. By default all inference runs on the user's machine; the user can switch to a cloud engine instead (see "Translation engines"). Licence: AGPL-3.0 (see `LICENSE`).

"RawReader" is a working name and may change before the first public build. Never hard-code the name, `appId` or the userData folder name outside the single app-identity source (see `structure.md`).

## Users and the core flow

The user is a Chinese-speaking reader of untranslated comics on websites they already use.

1. Open RawReader and type a URL in the address bar. The page loads in the built-in browser.
2. Log in by hand if the site needs it. Cookies and logins persist across restarts in the app's own session partition `persist:browse`. CAPTCHAs are always solved by the user and never automated.
3. Turn on auto-translate. As page images scroll into view, RawReader captures each image, detects bubbles, runs OCR, translates each bubble, and draws the Chinese text over the bubbles.
4. One global toggle hides the overlay and shows the original page.
5. Right-click a picture and choose 翻译这张图片 to translate that one image when auto-translate missed it.

## Translation engines (local or cloud, user's choice)

- The engine is a setting (`translate.engine`), not a fixed pipeline: `local`, `openai` or `gemini`.
- `local`: llama-server #1 runs PaddleOCR-VL for OCR, llama-server #2 runs the chosen local translation model (Index-Translate-2B by default).
- `openai`: OCR stays local; translation goes to an OpenAI-compatible `/chat/completions` endpoint the user configures (Base URL, model, API key). DeepSeek, OpenRouter and LM Studio are offered as quick fills.
- `gemini`: one-stop mode. Bubble crops are sent to Gemini `generateContent` (batches of at most 20 crops) and come back with source text and translation; detection and cropping stay local. No local OCR or translation model is loaded.
- The Chrome extension has its own direct-API mode with presets for Google Gemini, 智谱 GLM, 硅基流动, 阿里云百炼 and 火山引擎豆包, plus a custom OpenAI-compatible endpoint.
- Cloud engines are optional and only used after the user picks one. API keys are stored encrypted with Electron `safeStorage` and never logged.

## Phase 1 scope (approved, do not reopen)

- Built-in browser: address bar, tabs, back/forward/reload, persistent partition `persist:browse`, tray icon that keeps translation running after the window is closed.
- Auto-translate toggle; translate-as-you-scroll (images entering the viewport, nearest first).
- Image capture prefers bytes the browser already loaded (CDP `Network.getResponseBody`), with `session.fetch` on the same partition as the fallback. No screenshots.
- Bubble detection: RT-DETR detector `ogkalu/comic-text-and-bubble-detector` (11 MB int8, bundled), ported LMT preprocessing, long-strip tiling and box restore, on onnxruntime-node and sharp. Bubble-only boxes (a bubble with no text box inside) are kept and OCR'd as the whole bubble.
- OCR: llama-server #1 running PaddleOCR-VL-1.5 GGUF, prompt `OCR:`.
- Translation: llama-server #2 running Index-Translate-2B Q4_K_M, ported LMT prompt logic. Bubbles are translated one at a time or batched per image (batching is on by default), with earlier bubbles of the same image as context and bounded concurrency.
- Overlay: simple text overlay fitted to each bubble; a global toggle turns it off to show the original.
- Cache: results keyed by image content hash, capped at 2 GB. Raw images are never stored long-term.
- Reading history: a local SQLite file (address, title, site, series, chapter, time; never images or translations), opened from the clock button in the toolbar.
- Two llama-server child processes are spawned by the app and cleanly killed on exit.
- llama.cpp backend is swappable. Both packages bundle the Vulkan build. NVIDIA users download the CUDA build on demand from settings.
- Models come with the full package; the lite package downloads them on first run from hf-mirror.com with resume, ModelScope as fallback. The user may pick a model folder or point at files they already have.
- Two packages from one code base: `full` (default, Windows `zip`, OCR and translation models bundled under `resources/models`) and `lite` (NSIS installer, no model files, wizard starts on Gemini).
- Chrome extension (separate npm package in `extension/`): bridges to the running app over `127.0.0.1` (bridge on by default, no pairing code, only the pinned extension Origin is accepted), or calls a vision API directly. It has both 翻译这张图片 and 翻译本页图片. The desktop app has only 翻译这张图片; whole-page work there is done by auto-translate.

## Phase 1 exclusions

Inpainting (desktop only; the extension has it), glossary editor, local folders/files, series-level glossary or name table (phase 2), canvas-based readers, automatic CAPTCHA handling, auto-update, code signing.

## Product rules

- UI language is Simplified Chinese. All docs, code, identifiers, comments, commit messages and logs are English.
- Local-first and private: no telemetry. Network access happens only for model and backend downloads the user starts or approves, or when the user has chosen a cloud engine, in which case only the configured endpoint is called.
- Distribution: the project is open source on GitHub and is obtained as source. There is no separate installer download; users build the app themselves. The Chrome extension is not in a store and is loaded unpacked in Chrome's developer mode.
- Never store raw page images beyond the current session. Never log cookies, auth headers or full image URLs with query strings.
- Defaults: target language Simplified Chinese; translation model Index-Translate-2B Q4_K_M. A Q8 comparison is later work, not a phase-1 default.
- Reuse open-source code where the module plan says so. Every ported piece of libre-manga-translator (LMT) carries a source/licence header and a `THIRD_PARTY_NOTICES.md` entry.
- Source of truth for module choices: `.kiro/specs/module-plan/module-plan.md`. Phase-1 spec: `.kiro/specs/phase1-mvp/`.
