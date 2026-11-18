# Chrome extension line: requirements

> **Superseded by task 13 (auto-connect).** The pairing code, trust-on-first-use extension ID, rate limiter and off-by-default rule described below were replaced: the bridge is on by default, binds the first free port of 18793-18797, accepts only `Origin: chrome-extension://<pinned ID>` (ID fixed by the manifest `key` in `extension/extension-key.json`, constant in `src/shared/bridge.ts`), and the extension probes `GET /ping` itself. See `tasks.md` task 13 and `extension/README.md`.

Scope: a Chrome (Manifest V3) extension that translates comic images on websites in the user's own Chrome, with the RawReader desktop app doing detection, OCR and translation through a local bridge. Base selection, licensing and module layout are in `design.md`; the work plan is in `tasks.md`.

Requirements use EARS patterns ("WHEN … THE SYSTEM SHALL …", "WHILE …", "IF … THEN …"). "The app" means the RawReader desktop app, "the extension" means the code under `extension/`, "the system" means both. Phase-1 desktop requirements (`.kiro/specs/phase1-mvp/requirements.md`, R1–R15) stay in force; nothing here relaxes them.

This phase (stage 1) delivers only this spec, `NOTICE` and the notices entry. No implementation code is written in stage 1.

## Glossary

- **Bridge**: the HTTP listener in the app (`src/main/bridge/`) that the extension calls.
- **Extension mode**: the app state while the bridge is enabled and the extension is the expected client.
- **Pairing code**: a random secret the app shows and the user enters once in the extension options.
- **Base**: the upstream extension the `extension/` directory is derived from. Chosen base: Libre Manga Translator (LMT) at commit 1ddddc7.
- **Unit**: as in phase 1: one bubble (with or without text boxes) or one free text box.
- **Series context**: LMT's per-series data (series name, summary, dictionary/glossary, recent history).

---

## ER1. Bridge off by default, desktop unchanged

**User story:** As a desktop user who never installs the extension, I want the app to behave exactly as before.

1. THE app SHALL ship with the bridge disabled (`bridge.enabled = false` in the config schema defaults).
2. WHILE the bridge is disabled, THE app SHALL NOT open any listening socket for the bridge and SHALL NOT change window, tray, quit or pipeline behaviour compared with the current desktop build.
3. WHEN a config file without a `bridge` section is loaded, THE app SHALL fill in the disabled defaults without a migration error.
4. THE existing desktop test suite (`npm test`), `npm run typecheck` and `npm run build` SHALL pass unchanged after the bridge is added.
5. IF the bridge fails to start (port in use, bind error), THEN THE app SHALL log a redacted error, show it in the bridge settings and keep the desktop features working.

## ER2. Bridge network surface

**User story:** As a user, I want only my own extension on my own machine to reach the bridge.

1. THE bridge SHALL bind to `127.0.0.1` only, on a configurable port (default 18793, range 1024–65535). It SHALL NOT bind to `0.0.0.0`, `::` or `localhost` names.
2. THE bridge SHALL serve exactly `GET /ping` and `POST /translate` (plus `OPTIONS` preflight for those two paths). Every other method or path SHALL get `404` with an error body.
3. THE bridge SHALL reject (`403`) a request whose `Host` header is not `127.0.0.1:<port>`.
4. THE bridge SHALL reject (`403`) a request whose `Origin` header is missing or does not match `chrome-extension://<32 lowercase a–p characters>`.
5. WHEN an extension ID has been recorded at pairing (ER6.4), THE bridge SHALL reject (`403`) requests from any other extension ID.
6. THE bridge SHALL require `Authorization: Bearer <pairing code>` on both endpoints and SHALL reject a missing or wrong code with `401`, comparing in constant time.
7. IF more than 5 requests fail authentication within 60 s, THEN THE bridge SHALL answer every request with `429` for the next 60 s.
8. THE bridge SHALL reject (`413`) a `POST /translate` body larger than the existing `pipeline.maxBytes` image limit plus a fixed 64 KiB allowance for JSON overhead, without buffering beyond that limit.
9. THE bridge SHALL answer CORS only for the validated extension origin (`Access-Control-Allow-Origin: <that origin>`, no wildcard, no credentials).
10. Every error response SHALL be JSON `{ code, message }` with a stable `code`.
11. THE bridge SHALL NOT log the pairing code, the `Authorization` header, image bytes, or page URLs beyond their origin.

## ER3. `GET /ping`

1. WHEN an authenticated `GET /ping` arrives, THE bridge SHALL answer `200` with `{ v: 1, app: <productName from app identity>, version, ready, engine, reason? }`, where `ready` is true when the configured translation engine can take work and `reason` is the `{ code, message }` from the existing `serversUnavailable()` check otherwise.
2. THE ping response SHALL NOT contain file paths, model paths, API keys or config values other than the engine name.

## ER4. `POST /translate`

**User story:** As a reader in Chrome, I want each page image translated with the same models, settings and cache as the desktop app.

1. THE request body SHALL be JSON validated by zod: `{ v: 1, image: <base64 bytes>, priority?: number, context?: SeriesContext, boxes?: Bbox[] }`. Unknown fields SHALL be rejected (`400`).
2. WHEN a valid request arrives, THE app SHALL decode the image, verify its type by magic bytes with the existing MIME sniffer, compute the content hash, and run detection, OCR and translation with the app's current translation settings (engine local / OpenAI-compatible / Gemini, reading direction, bubbles-only, concurrency).
3. THE app SHALL use the same result cache as the desktop pipeline: a request whose content hash and cache identity match a stored result SHALL return that result without running any stage, and a newly computed result SHALL be stored for later desktop or extension use.
4. WHEN `context` carries a glossary or summary, THE app SHALL pass it to the translation prompt, and the cache identity SHALL include a hash of the context so results with different context are not mixed. Without `context` the cache identity SHALL equal the desktop one.
5. WHEN `boxes` is present (user-drawn or edited regions from the extension), THE app SHALL skip detection and OCR/translate exactly those boxes; such results SHALL NOT be written to the shared cache.
6. THE response SHALL be `{ v: 1, hash, width, height, cached, units: [{ kind, bubbleOnly, drawBox, ocrBox, ocrText, translation, status }], timings }` with boxes in natural image pixels, and SHALL contain no image bytes.
7. Bridge requests SHALL go through the existing stage queues with `priority` (default 0, larger first) so they share bounded concurrency with the desktop pipeline.
8. WHEN the client closes the connection before the answer, THE app SHALL abort that request's queued and running stages.
9. IF the translation engine is not ready, THEN THE bridge SHALL answer `503` with the `serversUnavailable()` code; IF the image is not a supported format, `415`; IF a stage fails, `502` with the stage failure code.
10. THE app SHALL NOT store the received image bytes on disk; they are released when the request ends.

## ER5. Extension mode and tray

1. WHILE the bridge is enabled, WHEN the user closes the main window, THE app SHALL hide to the existing tray icon instead of quitting, and show the existing tray hint once per session.
2. THE app SHALL offer a setting "start minimised to tray when the bridge is enabled"; when on, the main window SHALL NOT be shown at startup.
3. WHILE in extension mode, THE app SHALL start the llama-servers the configured engine needs, using the existing process manager and autostart settings, and SHALL stop them on quit as today.
4. Quitting from the tray SHALL close the bridge listener before the existing shutdown sequence kills the llama-servers.

## ER6. Pairing

1. WHEN the user enables the bridge for the first time, THE app SHALL generate a pairing code of 16 Crockford base32 characters (80 bits, shown in groups of 4) with a CSPRNG and store it in the existing secrets store (`src/main/secrets/store.ts`, Electron `safeStorage`, new secret name `bridge`), not in `config.json`.
2. THE bridge settings SHALL show the port, the pairing code (hidden until the user clicks show, with a copy button), the recorded extension ID, and a "regenerate code" action.
3. WHEN the user regenerates the code, THE app SHALL invalidate the old code and clear the recorded extension ID immediately.
4. WHEN the first authenticated request arrives after (re)generation, THE app SHALL record its extension ID (trust on first use).
5. THE extension options SHALL take the port and the pairing code, store them in `chrome.storage.local` only, and offer a "test connection" button that calls `GET /ping` and reports the result in Chinese.

## ER7. Extension features kept from the base

**User story:** As a reader, I want the LMT reading features I already know, powered by the app.

1. THE extension SHALL find page images, translate them as they scroll into view (nearest first) and draw translations over them, using LMT's content-script orchestration.
2. THE extension SHALL keep LMT's text cleaning with the algorithmic paths (fill, denoise, Telea; no LaMa model) and typesetting of translated text into the boxes returned by the bridge.
3. THE extension SHALL keep hover-to-translate (manual translation of one image) and LMT's user-drawn/edited box flow, sending edited boxes via `boxes` (ER4.5).
4. THE extension SHALL keep series context: series name, summary and glossary (dictionary) editing and storage, and SHALL send them as `context`.
5. THE extension SHALL keep the in-page sidebar, the popup, and site rules (manual rules, rule test, the bundled adapter files after review).
6. THE extension UI SHALL be Simplified Chinese, from one string table.
7. ONLY the extension's background service worker SHALL call the bridge; content scripts SHALL reach it through runtime messaging.
8. THE extension SHALL fetch image bytes the way LMT does (already-loaded image or background fetch with the page's referer rules) and SHALL NOT take screenshots of the tab for translation.

## ER8. Extension features removed

1. THE extension SHALL NOT contain WebLLM, in-browser OCR models (PaddleOCR / manga-ocr / Pororo / script gate), the LaMa inpainting model, the model download manager page or the local-mode setup wizard.
2. THE extension SHALL NOT contain LMT's "api" (self-hosted LLM) mode; the app's own OpenAI-compatible engine covers that case.
3. THE default extension mode SHALL be "RawReader app" (bridge). No other mode SHALL be needed for the main path to work.
4. THE extension's name, short description and icons SHALL come from the app identity (`app-identity.json` `productName`) and RawReader's icon, not from LMT branding; LMT stays credited in the notices and the options "about" section.

## ER9. Optional: direct Gemini mode

1. THE extension MAY keep LMT's direct Gemini mode, which needs the in-browser RT-DETR detector (about 11 MB) and onnxruntime-web.
2. IF direct Gemini mode is kept, THEN it SHALL be behind a build flag that is off by default, and builds with the flag off SHALL NOT contain the detector model, onnxruntime-web or its WASM files. (The offscreen document may stay in every build because the algorithmic inpainting runs there.)
3. No bridge-path task SHALL depend on direct Gemini mode.

## ER10. Privacy

1. THE extension SHALL send image bytes only to `http://127.0.0.1:<port>` (bridge mode) or, in the optional direct Gemini mode, to the Gemini endpoint the user configured.
2. THE system SHALL NOT add telemetry, analytics or remote logging.
3. THE extension SHALL NOT store raw page images beyond the current page session; it MAY store results (boxes, text) as LMT does.

## ER11. Licensing

1. THE `extension/` directory SHALL be distributed under AGPL-3.0 with the repository; every file derived from LMT SHALL carry the LMT source/licence header defined in `structure.md`, naming commit 1ddddc7.
2. `extension/package.json` SHALL declare `AGPL-3.0-only`, and `extension/THIRD_PARTY_NOTICES.md` SHALL list every production dependency, font and model of the extension, with licences on the allowlist in `tech.md`.
3. No ImageTrans code, key or asset SHALL be added. In particular `ImageTrans.pem` SHALL never be copied, used or committed.
4. The extension SHALL have its own signing key generated by the maintainer outside the repository; no `.pem` or `.crx` key SHALL be committed (`*.pem` is git-ignored under `extension/`).

## ER12. Build and tests

1. `extension/` SHALL be a separate npm package (own `package.json` and lockfile, npmmirror registry) and SHALL NOT be included in the root `tsconfig.*.json`, `vitest.config.ts`, electron-vite build or electron-builder `files`.
2. Root `npm test` SHALL include unit tests for the bridge: default-off, bind address, Host/Origin/auth checks, rate limit, body limit, request/response schemas, cache sharing, cancellation.
3. Bridge tests SHALL run headless: a Node HTTP server on an ephemeral `127.0.0.1` port with mocked pipeline dependencies; no Electron window, no tray, no browser, no llama-server, no model files.
4. The extension SHALL have `npm run typecheck`, `npm test` (Vitest, node or happy-dom environment) and `npm run build` (WXT, Chrome MV3) inside `extension/`; its tests SHALL NOT launch Chrome.
5. End-to-end tests that need Chrome, the real app or llama-servers SHALL be opt-in only (environment variable), following the existing `*.e2e.test.ts` convention.
