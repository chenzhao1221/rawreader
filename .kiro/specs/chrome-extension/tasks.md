# Chrome extension line: tasks

Each task lists its requirements (ER…) and design section (§…). A task is done when its check passes. App-side tasks also require that root `npm run typecheck`, `npm test` and `npm run build` still pass.

**Slices**
- **[SKELETON]**: the next coding session (phase 2) implements tasks 1–10. This is the app-side bridge (off by default) plus an `extension/` package that forwards images to the app and draws the result. Optional direct-Gemini work is not in this slice.
- **[LATER]**: optional direct Gemini mode and polish, in suggested order.

Do not commit or push unless asked. Never modify `master`, the sibling folders (`../ocr-vl-test`, `../wb-tests`, `../libre-manga-translator`, `../translate-test`) or MultiDraft paths. Never copy `ImageTrans.pem` or any ImageTrans source into this repository. Do not write adult-site names or URLs into any file. Tests must be headless: no window, tray, browser or llama-server; kill only PIDs the session started, and never touch Ollama PID 38644.

---

## Skeleton slice

- [ ] 1. **[SKELETON] Config: bridge defaults** (§4.1)
  - [ ] 1.1 Extend `src/shared/config/schema.ts` with `bridge: { enabled: false, port: 18793, startHidden: false, extensionId: null }` and zod `prefault({})` so old configs load.
  - [ ] 1.2 Add tests that a missing `bridge` field becomes the defaults and `bridge.enabled === false`.
  - Check: existing config tests still pass; default snapshot includes the new field, off by default.
  - _ER1.1, ER1.3, §8_

- [ ] 2. **[SKELETON] Pairing code** (§4.1)
  - [ ] 2.1 `src/main/bridge/pairing.ts`: generate a 16-character Crockford base32 code from injected random bytes; format for display; constant-time compare.
  - [ ] 2.2 Store the secret under the name `bridge` in `src/main/secrets/store.ts` (create on first show if missing).
  - [ ] 2.3 Unit tests for format, compare (match / mismatch / length mismatch), and that generation uses the injected source.
  - Check: no real secret is hardcoded; tests do not read the userData store on disk.
  - _ER6.1, ER6.2, ER10_

- [ ] 3. **[SKELETON] Guards and protocol** (§4.1, §4.2)
  - [ ] 3.1 `src/main/bridge/guards.ts`: Host must be a loopback form; Origin must be `chrome-extension://<id>` and match the recorded id once set; Authorization bearer must match the pairing code; rate-limit auth failures with an injected clock.
  - [ ] 3.2 `src/main/bridge/protocol.ts`: zod `strict` schemas for `POST /translate` and the ping/translate responses; `toBridgeResult`.
  - [ ] 3.3 `src/main/bridge/context.ts`: cap and hash series context with existing `truncateUtf8`.
  - [ ] 3.4 Table-driven guard tests and schema tests (good/bad host, origin, bearer, body).
  - Check: a request with a non-loopback Host or a non-extension Origin is rejected before any body is considered.
  - _ER2.1–ER2.8, ER3, ER4, ER6.3, ER10_

- [ ] 4. **[SKELETON] HTTP server** (§4.1, §4.2)
  - [ ] 4.1 `src/main/bridge/server.ts`: `node:http` server that `listen`s on `127.0.0.1` only (never `0.0.0.0`); routes `GET /ping` and `POST /translate`; CORS headers for the recorded extension origin; streamed body cap; `req.on('close')` aborts work; JSON errors from §4.2.
  - [ ] 4.2 Dependencies injected (`translate`, `ping`, `pairing`, `logger`).
  - [ ] 4.3 `src/main/bridge/server.test.ts`: real server on `127.0.0.1:0`, Node `fetch` as the client, fake `translate`/`ping`. Covers status codes, CORS, body cap, abort on client close. No Electron, no windows.
  - Check: binding a non-loopback address is impossible through the public API; `/translate` without a valid pairing code returns 401.
  - _ER2, ER3, ER4, ER10, §8_

- [ ] 5. **[SKELETON] Pipeline `translateBytes`** (§4.3)
  - [ ] 5.1 Add `Pipeline.translateBytes(bytes, { priority, signal, context, boxes })` that enters after capture: hash, cache lookup, detect, OCR, translate, cache store; same queues, settings and in-flight de-duplication by content hash.
  - [ ] 5.2 Does not touch `DocState`, `submit`, `setEnabled` or delivery; the desktop auto-translate toggle does not gate bridge work.
  - [ ] 5.3 `options.boxes` skips detection; such results skip the cache store.
  - [ ] 5.4 `options.context` goes to the translator; `contextHash` is appended to the cache identity only when context is present so plain requests still share the desktop cache.
  - [ ] 5.5 New tests with fake stages: cache hit, store, boxes bypass, context in cache key, abort, priority. Existing pipeline tests must pass without edits.
  - Check: `npm test` at the repo root is green, including every previously existing desktop test.
  - _ER4.3–ER4.6, ER1.2, §8_

- [ ] 6. **[SKELETON] Bridge lifecycle, default off** (§4.4)
  - [ ] 6.1 `src/main/bridge/index.ts`: `startBridge` / `stopBridge`; reacts to enable/port changes; abort in-flight work on stop or disable.
  - [ ] 6.2 `src/main/index.ts` starts the bridge only when `bridge.enabled` is true, after config and pipeline wiring; shutdown stops the bridge first, then the existing sequence.
  - [ ] 6.3 Tests: default config never calls `listen`; startup with defaults leaves nothing listening.
  - Check: a default-config unit or integration test proves the HTTP server is not started.
  - _ER1.1, ER1.4, §8_

- [ ] 7. **[SKELETON] Tray and settings UI** (§4.4, §4.1)
  - [ ] 7.1 When enabled, closing the window hides to the tray (existing hint once); `startHidden` skips the first `show()`.
  - [ ] 7.2 Settings IPC (registered only in `src/main/ipc`): status, show code, regenerate code; shell sender only.
  - [ ] 7.3 `BridgeTab.svelte` plus zh-CN strings: enable toggle, port, show/copy/regenerate code, recorded extension ID, status. Use theme.css variables and existing UI parts.
  - Check: typecheck and unit tests around the IPC handlers; no GUI is launched in tests.
  - _ER5, ER6, ER1.2_

- [ ] 8. **[SKELETON] `extension/` package scaffold** (§5.4)
  - [ ] 8.1 Create `extension/` as a separate npm package (`AGPL-3.0-only`, own lockfile, `.npmrc` to npmmirror, scripts `dev`/`build`/`typecheck`/`test`/`zip`).
  - [ ] 8.2 WXT + TypeScript + Svelte 5; `vitest.config.ts`; `.gitignore` includes `node_modules/`, `.output/`, `.wxt/`, `*.pem`, `*.crx`.
  - [ ] 8.3 `extension/THIRD_PARTY_NOTICES.md` and `extension/README.md` (English unpacked-load and pairing steps). Root `NOTICE` and root `THIRD_PARTY_NOTICES.md` already describe the LMT source; keep them in sync if versions are pinned.
  - [ ] 8.4 Root tsconfig / vitest / electron-builder continue to ignore `extension/`. Add `src/main/bridge/isolation.test.ts` (or equivalent) that asserts this.
  - Check: `cd extension && npm test` and `npm run typecheck` can run independently of the desktop build.
  - _ER11, ER12, §5.4, §8_

- [x] 9. **[SKELETON] Import LMT client surface, wire the bridge** (§1.3, §5)
  - [x] 9.1 Copy only the keep/change LMT files listed in §1.3 from `../libre-manga-translator` at commit 1ddddc7, each with a header naming the LMT path, the commit, AGPL-3.0-or-later, and that RawReader modified it. Do not copy WebLLM, in-browser OCR models, the setup wizard, or model-download management.
  - [x] 9.2 Replace `requestBubbleDetection` / `requestTextTranslation` with a bridge client: `POST /translate` (and memoised second call when boxes are unchanged, or a follow-up with `boxes` when the user edited them). Failed units become empty translations so existing skip/paint paths still work.
  - [x] 9.3 Options page (replaces setup): connection state, typography/inpaint/site rules, about/licences. (Port and pairing code were removed in task 13.)
  - [x] 9.4 Extension unit tests for the bridge client mapping and memo logic; port existing LMT tests that still apply. happy-dom is allowed; no real Chrome and no real RawReader window.
  - Check: `cd extension && npm test` passes; a documented manual step can load the WXT output unpacked in Chrome and pair with a running app, but that manual step is not part of default CI.
  - _ER7, ER8, ER6, ER11, ER12_

- [x] 10. **[SKELETON] Gate: desktop tests still all pass** (§8)
  - [x] 10.1 From the repo root, run `npm run typecheck`, `npm test` and `npm run build` headless. Every previously existing desktop test must pass.
  - [x] 10.2 Confirm `bridge.enabled` defaults to false and a default startup path does not listen. (Superseded by task 13: the bridge is now on by default.)
  - [x] 10.3 Confirm no adult-site names or URLs were added, and no `.pem` was committed.
  - Check: the three root commands exit 0; `git status` is only the intended files on branch `extension`.
  - _ER1, ER12_

- [x] 13. **[DONE] Auto-connect: no pairing code, no manual port** (supersedes ER1, ER6 and the pairing parts of ER2)
  - [x] 13.1 App: `bridge.enabled` defaults to true; the bridge starts with the app on 127.0.0.1, port 18793, then 18794-18797 when taken; the settings tab keeps the on/off switch and start-hidden, and shows the port in use. `bridge.port` and `bridge.extensionId` are removed from the config.
  - [x] 13.2 App: `pairing.ts`, the pairing secret, the rate limiter and the `bridge:code` / `bridge:regenerate` IPC channels are removed. `guards.ts` accepts only `Origin: chrome-extension://<BRIDGE_EXTENSION_ID>` (403 for any other Origin or none); CORS is granted to that origin only.
  - [x] 13.3 Extension: the manifest `key` comes from `extension/extension-key.json` so the ID is stable; a root unit test derives the ID from the key and compares it with `src/shared/bridge.ts`.
  - [x] 13.4 Extension: `probeBridge` tries the cached port, then 18793-18797, on `GET /ping` at browser start and before every translation; the popup shows "请先打开 RawReader" when nothing answers. The options page lost the port and code fields and keeps a connection check.
  - [x] 13.5 Tests and docs: guards, server, lifecycle (default on, port fallback), schema, IPC, extension client and settings tests; `extension/README.md`.
  - Check: root `npm run typecheck`, `npm test`, `npm run build` and `cd extension && npm test && npm run typecheck && npm run build` all pass.

---

## Later slice

- [x] 11. **[DONE] Direct API mode** (§7, ER9; supersedes the "direct Gemini behind a flag" idea)
  - [x] 11.1 Backend choice in the options page: RawReader / direct API / auto (default: RawReader when running and ready, else the configured API, else a Chinese hint and the options page opens). `src/lib/direct/select.ts`.
  - [x] 11.2 Providers: Gemini (native `generateContent`) and OpenAI-compatible (`/chat/completions`) with presets for Gemini, Zhipu GLM-4V-Flash and SiliconFlow plus a custom entry; base URL, key and model editable. `src/lib/direct/providers.ts`, `request.ts`.
  - [x] 11.3 One request does detection, reading and translation: the image is shrunk (2048 px, about 3.5 MB), the prompt asks for JSON boxes (0-1000) and translations in the existing target language; the answer is mapped to the bridge response shape so `BridgeMemo` and the overlay are reused. No in-browser detector, onnxruntime or WASM, so the build flag from ER9.2 is not needed. `prompt.ts`, `image.ts`, `client.ts`.
  - [x] 11.4 Tolerant parser: fences, chatter, other key names, `box_2d`, pixel or fraction coordinates, cut-off answers; plain text becomes one translation in a banner box; items without boxes are stacked. `parse.ts`.
  - [x] 11.5 Privacy: key only in `chrome.storage.local`, read only by the background worker and options page, sent in a header, scrubbed from error messages, never logged. Manifest `host_permissions` gains the three preset API hosts; `optional_host_permissions` plus a run-time `permissions.request` cover custom Base URLs (https, or http for loopback).
  - [x] 11.6 Tests with mocked `fetch` (no real API): request construction, response parsing, degradation, errors and key scrubbing, image shrinking, backend selection. `extension/tests/unit/direct-*.test.ts`.
  - Check: `cd extension && npm test && npm run typecheck && npm run build` pass. Not covered by tests: the browser image codec (`OffscreenCanvas`) and the options form; try them by hand with a real key.
  - Note: ER9.1 and ER10 text about "OpenAI-compatible endpoints only through the app" and "only to 127.0.0.1 or Gemini" is superseded: in direct mode images go to the API host the user configured.

- [ ] 12. **[LATER] End-to-end opt-in test** (§8)
  - `RAWREADER_E2E=1` only; still no unnecessary windows; not part of default `npm test`.

---

## Manual trial (not a coding task)

After the skeleton is committed, the author can try the extension in Chrome:

1. Start RawReader. The bridge is on by default (Settings → 浏览器插件 shows the port in use).
2. In Chrome, open `chrome://extensions`, enable Developer mode, Load unpacked, and choose the built `extension/` output directory.
3. Open the extension popup or options page. It finds the app on its own; **重新检测** re-runs the check.
4. Open a manga page in Chrome, trigger translate, and confirm boxes and text appear. Use only sites the author already uses for local testing; do not add those URLs to the repository.
