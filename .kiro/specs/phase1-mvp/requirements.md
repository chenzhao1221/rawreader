# Phase 1 MVP: requirements

Scope and decisions come from `.kiro/steering/product.md` and `.kiro/specs/module-plan/module-plan.md`. Requirements use EARS patterns ("WHEN … THE SYSTEM SHALL …", "WHILE …", "IF … THEN …"). "The system" means RawReader. Module references (M1–M14) point at the module plan.

## Glossary

- **Shell**: the Svelte renderer with the address bar, toggles, status and settings.
- **Browse view**: the `WebContentsView` that shows the website, using partition `persist:browse`.
- **Unit**: one translatable region: a bubble (with or without text boxes inside) or a free text box outside any bubble.
- **OCR server / translation server**: llama-server #1 (PaddleOCR-VL-1.5) and #2 (Index-Translate-2B).
- **Content hash**: sha256 of the captured image bytes.

---

## R1. App identity and shell window

**User story:** As a maintainer, I want the product name and IDs in one place, so a rename before release is a one-line change.

1. THE SYSTEM SHALL read `productName`, `appId` and `userDataDirName` from a single app-identity source used by both the runtime and the electron-builder config.
2. THE SYSTEM SHALL set the userData path from that source before the app `ready` event, appending `-dev` when the app is not packaged.
3. WHEN the app starts, THE SYSTEM SHALL open one main window containing the shell toolbar and the browse view below it.
4. THE SYSTEM SHALL show all UI text in Simplified Chinese, taken from one string table.

## R2. Built-in browser and address bar (M1)

**User story:** As a reader, I want to open my comic sites in the app and stay logged in.

1. WHEN the user submits text in the address bar, THE SYSTEM SHALL normalise it to a URL (add `https://` when no scheme is given) and load it in the browse view.
2. IF the normalised URL is not `http:` or `https:`, THEN THE SYSTEM SHALL refuse to load it and show an error in the shell.
3. THE SYSTEM SHALL provide back, forward and reload controls whose enabled state follows the browse view's history.
4. WHEN the browse view navigates (including in-page and redirect navigations), THE SYSTEM SHALL update the address bar with the current URL and the window title with the page title.
5. THE SYSTEM SHALL use `session.fromPartition('persist:browse')` for the browse view, so cookies, localStorage and logins persist across restarts.
6. WHEN a page calls `window.open` or follows a `target=_blank` link with an `http(s)` URL, THE SYSTEM SHALL load it in the same browse view and SHALL NOT open a new window.
7. WHEN a page requests a permission (notifications, camera, geolocation and similar), THE SYSTEM SHALL deny it.
8. THE SYSTEM SHALL send a user agent without `Electron/` or product tokens on the browse partition.
9. THE SYSTEM SHALL configure the browse view with `contextIsolation`, `sandbox` and no Node integration; page scripts SHALL NOT reach any Node or IPC API.
10. WHILE a shell panel (settings, model setup) is open, THE SYSTEM SHALL hide the browse view so the panel is not covered.
11. WHEN the app restarts, THE SYSTEM SHALL reopen the last visited URL.

## R3. Auto-translate toggle and overlay toggle

**User story:** As a reader, I want one switch to start translating and one to see the original.

1. THE SYSTEM SHALL show an auto-translate toggle in the shell and persist its state in config.
2. WHEN auto-translate is turned on, THE SYSTEM SHALL start translating images on the current page per R5; WHEN it is turned off, THE SYSTEM SHALL stop enqueuing new images and cancel queued (not running) work.
3. THE SYSTEM SHALL show a global overlay toggle; WHEN it is off, THE SYSTEM SHALL hide all overlays and show the original page without discarding results.
4. WHILE auto-translate is on and a required server or model is unavailable, THE SYSTEM SHALL show the reason in the shell status area.

## R4. Image capture (M1)

**User story:** As a reader, I want translation to use the image already on screen, without extra downloads or screenshots.

1. WHEN an image is selected for translation, THE SYSTEM SHALL first try to get its bytes through CDP `Network.getResponseBody` for the matching request.
2. IF the bytes are not available through CDP (debugger detached, body evicted, no matching request), THEN THE SYSTEM SHALL fetch the image with `session.fetch` on `persist:browse` with `Referer` set to the page URL.
3. THE SYSTEM SHALL NOT capture viewport screenshots.
4. THE SYSTEM SHALL accept only JPEG, PNG, WebP, GIF (first frame) and AVIF, identified by content sniffing, and SHALL reject bodies above a configurable size limit (default 50 MB).
5. THE SYSTEM SHALL accept image URLs only with `http:`, `https:` or `data:` schemes for the fetch fallback.
6. THE SYSTEM SHALL keep captured bytes in memory only and SHALL release them when the image's pipeline run ends.
7. IF the user opens DevTools on the browse view, THEN THE SYSTEM SHALL continue with the fetch fallback.

## R5. Translate-as-you-scroll scheduling (M2)

**User story:** As a reader, I want images to be translated as I reach them, nearest first.

1. WHILE auto-translate is on, THE SYSTEM SHALL detect candidate `<img>` elements entering the viewport (with a margin, default 200 px) and lazily added images.
2. THE SYSTEM SHALL ignore images smaller than a configurable minimum (default 200 × 200 natural pixels).
3. THE SYSTEM SHALL enqueue each image at most once per page load and process images nearest the viewport first.
4. WHEN two images have the same content hash, THE SYSTEM SHALL run the pipeline once and apply the result to both.
5. WHEN the browse view navigates to a new document, THE SYSTEM SHALL cancel queued work for the old page and SHALL NOT apply late results to the new page.
6. THE SYSTEM SHALL limit concurrency per stage: detection 1, OCR and translation each equal to configured values (default: the server's `-np`).
7. THE SYSTEM SHALL track each image as `pending → done | error` and show per-page progress (done / total) in the shell.

## R6. Bubble detection (M3)

**User story:** As a reader, I want every speech bubble found, including tall webtoon strips.

1. THE SYSTEM SHALL run the RT-DETR detector `ogkalu/comic-text-and-bubble-detector` (int8 ONNX) on onnxruntime-node inside a utility process.
2. THE SYSTEM SHALL port LMT preprocessing (letterbox, `images` + `orig_target_sizes` inputs), output decoding, and box restore to original image coordinates.
3. WHEN the image aspect ratio (height / width) exceeds 1.8, THE SYSTEM SHALL tile it (tile 1000 px, overlap 200 px), detect per tile, and merge boxes across tiles.
4. THE SYSTEM SHALL keep bubble boxes that contain no text box and SHALL NOT port LMT's rule that discards bubble boxes when any text box exists.
5. THE SYSTEM SHALL build units: a bubble with its contained text boxes, a bubble with no text box (OCR'd as the whole bubble), and free text boxes outside any bubble.
6. THE SYSTEM SHALL order units by reading order (top to bottom, then left to right; right to left when configured).
7. IF the detector fails to load or run, THEN THE SYSTEM SHALL mark the image as `error` and keep the app responsive.

## R7. OCR (M4)

**User story:** As a reader, I want the text in each bubble read correctly.

1. FOR each unit, THE SYSTEM SHALL crop the OCR region from the original image with padding (default 8 px, clipped to the image) and encode it as PNG.
2. THE SYSTEM SHALL send the crop to the OCR server at `POST /v1/chat/completions` with one `image_url` (base64 data URL) and the text `OCR:`, at temperature 0.
3. THE SYSTEM SHALL normalise OCR output (trim, ported LMT `normalizeOcrForPrompt`) and treat empty output as "no text".
4. IF an OCR request times out or fails, THEN THE SYSTEM SHALL retry once and then mark the unit as failed without failing the whole image.

## R8. Translation (M5)

**User story:** As a reader, I want natural Simplified Chinese per bubble, quickly.

1. THE SYSTEM SHALL send one `POST /v1/chat/completions` request per unit to the translation server and SHALL NOT use `/completion`.
2. THE SYSTEM SHALL translate units of one image in parallel, bounded by the configured translation concurrency.
3. THE SYSTEM SHALL build prompts with the ported LMT logic: Index-Translate prompt format, Chinese style rules, and in-page context from the previous units' source text (bounded count and length).
4. THE SYSTEM SHALL cap `max_tokens` at `min(256, max(48, sourceLength × 3))` and strip `<think>` blocks from output.
5. IF the output looks like a prompt echo or is far longer than the source, THEN THE SYSTEM SHALL retry once with the bare prompt; IF the retry also fails the check, THEN THE SYSTEM SHALL leave the unit untranslated.
6. WHEN the OCR text of a unit is empty, THE SYSTEM SHALL skip the request and produce an empty translation.
7. THE SYSTEM SHALL keep the verified WorkBuddy smoke prompt available as a `baseline` prompt variant selectable in config, for regressions (S6).

## R9. Overlay (M6)

**User story:** As a reader, I want the Chinese text drawn where the bubble is.

1. WHEN an image has results, THE SYSTEM SHALL render an overlay in a Shadow DOM layer aligned to the image's rendered box.
2. THE SYSTEM SHALL map natural-size unit boxes to the displayed size and keep them aligned on scroll, resize, zoom and layout change.
3. THE SYSTEM SHALL fit translated text inside the box (font-size search with CJK wrapping) on a semi-opaque background, using a bundled CJK font.
4. THE SYSTEM SHALL draw bubble units in the bubble box and free text units in the text box.
5. THE SYSTEM SHALL NOT intercept pointer events on the page (links and reader controls keep working).

## R10. Cache (M7)

**User story:** As a reader, I want pages I've seen to show translations instantly, without the app filling my disk.

1. THE SYSTEM SHALL key results by content hash + target language + detector ID + OCR model ID + translation model ID + prompt version.
2. WHEN a captured image's key is in the cache, THE SYSTEM SHALL skip detection, OCR and translation and render the stored result.
3. THE SYSTEM SHALL store only results (boxes, OCR text, translations) and SHALL NOT store raw image bytes on disk.
4. WHEN the cache exceeds its cap (default 2 GB), THE SYSTEM SHALL evict least-recently-used entries until it is under 90 % of the cap.
5. THE SYSTEM SHALL provide a "clear cache" action in settings.

## R11. llama-server process management (M9)

**User story:** As a user, I want the app to start and stop its model servers without leaving processes behind.

1. WHEN the app starts and the required model files exist, THE SYSTEM SHALL spawn the OCR server and the translation server with arguments built from config, bound to `127.0.0.1`.
2. THE SYSTEM SHALL spawn with no shell and `windowsHide: true`, and record each child's PID, start time and executable path in a pid file under userData.
3. THE SYSTEM SHALL report a server as ready only after `GET /health` returns 200, within a configurable timeout (default 120 s).
4. IF the configured port is in use, THEN THE SYSTEM SHALL pick a free port, use it for that run, and SHALL NOT attach to a server it did not spawn.
5. IF a server exits unexpectedly, THEN THE SYSTEM SHALL restart it with backoff, at most 3 times in 5 minutes, then show an error.
6. WHEN the app quits, THE SYSTEM SHALL stop the queues, run `taskkill /PID <pid> /T /F` for each recorded PID, wait for exit (timeout 5 s), delete the pid files, and then exit.
7. THE SYSTEM SHALL NOT kill processes by image name.
8. WHEN the app starts and a pid file exists, THE SYSTEM SHALL kill the recorded process tree only if a live process matches the PID, start time and executable path; otherwise it SHALL delete the stale pid file.
9. THE SYSTEM SHALL write each server's stdout and stderr to a log file under userData.
10. THE SYSTEM SHALL show each server's state (stopped, starting, ready, error) in the shell, with start/stop/restart controls in settings.

## R12. Backend selection (M9)

**User story:** As an NVIDIA user, I want to switch to CUDA; as an AMD/Intel user, Vulkan should just work.

1. THE SYSTEM SHALL support backends `vulkan` (bundled, default), `cuda` and `custom` (a user-chosen folder containing `llama-server.exe`).
2. WHEN the user selects CUDA and the CUDA build is missing, THE SYSTEM SHALL offer to download `llama-b12318-bin-win-cuda-12.4-x64.zip` and `cudart-llama-bin-win-cuda-12.4-x64.zip` from the llama.cpp GitHub release, extract them into `userData/llama/cuda-b12318/`, and tell the user the download may need a proxy.
3. WHEN the backend changes, THE SYSTEM SHALL restart both servers with the new binary.
4. IF the CUDA build fails to reach ready, THEN THE SYSTEM SHALL show the error and offer to switch back to Vulkan.

## R13. Models (M8)

**User story:** As a new user, I want the models set up on first run, and as an existing user, I want to reuse files I already have.

1. WHEN a required model file is missing at startup, THE SYSTEM SHALL show a first-run model setup panel listing the files, sizes and target folder.
2. THE SYSTEM SHALL let the user choose the model folder or point at existing files for each role (OCR, OCR mmproj, translator, detector override).
3. WHEN downloading, THE SYSTEM SHALL use hf-mirror.com first and ModelScope as fallback, resume from `<file>.part` with HTTP Range, verify sha256 against the manifest, and rename atomically.
4. THE SYSTEM SHALL show progress and allow pause, resume and cancel; at most two files download at once.
5. THE SYSTEM SHALL bundle the detector in the installer and SHALL NOT download it unless the user deletes or overrides it.
6. WHEN a user-provided file fails size or hash verification, THE SYSTEM SHALL warn and let the user use it anyway or pick another file.
7. WHILE running in dev, THE SYSTEM SHALL use the existing local model files from the dev config and SHALL NOT download models.

## R14. Configuration and IPC (M10, M12)

**User story:** As an engineer, I want typed, validated config and IPC so WorkBuddy's numbers drop in without code changes.

1. THE SYSTEM SHALL define config with a zod schema including defaults: llama backend, binary directories, build, per-server port, ctx size, `-ngl`, `-np`, flash-attn, reasoning, alias, extra args, model paths, model folder, mirror URLs, concurrency, cache cap and UI toggles.
2. IF stored config fails validation, THEN THE SYSTEM SHALL fall back to defaults for the invalid fields and log a warning.
3. WHILE not packaged, THE SYSTEM SHALL apply `dev.config.json` (paths relative to the repo root) as a non-persisted overlay on top of stored config.
4. THE SYSTEM SHALL define every IPC channel in one shared contract with zod schemas for payloads and results.
5. WHEN main receives an IPC message, THE SYSTEM SHALL validate its payload and its sender, and reject invalid messages with a `{ code, message }` error.

## R15. Packaging, licences and logging (M11, M13, M14)

1. THE SYSTEM SHALL build an NSIS installer with electron-builder: per-user, `oneClick: false`, install directory selectable.
2. THE SYSTEM SHALL bundle the llama.cpp Vulkan build and the detector model as extra resources, and SHALL NOT bundle GGUF models.
3. THE SYSTEM SHALL unpack native modules (sharp, onnxruntime-node, better-sqlite3) from asar.
4. THE SYSTEM SHALL ship `LICENSE`, `THIRD_PARTY_NOTICES.md` and model licence texts, and show them from an "open source licences" entry in the app.
5. WHEN uninstalling, THE SYSTEM SHALL keep userData unless the user chooses to remove it.
6. THE SYSTEM SHALL fail the build if a production dependency's licence is not on the allowlist.
7. EVERY ported LMT file SHALL start with the source/licence header and have a `THIRD_PARTY_NOTICES.md` entry.
8. THE SYSTEM SHALL write rotating logs under `userData/logs` with per-image stage timings, and SHALL redact query strings, cookies and auth headers.

## Non-functional requirements

- **NF1 Responsiveness:** Decoding and detection run off the main thread; the shell and page stay interactive while translating.
- **NF2 Performance target (Vulkan, RX 7700 XT class GPU):** a typical page with 10 bubbles shows translations within 5 s of entering the viewport once servers are ready. Translation is about 0.1 s per bubble (measured).
- **NF3 Privacy:** No telemetry. Network calls are limited to the browsed sites and user-approved model/backend downloads.
- **NF4 Offline:** After models are present, translation works without internet.
- **NF5 Robustness:** No llama-server process remains after normal quit, crash-restart or the next start's orphan check.
- **NF6 Quality gate:** `npm run typecheck`, `npm test` and `npm run build` pass on every change.
