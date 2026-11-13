# Phase 1 MVP: design

Implements `requirements.md` (R1–R15). Module choices and port sources are in `.kiro/specs/module-plan/module-plan.md` (M1–M14); this document does not repeat their candidate tables. Layout follows `.kiro/steering/structure.md`.

## 1. Architecture

```
┌──────────────────────── BrowserWindow (shell) ───────────────────────────┐
│ Shell renderer (Svelte 5): address bar, nav, toggles, status, settings  │
│   └─ preload/shell  ── typed IPC ──┐                                      │
│ ┌──────────── WebContentsView (browse, partition persist:browse) ──────┐ │
│ │ website + preload/browse: image discovery, scroll queue, overlay      │ │
│ └───────────────────────────────── typed IPC ─┼──────────────────────┘ │
└────────────────────────────────────────────────┼──────────────────────────┘
                                                 ▼
 Main process: ipc/ → config/ · window/ · pipeline/ · capture/ · cache/ · models/ · llama/
     pipeline: capture → hash → cache ─hit→ overlay
                               └miss→ detect (utilityProcess: onnxruntime-node + sharp)
                                      → OCR (llama-server #1 :18791)
                                      → translate (llama-server #2 :18792)
                                      → cache write → overlay
```

- Main orchestrates; it does no image decoding or ONNX work itself. The detect utility process owns sharp and onnxruntime-node.
- llama-servers are external child processes owned by `main/llama/`.
- Only the two preloads talk to main. Each has its own narrow API.

## 2. App identity and lifecycle (R1)

`app-identity.json` (repo root):

```json
{ "productName": "RawReader", "appId": "app.rawreader.desktop", "userDataDirName": "RawReader" }
```

- `src/shared/app-identity.ts` imports the JSON and exports it typed. `electron-builder.config.mjs` reads the same file for `appId`, `productName` and the NSIS names.
- `src/shared/constants.ts` exports `BROWSE_PARTITION = 'persist:browse'`.
- `main/index.ts`, before `app.whenReady()`:
  `app.setPath('userData', join(app.getPath('appData'), userDataDirName + (app.isPackaged ? '' : '-dev')))`, then `app.setName(productName)`, then `app.requestSingleInstanceLock()` (second instance focuses the first window).
- Quit sequence (R11.6): on the first `before-quit`, call `event.preventDefault()`, run `shutdown()` (stop queues, stop servers, flush config), then call `app.quit()` again with a guard flag. A hard timeout of 10 s forces `app.exit(0)` after the kill attempts.

## 3. Window and browse view (R2, R3)

- `BrowserWindow` loads the shell renderer. Shell toolbar height is a constant (`TOOLBAR_HEIGHT = 48`, `STATUS_HEIGHT = 24`).
- A `WebContentsView` is added to `win.contentView`; main sets its bounds to the area between toolbar and status bar on every `resize`.
- Panels (settings, model setup, licences) render in the shell renderer. When a panel opens, the shell sends `shell:panel-visibility { open: true }` and main calls `browseView.setVisible(false)`; closing restores it.
- Browse `webPreferences`: `partition: BROWSE_PARTITION`, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `preload: out/preload/browse.cjs` (sandboxed preloads are bundled to CJS by electron-vite).
- Session setup (once, on `persist:browse`):
  - `setUserAgent(defaultUA without "Electron/x.y.z" and product tokens)`.
  - `setPermissionRequestHandler((_, __, cb) => cb(false))` and `setPermissionCheckHandler(() => false)`.
  - `will-download`: phase 1 cancels downloads and posts a status message.
- Navigation guards on the browse `webContents`:
  - `will-navigate` / `will-redirect`: allow only `http:` / `https:`.
  - `setWindowOpenHandler(({ url }) => { if (isHttp(url)) view.webContents.loadURL(url); return { action: 'deny' } })`.
- `did-navigate`, `did-navigate-in-page`, `page-title-updated` push `browse:state { url, title, canGoBack, canGoForward, loading }` to the shell.
- Shell window: `contextIsolation`, `sandbox`, no Node; CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` (Svelte injects styles, so `'unsafe-inline'` is needed for styles only).
- Address bar normalisation is a pure function `normalizeAddress(input): { ok: true, url } | { ok: false, reason }`:
  trim → if it has a scheme, parse with `URL`, accept `http(s)` only → else if it looks like a host (contains a dot or is `localhost`, no spaces), prefix `https://` → else reject (no search engine in phase 1).
- Last URL is stored in `ui.lastUrl` on `did-navigate` (redacted query strings are not applied here: the URL is stored locally only and never logged).

## 4. Configuration (R14)

`src/shared/config/schema.ts` defines the zod schema; `defaults` come from `schema.parse({})`. `main/config/store.ts` wraps electron-store (`name: 'config'`, `cwd` = userData).

```ts
const ServerCommon = z.object({
  port: z.number().int().min(1024).max(65535),
  ctxSize: z.number().int().positive(),
  nGpuLayers: z.number().int().min(0).default(99),
  parallel: z.number().int().min(1).default(1),
  flashAttn: z.enum(['on', 'off', 'auto']).default('auto'),   // 'auto' = omit flag
  alias: z.string(),
  extraArgs: z.array(z.string()).default([]),
  autostart: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ui: z.object({
    autoTranslate: z.boolean().default(false),
    overlayVisible: z.boolean().default(true),
    lastUrl: z.string().nullable().default(null),
  }).default({}),
  llama: z.object({
    build: z.string().default('b12318'),
    backend: z.enum(['vulkan', 'cuda', 'custom']).default('vulkan'),
    binDirs: z.object({
      vulkan: z.string().nullable().default(null),  // null = <resources>/llama/vulkan
      cuda: z.string().nullable().default(null),    // null = <userData>/llama/cuda-<build>
      custom: z.string().nullable().default(null),
    }).default({}),
    startupTimeoutMs: z.number().int().default(120_000),
    ocr: ServerCommon.extend({ port: ...default(18791), ctxSize: ...default(4096), alias: ...default('PaddleOCR-VL-1.5') }),
    translate: ServerCommon.extend({
      port: ...default(18792), ctxSize: ...default(8192), alias: ...default('Index-Translate-2B'),
      flashAttn: ...default('on'), temp: z.number().default(0), reasoning: z.enum(['on','off']).default('off'),
    }),
  }).default({}),
  models: z.object({
    dir: z.string().nullable().default(null),        // null = <userData>/models
    paths: z.object({                                // explicit per-role overrides
      detector: z.string().nullable().default(null), // null = bundled copy
      ocr: z.string().nullable().default(null),
      ocrMmproj: z.string().nullable().default(null),
      translator: z.string().nullable().default(null),
    }).default({}),
    autoDownload: z.boolean().default(true),
    mirrors: z.object({
      huggingface: z.string().url().default('https://hf-mirror.com'),
      modelscope: z.string().url().default('https://modelscope.cn'),
    }).default({}),
  }).default({}),
  pipeline: z.object({
    detectConcurrency: z.literal(1).default(1),
    ocrConcurrency: z.number().int().min(1).nullable().default(null),       // null = llama.ocr.parallel
    translateConcurrency: z.number().int().min(1).nullable().default(null), // null = llama.translate.parallel
    minImageSize: z.number().int().default(200),
    rootMarginPx: z.number().int().default(200),
    maxImageBytes: z.number().int().default(50 * 1024 * 1024),
    readingDirection: z.enum(['ltr', 'rtl']).default('ltr'),
    maxBoxImageCoverage: z.number().gt(0).max(1).default(0.85), // boxes covering >= this share of the image are dropped
  }).default({}),
  translate: z.object({
    targetLang: z.literal('zh-Hans').default('zh-Hans'),
    promptVariant: z.enum(['lmt', 'baseline']).default('lmt'),
    contextUnits: z.number().int().min(0).default(3),
  }).default({}),
  cache: z.object({ maxBytes: z.number().int().default(2 * 1024 ** 3) }).default({}),
});
```

(`...default(x)` is shorthand for overriding the field default in the extension.)

Loading (`loadConfig`):

1. Read raw stored JSON. Parse with `ConfigSchema.safeParse`. On failure, walk the zod issues, delete each invalid path from the raw object, log a warning per path, and parse again (falls back to defaults field by field).
2. If `!app.isPackaged`: read `dev.config.json` from the repo root (or `RAWREADER_DEV_CONFIG`), then `dev.config.local.json` if present. Resolve relative paths against the repo root. Deep-merge over the stored config **in memory only**. The overlay is never written back.
3. Writes go through `updateConfig(patch)`: merge, validate, persist the non-overlay part, broadcast `config:changed` to the shell.

`dev.config.json` (committed, relative to repo root; existing files only, never downloaded):

```json
{
  "llama": { "backend": "vulkan", "binDirs": { "vulkan": "../ocr-vl-test/llamacpp/bin" } },
  "models": {
    "autoDownload": false,
    "paths": {
      "detector": "../ocr-vl-test/models/detector-v4-s_int8.onnx",
      "ocr": "../ocr-vl-test/llamacpp/models/PaddleOCR-VL-1.5.gguf",
      "ocrMmproj": "../ocr-vl-test/llamacpp/models/PaddleOCR-VL-1.5-mmproj.gguf",
      "translator": "../wb-tests/models/Index-Translate-2B.Q4_K_M.gguf"
    }
  }
}
```

Effective path resolution (`resolveModelPath(role)`): explicit `paths[role]` → `<models.dir or userData/models>/<manifest file>` → for `detector`, the bundled `<resources>/detector/<file>`. A missing file returns `{ missing: true, expectedPath }`; it never starts a download by itself.

## 5. Typed IPC (R14)

`src/shared/ipc/contract.ts` declares every channel once:

```ts
export const ipc = {
  // shell → main (invoke)
  'browse:navigate':      { req: z.object({ input: z.string().max(4096) }), res: NavResult },
  'browse:go':            { req: z.object({ action: z.enum(['back', 'forward', 'reload', 'stop']) }), res: z.void() },
  'shell:panel-visibility': { req: z.object({ open: z.boolean() }), res: z.void() },
  'config:get':           { req: z.void(), res: ConfigSchema },
  'config:update':        { req: ConfigPatchSchema, res: ConfigSchema },
  'llama:status':         { req: z.void(), res: z.array(ServerStatus) },
  'llama:control':        { req: z.object({ role: z.enum(['ocr', 'translate']), action: z.enum(['start', 'stop', 'restart']) }), res: ServerStatus },
  // browse preload → main (later slices)
  'page:images':          { req: PageImagesBatch, res: z.void() },
} as const;

export const events = {           // main → renderer (send)
  'browse:state': BrowseState,
  'config:changed': ConfigSchema,
  'llama:status': ServerStatus,
  'pipeline:progress': PageProgress,   // later slices
  'overlay:result': OverlayResult,     // to browse preload, later slices
} as const;
```

- `ConfigPatchSchema` allows only user-editable fields (UI toggles, llama server fields, backend, model paths, mirrors, concurrency, cache cap). It is a deep-partial of a whitelisted sub-schema.
- `main/ipc/register.ts` exposes `handle(channel, allowedSenders, fn)`. It checks `event.sender.id` against the shell or browse `webContents.id`, parses `req` with zod, runs `fn`, and returns `{ ok: true, value } | { ok: false, error: { code, message } }`. Uncaught errors become `{ code: 'INTERNAL' }` and are logged.
- `preload/shell/index.ts` builds a typed `window.rawreader` from the contract (`invoke(channel, req)`, `on(event, cb)` returning an unsubscribe). Types come from `z.infer`, so renderer calls are checked at compile time.
- The browse preload exposes nothing to the page (`contextBridge` is not used there). It talks to main with `ipcRenderer` inside the isolated world only.

## 6. llama-server process manager (R11, R12)

Files in `main/llama/`: `args.ts` (pure), `backend.ts` (pure + fs check), `pidfile.ts`, `win-process.ts`, `server.ts` (one instance), `manager.ts` (both).

### Binary resolution (`backend.ts`)

| backend | directory |
|---|---|
| `vulkan` | `binDirs.vulkan` ?? `process.resourcesPath/llama/vulkan` (packaged) |
| `cuda` | `binDirs.cuda` ?? `userData/llama/cuda-<build>` |
| `custom` | `binDirs.custom` (required) |

Executable is `<dir>/llama-server.exe`. Missing → status `error` with code `BINARY_MISSING`.

### Arguments (`args.ts`, pure)

```ts
buildArgs('ocr', cfg, paths) =
  ['-m', paths.ocr, '--mmproj', paths.ocrMmproj, '--host', '127.0.0.1', '--port', String(port),
   '--ctx-size', String(ctxSize), '-np', String(parallel), '-ngl', String(nGpuLayers),
   ...flashAttnArgs, '--alias', alias, ...extraArgs]

buildArgs('translate', cfg, paths) =
  ['-m', paths.translator, '--host', '127.0.0.1', '--port', String(port), '--temp', String(temp),
   '-ngl', String(nGpuLayers), '--ctx-size', String(ctxSize), '-np', String(parallel),
   '--flash-attn', flashAttn, '--reasoning', reasoning, '--alias', alias, ...extraArgs]
```

`flashAttn: 'auto'` omits the flag. `extraArgs` may not contain `--host` or `--port` (rejected by validation) so the bind address cannot be widened.

### Lifecycle (`server.ts`)

States: `stopped → starting → ready`, `starting|ready → error`, any → `stopping → stopped`.

`start()`:
1. Resolve exe and model paths. Missing → `error` (`MODEL_MISSING` / `BINARY_MISSING`).
2. Port: try binding a `net.Server` on `127.0.0.1:<port>`; if `EADDRINUSE`, bind port 0, read the assigned port, close, and use that (R11.4). Record `effectivePort` in status.
3. `spawn(exe, args, { cwd: dirname(exe), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })`.
4. Pipe stdout/stderr to `userData/logs/llama-<role>.log` (append, size-capped rotate at 10 MB).
5. Query start time and exe path for `child.pid` (see `win-process.ts`) and write `userData/run/llama-<role>.pid.json` `{ pid, startTime, exePath, port }`.
6. Poll `GET http://127.0.0.1:<port>/health` every 500 ms; `200` → `ready`; `503` → keep waiting; timeout (`startupTimeoutMs`) → kill tree → `error` (`STARTUP_TIMEOUT`).
7. On `exit` while not `stopping`: `error`, then restart with backoff 2 s, 5 s, 15 s; more than 3 crashes in 5 minutes → stay in `error` (`CRASH_LOOP`).

`stop()`: state `stopping`; `killTree(pid)`; await `exit` (5 s timeout; if it does not fire, check the process is gone via `win-process.ts`); delete the pid file; `stopped`.

### Windows process helpers (`win-process.ts`)

- `assertPid(pid)`: positive safe integer, else throw. Called before every use.
- `killTree(pid)`: `spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false })`. Exit code 128 (not found) counts as success. `/IM` is never used anywhere in the codebase.
- `getProcessInfo(pid)`: `spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,ExecutablePath,@{n='Start';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`])`, after `assertPid`. Returns `{ exePath, startTime } | null`. The pid is the only interpolated value and is a validated integer.

### Orphan check (startup, before any spawn)

For each `run/llama-*.pid.json`: parse with zod (invalid → delete file). `info = getProcessInfo(pid)`. If `info` exists **and** `info.startTime === file.startTime` **and** `normalizeCase(info.exePath) === normalizeCase(file.exePath)`, then `killTree(pid)` and log it; otherwise only delete the file. The decision is a pure function `shouldKillOrphan(file, info)`, unit-tested.

### Manager

`manager.startAll()` starts OCR and translation in parallel when `autostart` and files exist. `manager.stopAll()` is awaited by the quit sequence. A backend or server-config change triggers `restart(role)`. Status changes are broadcast as `llama:status`.

### CUDA on demand (later slice)

`models/cuda.ts` downloads `https://github.com/ggml-org/llama.cpp/releases/download/b12318/llama-b12318-bin-win-cuda-12.4-x64.zip` and `.../cudart-llama-bin-win-cuda-12.4-x64.zip` with the same resumable downloader (§10), extracts both into `userData/llama/cuda-b12318/` with Windows `tar.exe -xf <zip> -C <dir>` (spawned with an args array), checks that `llama-server.exe` exists, and sets `backend: 'cuda'`. The UI states the download may need a proxy; `net.fetch` honours the system proxy. Asset URLs are verified with a HEAD request when this task is implemented.

## 7. Capture (R4, later slice)

`main/capture/`:
- `cdp.ts`: on browse view creation, `webContents.debugger.attach('1.3')`, `Network.enable({ maxResourceBufferSize: 64 MB, maxTotalBufferSize: 512 MB })`. Keep an LRU map `url → requestId` from `Network.responseReceived` where `type === 'Image'` (cap 2000 entries, cleared on main-frame navigation). On `detach` (DevTools opened), mark CDP unavailable for that view.
- `capture(url, pageUrl)`: CDP `Network.getResponseBody({ requestId })` → decode base64 → else `session.fetch(url, { headers: { Referer: pageUrl } })` on `persist:browse` (http/https/data only) → `sniffMime` (ported from LMT `lib/utils.ts`) → size check → `{ bytes, mime }`.
- `blob:` URLs work only through CDP; if CDP fails for a blob URL, the image errors with `CAPTURE_UNAVAILABLE`.
- Ported: `isAllowedImageUrl` (LMT `lib/security.ts`), `sniffMime`.

## 8. Pipeline and scheduling (R5, later slice)

- Browse preload (`preload/browse/scroll-queue.ts`, ported from LMT `auto-translate.ts`): IntersectionObserver (`rootMargin` from config) + MutationObserver for new images; picks the largest `srcset` candidate and natural size; filters by `minImageSize`; assigns each element a `data-rr-id`; sends `page:images` batches `{ docId, images: [{ elId, url, naturalW, naturalH, distance }] }`.
- `docId` is a random id regenerated on every main-frame navigation; main drops results whose `docId` is stale (R5.5).
- `main/pipeline/scheduler.ts`: one p-queue per stage (`detect`, `ocr`, `translate`); priority = `-distance`. Per image: capture → `sha256` → in-flight map by hash (joins duplicates, R5.4) → cache lookup → detect → OCR units → translate units → cache write → `overlay:result` to every element waiting on that hash.
- `main/pipeline/state.ts` (ported from LMT `translation-registry.ts`): state per hash `pending | done | error`, plus element subscriptions per `docId`.
- Turning auto-translate off clears queued tasks (`queue.clear()`), running tasks finish and their results are cached but not rendered.

## 9. Detection, OCR, translation (R6–R8, later slice)

### Detection (`main/detect/`, utility process)

- `worker.ts` is the `utilityProcess` entry; messages are `{ id, bytes } → { id, units } | { id, error }` validated with zod on both sides.
- Ported from LMT `lib/detections/`: `rtdetr.ts` (preprocess, tensor layout), `tiling.ts` (`planDetectionTiles`, `mergeTiledBoxes`, `boxIoU`), `utils.ts` (`scalingImage`, `restoreBoundingBox`, `containmentNMS`), `boxes.ts` (`refineDetections`, `mergeCentreInBox`). Canvas/`ImageData` is replaced by sharp raw RGB buffers. The `textBoxes.length > 0 ? textBoxes : bubbleBoxes` selection is **not** ported.
- Whole-image filter (`coverage.ts`, ours, pure): after `finalizeDetections` and before `buildUnits`, bubble and text boxes whose area is at least `pipeline.maxBoxImageCoverage` (default 0.85) of the image area are dropped as whole-image false positives (header logos, covers). The threshold travels through `PipelineSettings` → `DetectJob` → worker message → `DetectOptions`, and is part of the cache identity (`+cov<ratio>`).
- Unit building (`units.ts`, ours, pure):
  - For each bubble, collect text boxes whose centre lies inside it.
  - Bubble with text boxes → unit `{ kind: 'bubble', drawBox: bubble, ocrBox: union(textBoxes) }`.
  - Bubble with none → `{ kind: 'bubble', drawBox: bubble, ocrBox: bubble }`.
  - Remaining text boxes → `{ kind: 'free', drawBox: text, ocrBox: text }`.
  - Sort by row bands (band height = 0.5 × median unit height), then x (`ltr`) or −x (`rtl`).
- Detector ID for the cache key: file name + file size.

### Shared LLM client (`main/llm/chat.ts`)

`chat({ port, model, messages, maxTokens, temperature, signal, timeoutMs })` posts to `http://127.0.0.1:<port>/v1/chat/completions` with Node `fetch`, reads `choices[0].message.content` (string or text parts), and returns `{ text } | { error }`. There is no `/completion` code path.

### OCR (`main/ocr/`)

Crop `ocrBox` + 8 px padding with sharp (in the utility process, returned as PNG bytes alongside units). Request: one user message with `[{ type: 'image_url', image_url: { url: 'data:image/png;base64,…' } }, { type: 'text', text: 'OCR:' }]`, `temperature: 0`, timeout 30 s, 1 retry. Output → `normalizeOcrForPrompt` (ported from LMT `lib/ocr-text.ts`).

### Translation (`main/translate/`)

- `prompts/` (pure, ported from LMT `lib/prompts.ts`, prompt-only parts of `lib/webllm.ts`: `buildMtBackground`, `buildMtPrompt` Index branch, `looksLikePromptEcho`, `buildBareMtPrompt`, `stripThinking`, `zhLangName`; limits and `truncateUtf8` from `lib/series-context.ts`).
- Context: the source text of up to `contextUnits` previous units on the same image, truncated. Source-only context keeps requests independent, so units run in parallel and results are deterministic for caching.
- `max_tokens = min(256, max(48, len(source) × 3))`, `temperature: 0`.
- Echo guard: `looksLikePromptEcho(output, source)` (prompt section markers, instruction phrases, or `len(output) > len(source) × 4 + 60`) → retry once with `buildBareMtPrompt` → still bad → empty translation, unit flagged `echo`.
- `promptVariant: 'baseline'` uses the WorkBuddy-verified smoke prompt (no context, no style rules) as a regression fallback for S6:
  `请将以下{src}文本翻译为简体中文，直接输出翻译结果，不要进行任何解释。\n\n{text}` (with `{src}` empty).
- `PROMPT_VERSION` constant (for example `lmt-1` / `baseline-1`) is part of the cache key.

## 10. Models (R13, later slice)

`main/models/manifest.ts` (committed):

| role | repo | file | size | sha256 |
|---|---|---|---|---|
| detector | ogkalu/comic-text-and-bubble-detector | detector-v4-s_int8.onnx (bundled) | ~11 MB | fill from HF API |
| ocr | PaddlePaddle/PaddleOCR-VL-1.5-GGUF | PaddleOCR-VL-1.5.gguf | 935,768,992 | fill from HF API |
| ocrMmproj | PaddlePaddle/PaddleOCR-VL-1.5-GGUF | PaddleOCR-VL-1.5-mmproj.gguf | 881,770,496 | fill from HF API |
| translator | IndexTeam/Index-Translate-2B-GGUF | Index-Translate-2B.Q4_K_M.gguf | 1,312,164,352 | `044b313d29342bd3b2c77cbb64023ca0d209bd9b3247763f9d162767ef2d746a` |

Each entry also pins `revision` (commit hash) and a `modelscope` repo id (verified at implementation time; if none exists, the fallback is skipped for that file).

Downloader (`download.ts`, ours, state model ported from LMT `lib/download-client.ts`):
- URL: `<huggingface mirror>/<repo>/resolve/<revision>/<file>`; fallback `<modelscope>/models/<msRepo>/resolve/master/<file>` after 3 failed attempts on the primary.
- Write `<file>.part`; resume with `Range: bytes=<size>-`; `206` → append, `200` → truncate and restart, `416` → verify. Stream through `crypto.createHash('sha256')` on resume by first hashing the existing part.
- Verify size and sha256, then `rename` atomically. Max 2 parallel files; pause = abort and keep `.part`.
- Uses `net.fetch` (system proxy). Never runs when `models.autoDownload` is false; dev config sets it false.
- User-picked files: verify size, then sha256 in the background; remember `{ path, size, mtimeMs, ok }` so a file is hashed once.

## 11. Overlay (R9, later slice)

`preload/browse/overlay.ts`: per image a fixed-position host element with a closed Shadow DOM, `pointer-events: none`, positioned by ported LMT `syncWrapperGeometry` and `createImageObservers` (ResizeObserver + scroll/resize listeners, rAF-throttled). Boxes are scaled `display / natural`. Text fit ports the math of LMT `lib/canvas/text-fit.ts` (`calculateFittedTextLayout`, `wrapText`) and measures with an offscreen canvas using the bundled Noto Sans SC (OFL-1.1, loaded via `FontFace` from a `data:` URL so page CSP does not block it). `overlayVisible: false` toggles a `hidden` class on all hosts.

## 12. Cache (R10, later slice)

`userData/cache/cache.db` (better-sqlite3, WAL):

```sql
CREATE TABLE results (
  key TEXT PRIMARY KEY,          -- sha256(content) | lang | detectorId | ocrModelId | mtModelId | promptVersion
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL,         -- JSON: units (boxes, ocr, translation, flags), image natural size
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_access INTEGER NOT NULL
);
CREATE INDEX results_lru ON results(last_access);
```

On insert, if `SUM(bytes) > maxBytes`, delete by `last_access` until under 90 % of the cap. No image bytes are stored. "Clear cache" runs `DELETE FROM results; VACUUM`.

## 13. Packaging (R15)

`electron-builder.config.mjs` (basic version in the skeleton, extras later):

```js
import identity from './app-identity.json' with { type: 'json' };
export default {
  appId: identity.appId,
  productName: identity.productName,
  directories: { output: 'release' },
  files: ['out/**', 'package.json'],
  asarUnpack: ['**/node_modules/sharp/**', '**/node_modules/@img/**',
               '**/node_modules/onnxruntime-node/**', '**/node_modules/better-sqlite3/**'],
  extraResources: [ /* later: resources/llama/vulkan → llama/vulkan, resources/detector → detector */ ],
  win: { target: 'nsis' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
};
```

Later: `scripts/fetch-resources.mjs` copies or downloads the Vulkan build and detector into `resources/` (never from the dev folders in CI), `scripts/check-licenses.mjs` enforces the allowlist, NSIS custom page/checkbox for removing userData, licences viewer.

## 14. Logging (R15.8)

Skeleton: llama-server output to `userData/logs/llama-<role>.log`; main uses `console` plus a small `log()` wrapper. Later slice: electron-log with a redaction hook (strip query strings and fragments from URLs, drop `Cookie`/`Authorization` values) and per-image timings `{ hashPrefix, captureMs, detectMs, ocrMs, translateMs, units }`.

## 15. Testing strategy

| Layer | Tests |
|---|---|
| Pure (skeleton) | `normalizeAddress`, config schema defaults and invalid-field fallback, dev overlay path resolution, `buildArgs` (both roles, `flashAttn: 'auto'`, rejection of `--host`/`--port` in `extraArgs`), `shouldKillOrphan`, `assertPid`, IPC sender check and payload validation |
| Windows integration (skeleton, `*.win.test.ts`) | spawn `node -e "setInterval(()=>{},1000)"` with a child of its own, `killTree`, assert both are gone via `getProcessInfo` |
| Later pure | tiling plan, box restore, unit building (bubble-only kept), prompt builders, echo guard, `max_tokens`, cache key, LRU eviction, Range resume state machine |
| Manual smoke | start/stop both real servers via `npm run dev` with `dev.config.json`; confirm no `llama-server` process remains (check by recorded PID) |

## 16. Risks and open items

- Co-load VRAM of OCR + translation is unmeasured (S0 remainder): all server parameters are config; if VRAM is short, lower OCR `-ngl` or ctx first.
- CDP capture on long strips is unverified (S1); fetch fallback covers failures.
- DirectML EP is unverified (S2); CPU EP is the default.
- hf-mirror ranged GET on multi-GB files unverified (S4).
- CUDA build untested on NVIDIA hardware (S5).
- Native module rebuilds (better-sqlite3) may fetch Electron headers or prebuilds from GitHub; if the proxy budget is a problem, set `npm_config_disturl`/prebuild mirrors at that task.
