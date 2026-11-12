# RawReader module plan (phase 1)

Status: draft for phase-1 implementation. Checked on 2026-11-13.

## 0. How to read this

- Scope is phase 1 as already decided (Electron, Windows first, built-in browser, translate-as-you-scroll, RT-DETR detection, PaddleOCR-VL via llama-server, Index-Translate-2B via a second llama-server, simple overlay, content-hash cache, NSIS installer, first-run model download from hf-mirror.com). Exclusions: inpainting, glossary editor, third-party API, local folders.
- The app is AGPL-3.0. Each candidate gets an AGPL-3.0 compatibility note. MIT, BSD, Apache-2.0 and (L)GPL-3.0 code can all be combined into an AGPL-3.0 work. GPL-2.0-only code cannot.
- **Verdicts**: *use directly* (add the dependency and call it), *needs adaptation* (port logic or wrap it, with a source/licence header), *must be written ourselves* (nothing suitable exists, or it is too small to be worth a dependency).
- **"LMT"** means libre-manga-translator, https://github.com/mardhianto/libre-manga-translator, AGPL-3.0-or-later (from the repo LICENSE, read on 2026-11-13). The latest release is v1.0.5 (from the releases/latest redirect; the release date is unverified). The local `zh-cn` branch is based on 1.0.4. Port paths below are relative to `libre-manga-translator/src/`. Every ported file gets a header naming the LMT file and commit, plus an entry in `THIRD_PARTY_NOTICES.md`.
- We do **not** port these LMT parts: Latin/Paddle lightweight OCR (`lib/ocr/*`, `lib/gate/*`), the WebLLM and transformers.js engines (`lib/webllm.ts` engine code, `lib/llm-engine.ts`), or the extension/offscreen framework (`entrypoints/background`, `entrypoints/offscreen`, WXT storage and messaging).

### How the facts were checked

| Source | Result |
|---|---|
| npm registry (`registry.npmjs.org/<pkg>`) | Verified: latest version, licence and publish date for every npm package listed below. |
| raw.githubusercontent.com LICENSE files | Verified for llama.cpp (MIT), LMT (AGPL-3.0-or-later), node-tree-kill (MIT), fitty (MIT), manga-image-translator (GPL-3.0), BallonsTranslator (GPL-3.0). |
| GitHub REST API (last commit dates) | **Failed** with HTTP 403 (rate limit). GitHub last-commit dates are therefore marked *unverified*. |
| hf-mirror.com model API | Verified: licence tags and lastModified for the models listed. |
| hf-mirror.com `resolve/` | Verified: returns `Accept-Ranges: bytes` after its 308/307 redirect chain, so HTTP Range resume is possible. Whether a ranged GET on a multi-GB LFS file really returns `206` is still unverified (spike S4). |

## 1. Pipeline and process layout

```
[Shell renderer: address bar, toggles, status]        (Electron renderer, UI only)
[Browse view: WebContentsView, partition persist:browse, injected preload]
      │ IPC: image entered viewport (url, element id, natural size)
      ▼
[Main process] capture → hash → cache lookup ─ hit ─► overlay data
      │ miss
      ▼
[Pipeline scheduler] → detect (onnxruntime-node, utility process)
                     → OCR (llama-server #1, PaddleOCR-VL)
                     → translate (llama-server #2, Index-Translate-2B)
                     → cache write → overlay data → Browse view
[Process manager] owns llama-server #1 and #2 (spawn, health, restart, kill)
[Model manager] first-run download, resume, sha256, model paths
```

Process rules:
- The main process orchestrates. CPU-heavy work (image decode, ONNX detection) runs in an Electron `utilityProcess` so the UI and page never stall.
- Only the shell renderer and the browse view's preload talk to main, via typed IPC with `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. Page scripts never see Node.

## 2. Modules

Table columns: **Lic** = licence, **Maint** = maintenance (npm latest release date, or unverified), **AGPL** = AGPL-3.0 compatibility.

### M1. Built-in browser, session/login persistence, and image capture

**Responsibilities:**
- Address bar, back/forward/reload, and the auto-translate toggle in the shell.
- The browse view (`WebContentsView`) uses `session.fromPartition('persist:browse')`. Cookies, localStorage and logins live in the app's own partition and survive restarts. CAPTCHAs are solved by hand and never automated.
- The injected preload finds manga `<img>` elements (largest `srcset` candidate, `naturalWidth`/`naturalHeight`) and reports them to main.
- Capture order:
  1. Reuse the bytes the browser already loaded, via Chrome DevTools Protocol `Network.getResponseBody` through `webContents.debugger`, matched by URL and request ID.
  2. Otherwise refetch with `session.fetch` on the same partition, with `Referer` set to the page URL. Cookies are attached automatically.
  3. Never take viewport screenshots.
- Canvas-based readers (LMT `untaint.content.ts`) are out of phase 1.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| Electron (`WebContentsView`, `session`, `webContents.debugger`, `session.fetch`) | https://github.com/electron/electron | MIT | 45.3.1, 2026-11-12 | Compatible (MIT) | Use directly |
| LMT image discovery and URL checks: `entrypoints/content/index.ts` (`waitForLaidOutImage`, target-element selection), `lib/security.ts` (`isAllowedImageUrl`), `lib/utils.ts` (`sniffMime`) | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible (same licence family) | Needs adaptation: strip WXT/shadow-UI code and keep only the DOM logic |
| electron-dl (alternative for the refetch path) | https://github.com/sindresorhus/electron-dl | MIT | 5.0.0, 2026-09-20 | Compatible | Not recommended: built for user-facing downloads, and we need in-memory bytes |

**Recommendation:** Electron built-ins plus about 300 lines of our own capture code. Port LMT's image-selection heuristics. Spike S1 (WorkBuddy) must confirm two things on 2-3 real sites:
- `Network.getResponseBody` returns full image bodies for long strips. Raise `maxResourceBufferSize` and `maxTotalBufferSize` in `Network.enable`.
- Attaching the debugger does not break the sites.

Known limit: the debugger detaches when the user opens DevTools on that view. Fall back to `session.fetch` when that happens.

### M2. Page scheduler (translate-as-you-scroll, queue, concurrency)

**Responsibilities:**
- In the page: an IntersectionObserver with a `rootMargin`, plus a MutationObserver for lazy-loaded images. Each image enqueues once.
- In main: a per-stage concurrency limit, priority for the image nearest the viewport, and cancellation when the tab navigates.
- A state machine per image: `idle → pending → done | error`, keyed by content hash.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| LMT `entrypoints/content/auto-translate.ts` (`AutoTranslateQueue`, `AutoTranslateOrchestrator`, `rootMargin: "200px"`) | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible | Needs adaptation: replace `storage.watch` with IPC config |
| LMT `entrypoints/content/translation-registry.ts` (pending/done registry) | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible | Needs adaptation: key by content hash instead of `src` plus page index |
| p-queue | https://github.com/sindresorhus/p-queue | MIT | 10.0.0, 2026-10-12 | Compatible | Use directly in main for per-stage limits and priority (ESM-only, fine with electron-vite) |

**Recommendation:** Port the LMT observer and queue into the preload. In main, use p-queue with these defaults:
- detection: concurrency 1
- OCR: concurrency equal to llama-server #1 `--parallel`
- translation: concurrency equal to llama-server #2 `--parallel`

The pending state is keyed by sha256, so the same image under two URLs runs once.

### M3. Bubble detection

**Responsibilities:**
- Run `ogkalu/comic-text-and-bubble-detector` (RT-DETR-v2, classes `bubble`, `text_bubble`, `text_free`) on onnxruntime-node.
- Letterbox to the model input size, feed `images` and `orig_target_sizes`, and read `labels`, `boxes` and `scores`.
- Slice long strips (`TILE_ASPECT_THRESHOLD = 1.8`, tile 1000 px, overlap 200 px), merge across tiles, and restore boxes to page coordinates.
- **Keep bubble-only boxes.** Do not port the `textBoxes.length > 0 ? textBoxes : bubbleBoxes` selection in `rtdetr.ts` (lines 155 and 210). Instead, pair each bubble with the text boxes inside it. A bubble with no text box is still emitted as an OCR crop.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| onnxruntime-node | https://github.com/microsoft/onnxruntime | MIT | 1.31.1, 2026-10-26 | Compatible | Use directly. CPU EP is the baseline; the DirectML EP on Windows is unverified for this version (spike S2) |
| LMT `lib/detections/rtdetr.ts` (preprocess, tensor layout), `tiling.ts` (`planDetectionTiles`, `mergeTiledBoxes`, `boxIoU`), `utils.ts` (`scalingImage`, `restoreBoundingBox`, `containmentNMS`), `boxes.ts` (`refineDetections`, `mergeCentreInBox`) | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible | Needs adaptation: replace canvas/`ImageData` with sharp raw RGBA buffers and drop the bubble-only filter |
| sharp (decode, resize, crop) | https://github.com/lovell/sharp | Apache-2.0 (prebuilt libvips is LGPL-3.0) | 0.35.5, 2026-09-27 | Compatible (Apache-2.0 and LGPL-3.0 are both GPLv3-compatible) | Use directly. Needs `asarUnpack` in the packaged app |

Model: `ogkalu/comic-text-and-bubble-detector`, Apache-2.0, lastModified 2026-05-15 (verified via the HF API). Default to the 11 MB int8 file, with the file name configurable.

**Recommendation:** Port LMT's detection files almost verbatim onto sharp and onnxruntime-node inside a utility process. Unit-test the tile planning and box restore with fixed fixtures.

### M4. OCR

**Responsibilities:**
- Crop each bubble from the original image with a small padding.
- POST to llama-server #1 at `/v1/chat/completions` with one `image_url` (base64 PNG) and the text prompt `OCR:`, at `temperature` 0.
- Normalise the output and treat empty or whitespace output as "no text".
- Timeout and a single retry per crop.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| llama.cpp `llama-server` (multimodal through `--mmproj`) | https://github.com/ggml-org/llama.cpp | MIT | Tested build b12318 (Windows Vulkan x64). Last commit date unverified (GitHub API 403) | Compatible | Use directly as an external binary |
| `PaddlePaddle/PaddleOCR-VL-1.5-GGUF` (`PaddleOCR-VL-1.5.gguf` 936 MB plus `PaddleOCR-VL-1.5-mmproj.gguf` 882 MB) | https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5-GGUF | Apache-2.0 | lastModified 2026-05-29 | Compatible. Download at first run, do not bundle | Use directly |
| `manga-lab/ocr-vl-test/llamacpp/05_llamacpp_ocr.py` (proven request shape and flags `-ngl 99`) | local | Our own test script | 2026-11-13 | n/a | Reference only. Re-implement in TypeScript |

**Recommendation:** Write a thin TypeScript client of about 100 lines using Node `fetch` (no SDK). Copy only the request shape from the tested script. Start the OCR server with `-c 4096` instead of the 32768 used in the test, to leave VRAM for translation; WorkBuddy confirms the number. `ocr-text.ts` from LMT (`normalizeOcrForPrompt`: rejoin hyphenated line breaks, de-shout all-caps Latin) runs on OCR output before translation; see M5.

### M5. Translation

**Responsibilities:**
- Send each bubble to llama-server #2 at `/v1/chat/completions` (Index-Translate-2B GGUF), using the prompt format from the model card that LMT already implements.
- Include the previous bubbles on the same page as background context.
- Echo guard: if the output looks like the prompt or runs far too long, retry once with the bare prompt, and leave the bubble empty if the retry also fails.
- Cap `max_tokens` by source length.
- Strip `<think>` blocks.
- Empty in, empty out.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| LMT prompt logic: `lib/prompts.ts` (`buildTranslationPrompts`, Chinese style rules), the prompt-only functions in `lib/webllm.ts` (`buildMtBackground`, `buildMtPrompt` Index branch, `looksLikePromptEcho`, `buildBareMtPrompt`, `stripThinking`, `zhLangName`), `lib/ocr-text.ts`, `lib/series-context.ts` (limits, `truncateUtf8`, `isCleanResult`) | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible | Needs adaptation: move them into a pure `prompts/` module. Drop `ensureEngine`, `runPlainChat` and everything else MLC-related |
| `IndexTeam/Index-Translate-2B-GGUF` (official, Q2_K to f16, Q4_K_M included) | https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF | Apache-2.0 | lastModified 2026-10-10 | Compatible. Download at first run | Use directly. WorkBuddy picks the default quant |
| openai (Node SDK) | https://github.com/openai/openai-node | Apache-2.0 | 7.56.0, 2026-11-12 | Compatible | Not needed in phase 1. Plain `fetch` is enough for one local endpoint. Reconsider when third-party APIs arrive |

**Recommendation:**
- Port the prompt functions as pure, unit-tested TypeScript, plus a small OpenAI-compatible `fetch` client shared with M4.
- Model ID, quant file, port, context size, `--parallel` and sampling parameters all come from config (M10), so WorkBuddy's measurements drop in without code changes.
- Series context (the name table and summaries in `series-context-store.ts`) is phase 2. Phase 1 uses only in-page previous bubbles.

### M6. Overlay display

**Responsibilities:**
- For each translated image, mount a positioned overlay layer (Shadow DOM, so site CSS cannot leak in) aligned to the image's rendered box.
- Map natural-size bubble boxes to display size.
- Follow scroll, resize, zoom and layout changes.
- Render translated text fitted to the box (font-size search with wrapping, semi-transparent fill or stroke).
- Global toggles: overlay on/off and show original.
- Use a bundled CJK font (Noto Sans SC, OFL-1.1, to be verified at bundling time).

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| LMT `entrypoints/content/utils.ts` (`syncWrapperGeometry`, `createImageObservers`), `lib/canvas/text-fit.ts` (`calculateFittedTextLayout`, `wrapText`) | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible | Needs adaptation: render DOM text instead of canvas and drop the Svelte `Overlay.svelte`/editor UI |
| fitty | https://github.com/rikschennink/fitty | MIT | 2.4.2, 2023-11-17 (inactive) | Compatible | Fallback only. It fits single lines; multi-line CJK wrapping still needs our own code |

**Recommendation:** Port the LMT geometry sync and the text-fit math, and write a small DOM renderer of our own. Text overlay only, no inpainting (phase 1 exclusion).

### M7. Caching

**Responsibilities:**
- Key: `sha256(image bytes)` + target language + detector model ID + OCR model ID + translation model ID + prompt version.
- Value: boxes, OCR text and translations as JSON.
- Store under `app.getPath('userData')/cache`, never in the install directory.
- Optional raw-bytes cache keyed by URL for the current session only.
- Size limit with LRU eviction, and a "clear cache" action.
- Keep the in-memory state machine from M2 in front of it.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| better-sqlite3 (index and results table) | https://github.com/WiseLibs/better-sqlite3 | MIT | 13.1.1, 2026-11-11 | Compatible | Use directly. Native module: rebuild for Electron with `@electron/rebuild`, the electron-builder default |
| Node `crypto.createHash('sha256')` | https://nodejs.org/api/crypto.html | MIT (Node.js) | Bundled with Electron | Compatible | Use directly. hash-wasm (MIT, 4.13.0, 2026-11-07) is unnecessary in main |
| LMT `translation-registry.ts` `resolveCacheKey` and the `PageCache` shape in `content/index.ts` | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible | Needs adaptation: the LMT key uses series/chapter/page plus a URL hash. We key by content hash and keep series and chapter only as metadata |

**Recommendation:** One SQLite file (`cache.db`) with a `results` table keyed by the composite key. Results are tens of KB, so no blob files are needed. This makes "same image, different URL" a guaranteed hit.

### M8. Model management and download (hf-mirror.com, resume)

**Responsibilities:**
- A model manifest in config. Each entry has: id, repo, file, revision, expected size and sha256, and a role (`detector`, `ocr`, `ocr-mmproj`, `translator`).
- First-run check, then download from `https://hf-mirror.com/<repo>/resolve/<revision>/<file>` with a configurable base URL so `huggingface.co` can be used instead.
- Write to `<file>.part` and resume with `Range: bytes=<size>-`. Accept `206`. On `200`, restart; on `416`, treat the file as complete and verify it.
- Verify sha256, then rename the file atomically.
- Progress events to the UI, pause and cancel, and at most two files in parallel.
- Models live in `userData/models`, or a user-chosen folder, never in the install directory.
- Pin a revision (commit hash) so a re-upload on the hub does not change the file under us.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| Node `fetch` (undici, bundled) plus `fs` streams | https://github.com/nodejs/undici | MIT | 8.12.4, 2026-11-05 | Compatible | Use directly. Our own resume logic is about 200 lines |
| LMT `lib/download-client.ts` (job/snapshot/progress state model), `lib/manifests/hashes.ts` (sha256 pinning idea), `lib/utils.ts` `streamArtifactToCache` and `resolveArtifactUrl` | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible | Needs adaptation: keep the state model and hash pinning. The storage (Cache API, extension messaging) is replaced by files |
| `@huggingface/hub` (JS) | https://github.com/huggingface/huggingface.js | MIT (repo licence; npm entry not checked) | Unverified | Compatible | Not recommended: it adds little over a plain HTTP Range download through a mirror |

**Recommendation:** Write the downloader ourselves on Node `fetch` and port LMT's job state model. Get expected sha256 values from the HF API (`/api/models/<repo>/tree/<rev>`, LFS `oid`) at manifest-authoring time and commit them to the manifest. Spike S4 (WorkBuddy) confirms that hf-mirror honours ranged GETs on the 900 MB GGUF files and measures throughput.

### M9. llama-server process management (Vulkan/CUDA swappable, clean shutdown)

**Responsibilities:**
- Config selects the backend (`vulkan` | `cuda` | `custom`) and the binary directory. Bundled default: the Vulkan Windows x64 build (b12318 tested). CUDA builds are an alternative directory.
- Spawn two instances with explicit flags: `--host 127.0.0.1 --port <cfg>`, `-m`, `--mmproj` (OCR only), `-ngl 99`, `-c`, `--parallel`.
  - Use `child_process.spawn` with `windowsHide: true` and no shell, so the recorded PID is llama-server itself.
- If the configured port is busy, pick a free port and record it. Never attach to someone else's server on that port.
- Health: poll `GET /health` until it reports ready. Restart a crashed server with backoff (at most three restarts per five minutes), then surface an error.
- Shutdown on `before-quit` and `will-quit`:
  1. Stop the queues.
  2. Kill each **recorded PID** and its children (`taskkill /PID <pid> /T /F`).
  3. Await `exit`.
- Never kill by image name (`taskkill /IM` is forbidden).
- Orphan cleanup on next start: a pid file stores `{pid, startTime, exePath}`. Kill only if a live process matches **all three**, which guards against PID reuse.
- Logs: pipe stdout and stderr to M11.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| Node `child_process` plus Windows `taskkill /T` | https://nodejs.org/api/child_process.html | MIT (Node.js) | Bundled | Compatible | Use directly |
| tree-kill | https://github.com/pkrumins/node-tree-kill | MIT | 1.2.2, 2019-12-11 (inactive but stable) | Compatible | Optional. On Windows it only wraps `taskkill /pid X /T /F`, so a five-line helper of our own is equivalent and avoids a stale dependency |
| execa | https://github.com/sindresorhus/execa | MIT | 10.2.1, 2026-10-23 | Compatible | Not needed. `spawn` covers this, and fewer layers means a clearer PID ownership story |
| llama.cpp release binaries (Vulkan, CUDA) | https://github.com/ggml-org/llama.cpp/releases | MIT | `releases/latest` resolved to tag `v0.9.0` on 2026-11-13 (naming change unverified). Tested build: b12318 | Compatible. CUDA builds ship NVIDIA `cudart` DLLs under NVIDIA's redistribution terms, which need a check before bundling | Use directly |

**Recommendation:** Write the process manager ourselves on `child_process`. It is small, and judges will read it. Pin the llama.cpp build in config (`llamaBuild: "b12318"`) and keep the spawn arguments in one place. Optionally add a Windows Job Object later through a tiny native helper; phase 1 relies on explicit PID-tree kill plus the startup orphan check.

### M10. Configuration

**Responsibilities:**
- A typed config with schema validation and defaults: ports, model manifest, llama backend and build path, context sizes, `--parallel`, sampling, concurrency, cache limit, mirror base URL, and UI toggles.
- Stored in `userData/config.json`. Invalid values fall back to defaults with a logged warning.
- The browse view gets read-only IPC access to the subset it needs.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| electron-store | https://github.com/sindresorhus/electron-store | MIT | 12.0.0, 2026-10-12 | Compatible | Use directly (ESM-only) |
| zod | https://github.com/colinhacks/zod | MIT | 4.6.7, 2026-10-12 | Compatible | Use directly for the schema and for IPC payload validation |
| LMT `lib/configs.ts` (default values, model list shape) | LMT repo | AGPL-3.0-or-later | v1.0.5 | Compatible | Reference only. Most entries are WebLLM/ONNX-web models we do not ship |

**Recommendation:** electron-store with a zod schema as the single source of truth. Validate every IPC message with zod at the main-process boundary; page-side messages are untrusted.

### M11. Logging and diagnostics

**Responsibilities:**
- Rotating file logs in `userData/logs`, covering main, utility process and llama-server output.
- Per-image timing (capture, detect, OCR, translate).
- No cookies, auth headers or full image URLs with tokens in the logs; redact query strings.
- An "open log folder" action.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| electron-log | https://github.com/megahertz/electron-log | MIT | 5.4.4, 2026-05-14 | Compatible | Use directly |

**Recommendation:** electron-log plus a small redaction filter of our own. The per-stage timings also give WorkBuddy real-world numbers.

### M12. App shell, build tooling and IPC

**Responsibilities:**
- Electron main, preload scripts (shell and browse view) and the shell renderer.
- TypeScript everywhere, with one typed IPC contract module.
- Dev with hot reload; production build into `out/`.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| electron-vite | https://github.com/alex8088/electron-vite | MIT | 6.0.0, 2026-10-14 | Compatible | Use directly. One config for main, preload and renderer; handles ESM-only deps |
| Electron Forge (alternative) | https://github.com/electron/forge | MIT (unverified for the current release) | Unverified | Compatible | Not recommended, because we already chose electron-builder for NSIS |

**Recommendation:** Use electron-vite with electron-builder. Pick the shell UI framework at implementation time (open question Q7); it does not affect the other modules.

### M13. Packaging and NSIS installer

**Responsibilities:**
- An electron-builder `nsis` target. Per-user install by default; no admin needed.
- `extraResources` holds the llama.cpp Vulkan build and the detector model (11 MB, Apache-2.0, small enough to bundle). The large GGUF models are downloaded by M8.
- `asarUnpack` for native modules: sharp, onnxruntime-node, better-sqlite3.
- `LICENSE` (AGPL-3.0), `THIRD_PARTY_NOTICES.md`, and the model licence texts go into the installer, with an "Open source and licences" entry in the app.
- The uninstaller keeps `userData` (models, cache, logins) unless the user ticks a box.
- Code signing is not planned for phase 1, so SmartScreen will warn.

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| electron-builder (NSIS target) | https://github.com/electron-userland/electron-builder | MIT | 26.18.0, 2026-10-20 | Compatible. The installer stub is NSIS (zlib/libpng licence), which is compatible | Use directly |
| electron-updater | same repo | MIT | 6.8.11, 2026-10-20 | Compatible | Not in phase 1. Keep it in mind for later |

**Recommendation:** electron-builder NSIS with `oneClick: false` and `perMachine: false`. A CI-free local build script is fine for the Kiroween submission.

### M14. Licence and notices compliance (cross-cutting)

**Responsibilities:**
- Every ported LMT file starts with a header in this form:
  `Portions ported from libre-manga-translator <path> @ <commit>, AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.`
- `THIRD_PARTY_NOTICES.md` lists every npm dependency, llama.cpp, the bundled fonts, and each model with its licence.
- A check script fails the build if a production dependency has a licence that is not on an allowlist (MIT, ISC, BSD-*, Apache-2.0, LGPL-3.0, GPL-3.0, AGPL-3.0, OFL-1.1, zlib).

| Candidate | URL | Lic | Maint | AGPL | Verdict |
|---|---|---|---|---|---|
| license-checker-style scan | Unverified (no specific package checked) | Unverified | Unverified | Unverified | Pick at implementation time, or write a 50-line scan of `node_modules/*/package.json` |

### Reference-only projects (do not copy code in phase 1)

| Project | URL | Lic | Notes |
|---|---|---|---|
| manga-image-translator | https://github.com/zyddnys/manga-image-translator | GPL-3.0 (verified LICENSE) | Python. GPL-3.0 can be combined with AGPL-3.0, but there is nothing in it we need for phase 1. Possible reference for later rendering and inpainting work |
| BallonsTranslator | https://github.com/dmMaze/BallonsTranslator | GPL-3.0 (verified LICENSE) | Python/Qt. Reference for text layout ideas only |
| User's old Python project (`Manga-Translator-Extension-v1.0.1`) | local | Unclear (derived from MangaTranslator) | Do not copy code until its licence is clarified |

## 3. Port map from LMT (summary)

| LMT file (`src/…`) | Goes to (proposed) | Notes |
|---|---|---|
| `lib/detections/rtdetr.ts`, `tiling.ts`, `utils.ts`, `boxes.ts` | `src/main/detect/` (utility process) | Remove the bubble-only drop. Replace canvas with sharp |
| `entrypoints/content/auto-translate.ts` | `src/preload/browse/scroll-queue.ts` | Replace WXT storage with IPC |
| `entrypoints/content/translation-registry.ts` | `src/main/pipeline/state.ts` | Content-hash keyed |
| `entrypoints/content/utils.ts` (`syncWrapperGeometry`, `createImageObservers`) | `src/preload/browse/overlay-geometry.ts` | |
| `lib/canvas/text-fit.ts` (layout math only) | `src/preload/browse/text-fit.ts` | |
| `lib/prompts.ts`, prompt-only parts of `lib/webllm.ts`, `lib/ocr-text.ts`, `lib/series-context.ts` (limits, utils) | `src/main/translate/prompts/` | Pure functions with unit tests |
| `lib/download-client.ts`, `lib/manifests/hashes.ts` (state model, pinning) | `src/main/models/` | Storage rewritten on `fs` |
| `lib/security.ts`, `lib/utils.ts` `sniffMime` | `src/main/capture/` | |

Not ported: `lib/ocr/*`, `lib/gate/*`, `lib/webllm.ts` engine code, `lib/llm-engine.ts`, `lib/gpu-runtime.ts`, `lib/hardware.ts`, `lib/ort.ts` (web ORT setup), `entrypoints/background/*`, `entrypoints/offscreen/*`, `entrypoints/popup|setup/*`, `lib/inpaint/*` (phase 1 exclusion), `lib/adapters*` (later phase), `untaint.content.ts` (canvas readers, later phase).

## 4. Work split (Kiro vs WorkBuddy)

WorkBuddy works only under `manga-lab\wb-tests\` and reports results back as data: numbers, logs and short findings. Kiro owns everything in `app/`. Nothing below waits on WorkBuddy: code is written against config, and WorkBuddy's numbers become config defaults later.

### Must be done in this repo with Kiro

Judges inspect `.kiro/` and `app/` source. Specs, hooks, steering and the ported code must be visibly built here.
- `.kiro/specs/` phase-1 requirements, design and tasks (next step after this plan), plus `.kiro/steering/` (licence-header rule, IPC security rules, language rules) and `.kiro/hooks/` (for example, a licence-header check on save, or a unit-test run on change).
- All LMT ports (M2, M3, M5, M6, M7, M8 state model) with source/licence headers and the `THIRD_PARTY_NOTICES.md` entries.
- The process manager (M9), the scheduler and pipeline (M2), capture (M1), the cache (M7), config and IPC contracts (M10, M12), and the packaging config (M13).
- Integration: wiring the stages end to end and running the phase-1 acceptance checks.

### Good candidates for WorkBuddy

Isolated work, no `app/` edits.

| ID | Task | Output feeds |
|---|---|---|
| S0 | Index-Translate-2B GGUF on llama.cpp Vulkan (RX 7700 XT): tokens/s, latency per bubble, VRAM per quant (Q4_K_M, Q5_K_M, Q8_0), `-c` and `--parallel` sweep. Run it alongside the OCR server at `-c 4096` and record total VRAM | M5, M9 defaults |
| S1 | Electron capture spike: does `Network.getResponseBody` return full long-strip images on 2-3 target sites? Does `session.fetch` with `Referer` work when it does not? | M1 |
| S2 | onnxruntime-node CPU vs DirectML EP on the detector model, measuring latency per tile | M3 default EP |
| S3 | llama-server shutdown test: spawn, kill the PID tree, check for orphans; crash and restart loop; port-in-use behaviour | M9 |
| S4 | hf-mirror.com ranged GET on the 900 MB GGUF files: `206` support, interrupt and resume, sha256 match, throughput | M8 |
| S5 | CUDA build smoke test on an NVIDIA machine, if one is available. Otherwise mark it untested in the README | M9, README GPU list |
| S6 | Prompt regression set: 30-50 OCR'd bubbles (ko/en/es) with reference Chinese, a scored run against the ported prompt functions (once Kiro exposes them as a pure module) | M5 |

## 5. Open questions

These need a product decision.

1. **CUDA distribution.** Should the installer bundle only Vulkan, with the CUDA build downloaded on demand (it is large, and the NVIDIA DLL redistribution terms need checking)? Or should there be two installers? Which GPUs will the README list as supported (for example, "AMD RDNA2+ via Vulkan; NVIDIA via CUDA, untested")?
2. **Default translation quant and context.** Pending S0. Is a quality-over-speed default acceptable (Q5_K_M or Q8_0) if VRAM allows?
3. **Batching.** LMT sends one bubble per request, which matches the model card. APP_PLAN.md suggested whole-page batches. Phase 1 plan: per-bubble requests in parallel slots. Confirm, or ask for a batch experiment in S0/S6.
4. **Bubble-only boxes.** When a bubble has no text box inside, should we OCR the whole bubble (proposed), or skip it if OCR returns empty?
5. **Detector bundle vs download.** Bundling the 11 MB int8 model is proposed so detection works offline. Confirm.
6. **Model storage location.** Default `userData/models` (on the C: drive). Should first run offer a folder picker, since the GGUFs are about 3 GB in total?
7. **Shell UI framework.** Plain TS, React or Svelte (LMT uses Svelte 5, which could ease reuse of UI ideas later). There is no UI port in phase 1.
8. **Debugger-based capture.** Is it acceptable that opening DevTools on the browse view disables zero-copy capture for that tab (fallback refetch)?
9. **Cache limits.** Default size cap (proposed 2 GB) and whether to cache raw image bytes across sessions (proposed no: results only).
10. **Product name.** It affects the installer name, `appId`, the `userData` folder name, and the partition name. Renaming after release would orphan user data unless we migrate it, so decide before the first public build.
