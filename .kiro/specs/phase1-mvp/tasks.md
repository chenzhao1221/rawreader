# Phase 1 MVP: tasks

Each task lists its requirements (R…) and design section (§…). A task is done when its check passes and `npm run typecheck`, `npm test` and `npm run build` still pass.

**Slices**
- **[SKELETON]**: the next coding session does only tasks 1–9. Nothing outside this slice is implemented in that session.
- **[LATER]**: remaining phase-1 work, in suggested order.

Do not commit or push unless asked. Never modify the sibling folders (`../ocr-vl-test`, `../wb-tests`, `../libre-manga-translator`, `../translate-test`) or MultiDraft paths.

---

## Skeleton slice

- [x] 1. **[SKELETON] Scaffold** (§2, tech.md)
  - [x] 1.1 Add `.npmrc` with `registry=https://registry.npmmirror.com` only. Set `ELECTRON_MIRROR` and `ELECTRON_BUILDER_BINARIES_MIRROR` in the shell before installing.
  - [x] 1.2 Create the electron-vite + Svelte 5 + TypeScript project: `package.json` (`"type": "module"`, pinned versions, licence `AGPL-3.0-only`), `electron.vite.config.ts` with entries `main`, `preload/shell`, `preload/browse` (CJS output for sandboxed preloads), `renderer`.
  - [x] 1.3 `tsconfig.node.json` / `tsconfig.web.json` with `strict: true`; scripts `dev`, `build`, `typecheck` (tsc both projects + `svelte-check`), `test` (`vitest run`), `dist:dir`, `dist`.
  - [x] 1.4 Add `vitest.config.ts` (node environment, `src/**/*.test.ts`, `*.win.test.ts` skipped when `process.platform !== 'win32'`).
  - [x] 1.5 Add `.gitignore` entries: `resources/llama/`, `resources/detector/`, `dev.config.local.json`.
  - Check: `npm install` succeeds through the mirrors; `npm run dev` opens an empty window; `npm run build` writes `out/`.
  - _R1, NF6_

- [x] 2. **[SKELETON] App identity and lifecycle** (§2)
  - [x] 2.1 `app-identity.json` and `src/shared/app-identity.ts`; `src/shared/constants.ts` with `BROWSE_PARTITION`.
  - [x] 2.2 `main/index.ts`: userData path from identity (`-dev` suffix when unpackaged) set before ready, single-instance lock, guarded `before-quit` shutdown sequence with a 10 s hard timeout.
  - Check: dev run creates `%APPDATA%\RawReader-dev\`; a second launch focuses the first window.
  - _R1.1–R1.2, R11.6_

- [x] 3. **[SKELETON] Config module** (§4)
  - [x] 3.1 `src/shared/config/schema.ts`: zod schema with all defaults from §4 (ports 18791/18792, ctx 4096/8192, `-ngl 99`, `-np 1`, translate `flashAttn: 'on'`, `reasoning: 'off'`, `temp: 0`, aliases, backend `vulkan|cuda|custom`, binDirs, model paths, mirrors, cache 2 GB, UI toggles).
  - [x] 3.2 `main/config/store.ts`: electron-store wrapper, field-level fallback on invalid values with warnings, `updateConfig(patch)` with validation and `config:changed` broadcast.
  - [x] 3.3 Dev overlay: `dev.config.json` (content from §4, pointing at the existing files), optional `dev.config.local.json` and `RAWREADER_DEV_CONFIG`; paths resolved against the repo root; never persisted.
  - [x] 3.4 `resolveModelPath(role)` returning a path or `{ missing, expectedPath }`; never downloads.
  - [x] 3.5 Tests: defaults snapshot, invalid-field fallback, overlay merge and path resolution, overlay not written to the store.
  - Check: in dev, `config:get` shows absolute paths to the five existing local files, and `models.autoDownload` is false.
  - _R14.1–R14.3, R13.7_

- [x] 4. **[SKELETON] Typed IPC** (§5)
  - [x] 4.1 `src/shared/ipc/contract.ts` with the skeleton channels: `browse:navigate`, `browse:go`, `shell:panel-visibility`, `config:get`, `config:update`, `llama:status`, `llama:control`; events `browse:state`, `config:changed`, `llama:status`.
  - [x] 4.2 `main/ipc/register.ts`: sender check, zod validation, `{ ok, value } | { ok: false, error: { code, message } }` results.
  - [x] 4.3 `preload/shell/index.ts`: typed `window.rawreader.invoke/on` via `contextBridge`; global type declaration for the renderer.
  - [x] 4.4 Tests: invalid payload rejected, wrong sender rejected, handler errors mapped to `INTERNAL`.
  - _R14.4–R14.5_

- [x] 5. **[SKELETON] Main window, address bar and browse view** (§3)
  - [x] 5.1 `main/window/`: `BrowserWindow` for the shell; `WebContentsView` on `persist:browse` with secure `webPreferences`; bounds follow window resize; hide/show on `shell:panel-visibility`.
  - [x] 5.2 Session setup: user agent without `Electron/` and product tokens, permissions denied, downloads cancelled with a status message.
  - [x] 5.3 Navigation guards: http(s) only on navigate/redirect; `setWindowOpenHandler` loads http(s) URLs in the same view and denies new windows.
  - [x] 5.4 Pure `normalizeAddress()` with tests (scheme-less host, `localhost`, rejected `file:`/`javascript:`, text with spaces).
  - [x] 5.5 Shell renderer (Svelte 5): address bar, back/forward/reload/stop, title, status bar; strings in `src/renderer/src/i18n/zh-CN.ts`; strict CSP in `index.html`.
  - [x] 5.6 Persist and restore `ui.lastUrl`.
  - [x] 5.7 Empty `preload/browse` entry (built and attached, exposes nothing) so later slices only add code.
  - Check: log in to a site, quit, restart: still logged in. `window.open` stays in the same view. `about:blank`-style or `file:` input shows an error.
  - _R2.1–R2.11, R1.3–R1.4_

- [x] 6. **[SKELETON] Auto-translate and overlay toggles (UI only)** (§3, §4)
  - [x] 6.1 Two toggles in the toolbar bound to `ui.autoTranslate` and `ui.overlayVisible` via `config:update`; state survives restart.
  - [x] 6.2 Status area shows the llama server states and, when auto-translate is on, a placeholder notice that the pipeline is not wired yet.
  - Check: toggles persist; no pipeline code is added.
  - _R3.1, R3.3 (UI only), R3.4 (status only)_

- [x] 7. **[SKELETON] llama-server process manager** (§6)
  - [x] 7.1 `llama/backend.ts`: binary directory resolution for `vulkan|cuda|custom`; `BINARY_MISSING` error.
  - [x] 7.2 `llama/args.ts` (pure) for both roles exactly as in §6; reject `--host`/`--port` in `extraArgs`. Tests compare against the WorkBuddy launch flags.
  - [x] 7.3 `llama/win-process.ts`: `assertPid`, `killTree` (`taskkill /PID <pid> /T /F`, shell false), `getProcessInfo` (CIM query with a validated integer PID). No `/IM` anywhere (add a test that greps `src/` for `/IM`).
  - [x] 7.4 `llama/pidfile.ts`: zod-validated `{ pid, startTime, exePath, port }` under `userData/run/`; pure `shouldKillOrphan(file, info)` with tests (all match, PID reused with different start time, different exe, no process).
  - [x] 7.5 `llama/server.ts`: free-port fallback, spawn (`windowsHide`, no shell), log piping to `userData/logs/llama-<role>.log` with 10 MB rotation, pid file write, `/health` polling with timeout, crash restart with backoff (3 per 5 min), `stop()` awaiting exit.
  - [x] 7.6 `llama/manager.ts`: startup orphan check, `startAll` when files exist and `autostart`, `stopAll` awaited by the quit sequence, restart on relevant config change, `llama:status` broadcasts, `llama:control` handler.
  - [x] 7.7 Windows integration test (`*.win.test.ts`): spawn a Node process that spawns a child, `killTree`, assert both PIDs are gone.
  - Check: unit and Windows tests pass; with no models configured the app starts and shows `MODEL_MISSING` without crashing.
  - _R11.1–R11.10, R12.1, R12.3_

- [x] 8. **[SKELETON] Kiro hooks** (structure.md)
  - [x] 8.1 Add one or two hooks in `.kiro/hooks/` (for example: run `npm run typecheck` on `src/**/*.ts|svelte` save; run `npm test` on `*.test.ts` save). Confirm the hook file format against current Kiro docs before writing.
  - [x] 8.2 `.kiro/hooks/README.md`: trigger, action, whether it injects prompts into the agent, and how to disable it during bulk implementation.
  - _NF6_

- [x] 9. **[SKELETON] Verification**
  - [x] 9.1 `npm run typecheck`, `npm test`, `npm run build` pass. `npm run dist:dir` with the basic `electron-builder.config.mjs` from §13 (no extraResources yet) produces `release/win-unpacked/`.
  - [x] 9.2 Add `THIRD_PARTY_NOTICES.md` listing the skeleton dependencies with licences.
  - [x] 9.3 Optional smoke: `npm run dev` with `dev.config.json`; both servers reach `ready` using the existing Vulkan binary and models; quit; confirm by recorded PID (`Get-Process -Id <pid>`) that neither llama-server remains. If a process remains, kill it by its PID only. _(not run by the bulk session: no visible app windows were allowed; the headless smokes cover the same ground. Run once by hand.)_
  - _NF5, NF6, R15.7_

---

## Later phase-1 work

- [x] 10. **[LATER] Logging** (§14): electron-log, redaction filter with tests, "open log folder" action. _R15.8_
- [x] 11. **[LATER] Capture** (§7)
  - [x] 11.1 CDP attach, `Network.enable` buffer sizes, `url → requestId` LRU, detach handling.
  - [x] 11.2 `session.fetch` fallback with `Referer`; port `isAllowedImageUrl` and `sniffMime` with headers; size limit.
  - [x] 11.3 Tests for MIME sniff and URL checks; manual check on 2–3 real sites (S1 findings). _(unit tests done; the real-site check is manual, see the acceptance list.)_
  - _R4.1–R4.7_
- [x] 12. **[LATER] Browse preload scroll queue** (§8): port LMT `auto-translate.ts` (IntersectionObserver, MutationObserver, srcset choice), `docId` per navigation, `page:images` channel. _R5.1–R5.3, R5.5_
- [x] 13. **[LATER] Detection utility process** (§9)
  - [x] 13.1 Utility process with zod message schema; onnxruntime-node CPU EP session for the detector.
  - [x] 13.2 Port `rtdetr.ts`, `tiling.ts`, `utils.ts`, `boxes.ts` onto sharp, without the bubble-only drop; licence headers and notices.
  - [x] 13.3 `units.ts`: bubble/text pairing, bubble-only units, free text units, reading order.
  - [x] 13.4 Tests with fixed fixtures: tile plan for a tall strip, box restore, merge across tiles, bubble-only bubble kept.
  - _R6.1–R6.7_
- [x] 14. **[LATER] LLM client and OCR** (§9): `llm/chat.ts` (`/v1/chat/completions` only), OCR crop + request + retry, port `normalizeOcrForPrompt`; tests with a mocked fetch. _R7.1–R7.4_
- [x] 15. **[LATER] Translation** (§9)
  - [x] 15.1 Port LMT prompt functions into `translate/prompts/` with headers; `PROMPT_VERSION`.
  - [x] 15.2 Context from previous units' source, `max_tokens` cap, `stripThinking`, echo guard with bare retry, empty in/empty out.
  - [x] 15.3 `baseline` prompt variant (WorkBuddy smoke prompt).
  - [x] 15.4 Unit tests for every prompt builder and the echo guard; expose the module for the S6 regression run.
  - _R8.1–R8.7_
- [x] 16. **[LATER] Pipeline scheduler** (§8): p-queues per stage with priority, in-flight join by hash, state machine (port `translation-registry.ts`), cancellation on navigation and toggle-off, `pipeline:progress`. _R3.2, R5.4–R5.7_
- [x] 17. **[LATER] Overlay** (§11): Shadow DOM hosts, ported geometry sync and text fit, bundled Noto Sans SC (verify OFL-1.1), `overlayVisible` toggle, `pointer-events: none`. _R9.1–R9.5, R3.3_ _(unit tests plus `npm run smoke:overlay` in a hidden window; alignment on a live site is a manual check.)_
- [x] 18. **[LATER] Cache** (§12): better-sqlite3 (check the Electron rebuild works through the mirrors), key builder, LRU eviction to 90 %, "clear cache" in settings; tests for key and eviction. _R10.1–R10.5_
- [x] 19. **[LATER] Model manager** (§10)
  - [x] 19.1 Manifest with pinned revisions and sha256 from the HF API; verify ModelScope repo ids.
  - [x] 19.2 Resumable downloader (Range, 206/200/416 handling, sha256, atomic rename, 2 parallel, pause/cancel) on `net.fetch`; state-machine tests with a local HTTP server.
  - [x] 19.3 First-run setup panel: folder picker, per-file "use existing file", progress; background hash of user files. _(downloader tested against a local HTTP server only; no real model was downloaded.)_
  - _R13.1–R13.7_
- [x] 20. **[LATER] CUDA backend download** (§6): verify asset URLs with HEAD, download both zips, extract with `tar.exe`, switch backend, fallback to Vulkan on failure, proxy notice in UI. _R12.2–R12.4_ _(tested with a local server and tiny zips plus the real `tar.exe`; a real CUDA download on an NVIDIA machine is a manual check.)_
- [x] 21. **[LATER] Settings panel**: server parameters, backend, model paths, mirrors, concurrency, cache cap, server start/stop/restart. _R11.10, R14.1_
- [x] 22. **[LATER] Packaging and compliance** (§13)
  - [x] 22.1 `scripts/fetch-resources.mjs` for the Vulkan build and detector into `resources/`; `extraResources` mapping.
  - [x] 22.2 NSIS: per-user, `oneClick: false`, keep userData by default with an opt-in removal checkbox. _(the uninstaller asks whether to remove user data via a Yes/No box in `build/installer.nsh`, default No; it is not a checkbox. The prompt itself was compiled into the installer but not run.)_
  - [x] 22.3 `scripts/check-licenses.mjs` allowlist check in the build; complete `THIRD_PARTY_NOTICES.md` (deps, llama.cpp, font, models, all LMT ports); in-app licences view.
  - [ ] 22.4 Install on a clean Windows user account and run the acceptance checks.
  - _R15.1–R15.7_
- [ ] 23. **[LATER] Phase-1 acceptance**
  - [ ] 23.1 End to end on 2–3 real sites: login persists, scroll translates nearest first, bubble-only bubbles translated, overlay toggle works, cached pages render instantly.
  - [ ] 23.2 No llama-server left after normal quit, forced crash/restart, and the next start's orphan check.
  - [ ] 23.3 Record per-stage timings against NF2.
  - _NF1–NF6_
