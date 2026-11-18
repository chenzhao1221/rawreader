# Chrome extension line: design

> **Superseded by task 13 (auto-connect).** The pairing code, trust-on-first-use extension ID, rate limiter and off-by-default rule described below were replaced: the bridge is on by default, binds the first free port of 18793-18797, accepts only `Origin: chrome-extension://<pinned ID>` (ID fixed by the manifest `key` in `extension/extension-key.json`, constant in `src/shared/bridge.ts`), and the extension probes `GET /ping` itself. See `tasks.md` task 13 and `extension/README.md`.

Requirements: `requirements.md` (ER1–ER12). Phase-1 design (`.kiro/specs/phase1-mvp/design.md`) and the steering files stay in force. Section numbers below are referenced from `tasks.md`.

## 1. Base selection

The bridge plan is fixed (requirements ER2–ER6): the app owns detection, OCR, translation and the cache; the extension finds images, sends bytes, and draws. The question was which existing extension needs the fewest changes to become that client.

### 1.1 Candidates

| | ImageTrans Chrome extension | Libre Manga Translator (LMT) |
|---|---|---|
| Source | github.com/xulihang/ImageTrans_chrome_extension @ 01749b9 | local `../libre-manga-translator`, zh-cn @ 1ddddc7 (1.0.4) |
| Licence | GPL-3.0 | AGPL-3.0-or-later |
| Code shape | Plain JS, no build, no types, no tests. `getImage.js` is one 245 KB file with about 190 top-level functions | TypeScript + Svelte 5 on WXT, split into entrypoints and `lib/` modules, 17 unit test files |
| Talks to a desktop app | Yes: form-urlencoded `POST <server>/translate` to the ImageTrans desktop (ports 5000 / 51043), result `imgMap.boxes` or a rendered JPEG | No: runs detection in the browser, OCR in the browser, then translates via WebGPU, an OpenAI-compatible server or Gemini |
| Scroll translation | Partial (one IntersectionObserver, MutationObservers) | Yes: `content/auto-translate.ts`, nearest-first queue |
| Text cleaning and typesetting | No inpainting in the extension (desktop renders); front-end text render only | Yes: `lib/inpaint/*` (fill, denoise, Telea, LaMa), `lib/canvas/text-fit.ts` |
| Hover / manual translate, box editing | Hover cursor only | Yes: `FloatingTrigger.svelte`, `overlay/BubbleEditor.svelte` and friends |
| Glossary / series info | No | Yes: `lib/series-context*.ts`, sidebar editor |
| Sidebar and popup | Popup and options only | Yes: `Sidebar.svelte`, `popup/App.svelte` |
| Site rules | Small selector settings | Yes: `lib/adapters.ts`, `lib/adapters/*`, `SiteRulesSettings.svelte` |
| Box format | ImageTrans `boxes` | `{ x1, y1, x2, y2, confidence }`, identical to `src/main/detect/types.ts` `Bbox` |
| Already used by RawReader | Nothing | 15 files already ported (see `THIRD_PARTY_NOTICES.md`), including text fit and overlay geometry |
| Hazards | Repo contains `ImageTrans.pem` (private key); bundles about 95 MB of OCR / kuromoji assets | Bundles about 37 MB ORT WASM and model plumbing that we delete |

### 1.2 Decision: LMT

LMT needs fewer changes for the fixed plan.

- Every feature the product wants to keep (scroll translation, text cleaning and typesetting, hover/manual translation, glossary and series info, sidebar and popup, site rules) already exists in LMT. With ImageTrans most of them would be new code.
- LMT's content script already splits the work into two calls, `requestBubbleDetection` and `requestTextTranslation` (`entrypoints/content/index.ts`), that go to the background. The bridge client replaces what is behind those two calls. Everything above them (registry, queue, overlay, editor, cache in `storage`) stays.
- The box type is the same as the app's, and the app already runs LMT-derived prompt and text-fit code, so results look the same in Chrome and in the desktop app.
- Most of the change is deletion (WebLLM, browser OCR, model manager, setup wizard, api mode). Deletion is cheaper and safer than writing missing features into a 245 KB untyped file.
- The licence is the same family as ours (AGPL), so no relicensing questions come up.

ImageTrans's one advantage, an existing desktop round trip, does not help much: its protocol is ImageTrans-specific (form-encoded, URL or JPEG based) and would have to be replaced anyway. No ImageTrans code is used.

### 1.3 LMT: keep / change / delete

Paths are LMT `src/` paths. "Change" means imported with the LMT header and modified.

**Keep (import, small or no changes)**

- `entrypoints/content/auto-translate.ts`, `translation-registry.ts`, `utils.ts`, `debug.ts`; `entrypoints/untaint.content.ts`
- `entrypoints/background/messaging.ts`, `utils.ts`
- `lib/canvas/*` (text fit, export, inpaint canvas helpers)
- `lib/inpaint/` algorithmic files: `constants.ts`, `denoise.ts`, `fill.ts`, `fit.ts`, `mask.ts`, `noise.ts`, `quality.ts`, `ring.ts`, `telea.ts`
- `lib/series-context.ts`, `lib/series-context-store.ts`, `lib/security.ts`, `lib/utils.ts`, `lib/env.ts`, `lib/adapters.ts`
- `lib/adapters/*`: reviewed one by one at import; adapters for sites the product does not target are dropped. Site names are not written into specs or notes.
- `lib/components/FloatingTrigger.svelte`, `Overlay.svelte`, `Sidebar.svelte`, `lib/components/overlay/*`
- `lib/components/settings/AutoTranslateToggle.svelte`, `TypographySettings.svelte`, `SiteRulesSettings.svelte`, `DebugPanel.svelte`
- `assets/app.css`, `assets/fonts/*` (OFL fonts)

**Change**

- `entrypoints/content/index.ts`: in bridge mode `requestBubbleDetection` sends one `BRIDGE_TRANSLATE` message and memoises the full result per image (by source key); `requestTextTranslation` returns the memoised translations aligned to the boxes, or, when the user edited boxes, sends `BRIDGE_TRANSLATE` with `boxes`. Debug log entries get mode `rawreader`. See §5.2.
- `entrypoints/background/index.ts`: keep `PROXY_IMAGE`, `TEST_SITE_RULE`, the declarativeNetRequest header rules; add `BRIDGE_PING` and `BRIDGE_TRANSLATE` (§5.1); delete every model, GPU, WebGPU, LLM cache and download handler, `TEST_BACKEND`, `OPEN_SETUP_TAB` (replaced by opening the options page) and `CAPTURE_VISIBLE_TAB` (no screenshots, ER7.8).
- `entrypoints/offscreen/*`: keep only `OFFSCREEN_INPAINT_IMAGE` (and the Gemini handlers when the optional flag is on, §7). Remove WebGPU detection, OCR, WebLLM, api branches, model status handlers.
- `lib/inpaint/ladder.ts`: remove the LaMa rungs; keep the fill / denoise / Telea routing. `InpaintSettings.svelte`: remove LaMa model choice.
- `entrypoints/popup/App.svelte`, `Sidebar.svelte`: mode list becomes `rawreader` (default) plus `gemini` when the flag is on; show bridge status from `BRIDGE_PING`.
- `lib/configs.ts`: `currentMode` default `rawreader`; remove model lists, WebLLM and server defaults; add `bridgePort` default 18793.
- `lib/timeouts.ts`: one stage timeout for the bridge call.
- `wxt.config.ts`: name from `../app-identity.json`; permissions `activeTab`, `storage`, `unlimitedStorage`, `declarativeNetRequest`, `offscreen`; host permissions `<all_urls>` (covers `http://127.0.0.1/*`); drop COEP/COOP and the WASM web-accessible resources unless the Gemini flag is on; drop the dev Chromium flags.
- Strings: the zh-cn branch strings are kept and moved into one table `extension/src/i18n/zh-CN.ts`.

**Delete (not imported)**

- `entrypoints/setup/**` (local-mode wizard), replaced by a small options entrypoint (§5.3)
- `lib/webllm.ts`, `lib/llm-engine.ts`, `lib/gpu-runtime.ts`, `lib/hardware.ts`, `lib/download-client.ts`, `lib/manifests/hashes.ts`, `lib/models/updates.ts`, `lib/ocr-text.ts`, `lib/prompts.ts` (the AI site-rule maker needs an in-extension LLM; manual site rules stay)
- `lib/ocr/**`, `lib/gate/**`, `lib/server/**` (api mode), `lib/inpaint/lama.ts`
- `lib/components/settings/BackendSettings.svelte` (replaced by `BridgeSettings.svelte`), `DetectionSettings.svelte`, `OcrSettings.svelte`, `GpuAccelerationPanel.svelte`, `ModelStorageSettings.svelte`, `ModelUpdateChecker.svelte`, `lib/components/ui/ModelSelect.svelte`
- `public/ort-wasm-*`, `public/dicts/*`; LMT icons (replaced by RawReader's icon)
- Optional-only (kept only behind the Gemini flag, §7): `lib/detections/**`, `lib/ort.ts`, `lib/gemini/**`, the validator part of `lib/server/validator.ts` that Gemini needs
- Dependencies: `@mlc-ai/web-llm` removed; `onnxruntime-web` only with the Gemini flag; `lucide-svelte` kept.

LMT unit tests that cover kept code (`adapters`, `security`, `series-context`, `telea`, `inpaint-ladder` minus LaMa, `request-timeout`, `lock`) are ported from `bun test` to Vitest. The others test deleted code and are not imported.

## 2. Licensing

- LMT is AGPL-3.0-or-later. RawReader is AGPL-3.0 (`package.json`: `AGPL-3.0-only`). Code offered under "version 3 or any later version" may be used under version 3, so LMT-derived files can be distributed as part of RawReader under AGPL-3.0. Conclusion: compatible; the combined work, including `extension/`, is distributed under AGPL-3.0.
- Obligations: keep LMT's copyright notices; mark every derived file as modified with the header from `structure.md` (LMT path + commit 1ddddc7); list derived files and the extension's dependencies in notices; provide source (this repository) to anyone who receives the extension. Section 13 (network use) does not add duties here because the bridge only listens on loopback for the local user, but the source offer is kept anyway.
- ImageTrans is GPL-3.0. Per the FSF, GPL-3.0 code may be combined into an AGPL-3.0 work (section 13 of both licences); the combination is distributed under AGPL-3.0 and keeps the ImageTrans author and GPL notices. We do not use ImageTrans code, so this is recorded only as the rule to follow if that changes. `ImageTrans.pem` is a private key and is never copied or used.
- Files: `NOTICE` (short source statement), `THIRD_PARTY_NOTICES.md` section "Browser extension (extension/, planned)", and later `extension/THIRD_PARTY_NOTICES.md` with exact versions.

## 3. Architecture

```
Chrome tab                         Extension service worker              RawReader app (main process)
content script (LMT, modified)     background (LMT, modified)            src/main/bridge/
  find images, scroll queue          PROXY_IMAGE: fetch bytes              http server 127.0.0.1:18793
  overlay, editor, sidebar  --msg--> BRIDGE_TRANSLATE  ----HTTP POST---->  guards -> schema -> Pipeline.translateBytes
  inpaint via offscreen    <--msg--  result (boxes, text) <--JSON-------   (shared queues, cache, engine settings)
```

- Only the service worker talks to the bridge (ER7.7). Content scripts never fetch `127.0.0.1`, which keeps the page origin out of the request and avoids Private Network Access checks on page context.
- The app keeps its own built-in browser. The bridge is a second client of the same pipeline.

## 4. App side: `src/main/bridge/`

### 4.1 Files

| File | Kind | Content |
|---|---|---|
| `src/shared/config/schema.ts` (change) | pure | `bridge: { enabled: false, port: 18793, startHidden: false, extensionId: null }` with zod defaults (`prefault({})`), so old configs load (ER1.3) |
| `src/main/secrets/store.ts` (change) | edge | add secret name `bridge` for the pairing code |
| `src/main/bridge/pairing.ts` | pure | code generation (injected random bytes, Crockford base32, 16 chars), format for display, constant-time compare |
| `src/main/bridge/guards.ts` | pure | `checkRequest({ method, path, host, origin, authorization }, state) -> ok | { status, code }`: Host, Origin pattern, recorded extension ID, bearer code, rate-limit window (injected clock) |
| `src/main/bridge/protocol.ts` | pure | zod schemas for the `/translate` request and both responses; `toBridgeResult(ImageResult, cached)` |
| `src/main/bridge/context.ts` | pure | normalise series context (byte caps via the existing `truncateUtf8`), `contextHash` |
| `src/main/bridge/server.ts` | edge | `node:http` server: `listen(port, '127.0.0.1')`, body size cap while streaming, routes, CORS headers, `req.on('close')` -> abort, JSON errors; dependencies injected (`translate`, `ping`, `pairing`, `logger`) |
| `src/main/bridge/index.ts` | edge | `startBridge(deps)` / `stopBridge()`; reacts to config changes (enable, port) |
| `src/main/ipc/handlers.ts` (change) | edge | settings IPC: get status, show code, regenerate code (shell sender only) |
| `src/main/index.ts`, `src/main/window/tray.ts` (change) | edge | start the bridge only when enabled; close-to-tray and start-hidden while enabled; stop the bridge first in the shutdown sequence |
| `src/renderer/src/settings/BridgeTab.svelte` (new) + `i18n/zh-CN.ts` | UI | enable toggle, port, code show/copy/regenerate, recorded extension ID, status |

Only `src/main/ipc` registers IPC handlers, as `structure.md` requires. The HTTP server is not IPC and lives in `bridge/`.

### 4.2 Request handling

1. Guards (ER2.3–ER2.7) run on headers before the body is read. Failures answer immediately and count toward the rate limit only for auth failures.
2. The body is streamed with a hard cap (ER2.8), parsed as JSON, and validated with the zod schema (`strict`).
3. `image` is base64-decoded; the MIME sniffer (`src/main/capture/sniff.ts`) must recognise it, else `415`.
4. `Pipeline.translateBytes(bytes, { priority, signal, context, boxes })` runs the stages (§4.3).
5. The result is converted with `toBridgeResult` and returned. Bytes are dropped with the request (ER4.10).

Errors: `400 bad-request`, `401 unauthorized`, `403 forbidden-origin | forbidden-host | unknown-extension`, `404 not-found`, `413 too-large`, `415 unsupported-image`, `429 rate-limited`, `503 <serversUnavailable code>`, `502 <stage code>`. A request whose client disconnected gets no answer (the socket is gone).

### 4.3 Pipeline entry point

The current `Pipeline` (`src/main/pipeline/scheduler.ts`) is document- and subscriber-oriented: it captures by URL from the browse view and delivers to `<img>` elements. The bridge needs "bytes in, `ImageResult` out". Smallest change:

- Add one public method `translateBytes(bytes, options): Promise<ImageResult & { cached: boolean }>` that enters after capture: hash, cache lookup, detect, OCR, translate, cache store, using the same stage queues, the same settings and the same in-flight de-duplication by content hash.
- It does not touch `DocState`, `submit`, `setEnabled` or delivery; the desktop auto-translate toggle does not gate bridge work.
- `options.boxes` skips detection and builds units from the given boxes; such results skip the cache store (ER4.5).
- `options.context` is passed to the translator; the cache key's identity gets `contextHash` appended only when context is present (`src/main/cache/key.ts`), so plain requests share entries with the desktop (ER4.3, ER4.4).
- Prompt: the existing `prompts/lmt.ts` background builder gets the summary and glossary lines (it came from LMT's `buildMtBackground`, which already supports them); OpenAI-compatible and Gemini engines get the same text through their existing request builders.

The exact factoring (extracting the post-capture part of the current per-image task into a private helper both paths call) is decided at implementation time. Existing pipeline tests must pass without edits; new behaviour gets new tests.

### 4.4 Lifecycle and tray

- `bridge.enabled = false`: `startBridge` is never called; nothing listens; close quits as today.
- Enabled: the bridge starts after the config and pipeline wiring are ready; the llama-servers start through the existing autostart path; closing the window hides it (existing `tray.ts` `showHint` once); `startHidden` skips the first `show()`.
- Shutdown order: stop accepting bridge connections, abort in-flight bridge requests, then the existing sequence (pipeline, llama-servers with `taskkill /PID … /T /F`).
- Port change or disable at runtime: close and reopen the listener; in-flight requests are aborted.

## 5. Extension side: `extension/`

### 5.1 Background additions

- `BRIDGE_PING`: `fetch('http://127.0.0.1:<port>/ping', { headers: { Authorization } })` with a 3 s timeout; returns `{ ok, ready, reason }` to popup and options.
- `BRIDGE_TRANSLATE`: takes `{ src, boxes?, context?, priority }` from the content script; gets bytes (data URL decode or the existing `PROXY_IMAGE` fetch); posts JSON; maps HTTP errors to `{ error: { code, message } }`; aborts on tab navigation or when the content script cancels (port disconnect).
- A per-tab concurrency cap (2 in flight) so one long strip page does not flood the app queue; priority = negative distance to the viewport, as in LMT's queue.

### 5.2 Content script in bridge mode

- `requestBubbleDetection()` -> `BRIDGE_TRANSLATE` without `boxes`; stores the full result in a per-image memo and returns the boxes (`drawBox`, with `kind` and `bubbleOnly` carried along) in LMT's detection response shape.
- `requestTextTranslation(bboxes)` -> if the boxes are the memoised ones, return the memoised `translations` and `sourceTexts` in LMT's translation response shape, without a second request; if the user edited or drew boxes, send `BRIDGE_TRANSLATE` with `boxes`.
- Units with status other than `ok` are passed as empty translations so LMT neither cleans nor paints them, as its existing gate-skip path does.
- Everything downstream (inpaint, typeset, editor, cache in extension storage, sidebar, debug log) is unchanged.

### 5.3 Options page

New small Svelte entrypoint `options` (replaces `setup`): port, pairing code, "test connection", mode selection (Gemini only with the flag), typography and inpaint settings, site rules, about/licences (AGPL-3.0, LMT credit, link to source).

### 5.4 Package layout

```
extension/
├─ package.json            private, "license": "AGPL-3.0-only", own lockfile, scripts dev/build/typecheck/test/zip
├─ .npmrc                  registry=https://registry.npmmirror.com
├─ .gitignore              node_modules/, .output/, .wxt/, *.pem, *.crx
├─ wxt.config.ts           reads ../app-identity.json for the name
├─ vitest.config.ts
├─ tsconfig.json
├─ THIRD_PARTY_NOTICES.md
├─ README.md               load-unpacked instructions, pairing steps (English)
└─ src/                    LMT-derived tree after §1.3 (entrypoints/, lib/, assets/, i18n/)
```

The root project ignores `extension/`: root `tsconfig.node.json` and `tsconfig.web.json` include only `src/**` and listed files (already true), root `vitest.config.ts` includes only `src/**` and `scripts/**` (already true), electron-builder `files` lists only `out/**` and `package.json` (already true). A root test asserts these stay true (task 9.3).

## 6. Security notes

- Loopback bind + Host check stops other machines and DNS rebinding. Origin check stops ordinary web pages (browsers always send their own Origin). Neither stops another local process, which can forge headers; the 80-bit pairing code and the rate limit do.
- Trust on first use for the extension ID narrows the window to the first request after (re)generation.
- No cookies, no auth headers and no full image URLs travel to the app: the extension sends bytes, not URLs. Page origin is not sent at all in v1.
- Logs: request method, path, status, duration, byte size, content hash prefix. Never the code, headers or context text.

## 7. Optional: direct Gemini mode

If kept, a build-time flag `RAWREADER_EXT_GEMINI=1` includes `lib/detections/**`, `lib/ort.ts`, `lib/gemini/**`, the Gemini validator, the detector `detector-v4-s_int8.onnx` (Apache-2.0, same file as `resources/detector/`, copied at build time, not committed twice) and onnxruntime-web WASM. Without the flag none of these are in the bundle. The flag is off in default builds and no bridge task depends on it.

## 8. Testing strategy

| Layer | Where | How |
|---|---|---|
| Desktop regression | root `npm test`, `npm run typecheck`, `npm run build` | must pass unchanged; this is the gate for every app-side task |
| Bridge pure logic | `src/main/bridge/*.test.ts` | pairing, guards (table-driven), protocol schemas, context hash, result mapping |
| Bridge HTTP | `src/main/bridge/server.test.ts` | real `node:http` server on `127.0.0.1:0`, Node `fetch` as the client, fake `translate`/`ping`; covers status codes, CORS, body cap, abort on client close; no Electron |
| Default off | `src/main/bridge/index.test.ts`, `src/shared/config/schema.test.ts` | default config has `bridge.enabled === false`; startup with defaults never calls `listen` (spy) |
| Pipeline entry | `src/main/pipeline/*.test.ts` | `translateBytes` with fake stages: cache hit, store, `boxes` bypass, context in cache key, abort, priority |
| Root isolation | `src/main/bridge/isolation.test.ts` | root tsconfig/vitest/electron-builder do not include `extension/` |
| Extension unit | `extension/**/*.test.ts` (Vitest) | bridge client mapping, memo logic in bridge mode, ported LMT tests; happy-dom where DOM is needed; no Chrome |
| End to end | opt-in only | `RAWREADER_E2E=1`; not part of default runs |

No test opens a window, a tray icon, a browser or a llama-server, and none needs model files.

## 9. Open points

- Port 18793 is a default; the user can change it if another program uses it.
- Firefox is out of scope for this line. WXT can build it later; the bridge Origin check would then need `moz-extension://`.
- Chrome Web Store publishing, signing and auto-update are out of scope (as code signing is for the app).
