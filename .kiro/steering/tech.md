---
inclusion: always
---

# Tech stack and engineering rules

## Stack

| Area | Choice | Notes |
|---|---|---|
| Runtime | Electron (45.x at plan time) | `WebContentsView`, `session`, `webContents.debugger`, `utilityProcess`, `net.fetch` |
| Build | electron-vite (6.x) | One config for main, preloads and renderer. Output in `out/` |
| Language | TypeScript, `strict: true` | ESM everywhere. No `any` at module boundaries |
| Shell UI | Svelte 5 (runes) via `@sveltejs/vite-plugin-svelte` | Matches LMT. UI strings in Simplified Chinese |
| Config | electron-store (12.x, ESM) + zod (4.x) | zod schema is the single source of truth for config and IPC payloads |
| Queues | p-queue (10.x, ESM) | Per-stage concurrency and priority in main |
| Detection | onnxruntime-node (1.31.x, CPU EP baseline) + sharp (0.35.x) | Runs in a `utilityProcess` |
| Cache | better-sqlite3 (13.x) | Native; rebuilt for Electron by electron-builder |
| Logging | electron-log (5.x) | Plus our own redaction filter |
| Tests | Vitest | Pure logic is unit-tested; Electron APIs are mocked at module edges |
| Packaging | electron-builder (26.x) | Two flavours: `full` (default) is a Windows `zip` with models under `resources/models`; `lite` is an NSIS installer with no model files. `RAWREADER_FLAVOR` selects it |
| Cloud engines | `net.fetch` to Gemini `generateContent` or an OpenAI-compatible `/chat/completions` | Optional, user-selected. No vendor SDK; keys go through `safeStorage` |
| Local bridge | `node:http` on `127.0.0.1`, ports 18793-18797 | On by default, no pairing code; only the pinned extension `Origin` is accepted |
| Inference | llama.cpp `llama-server` build b12318, external binary | Vulkan bundled; CUDA 12.4 on demand; custom path allowed |

Versions are those checked in the module plan (2026-11-13) and are pinned in `package.json`. Do not add a dependency that the module plan marks "not recommended" or "not needed" (for example, openai SDK, execa, tree-kill, electron-dl, `@huggingface/hub`).

## Dependency policy

- Prefer Electron/Node built-ins, then the libraries listed in the module plan.
- Every new production dependency must have a licence on the allowlist: MIT, ISC, BSD-*, Apache-2.0, LGPL-3.0, GPL-3.0, AGPL-3.0, OFL-1.1, zlib. GPL-2.0-only is forbidden.
- Add each dependency, bundled binary, font and model to `THIRD_PARTY_NOTICES.md` in the same change.
- Native modules (sharp, onnxruntime-node, better-sqlite3) must be listed in electron-builder `asarUnpack`.

## Network and mirrors (China)

The user's proxy traffic is limited. Use domestic mirrors by default.

- npm: `.npmrc` contains `registry=https://registry.npmmirror.com`. Keep `.npmrc` to registry settings only; npm 10+ warns on unknown keys.
- Electron binaries: set environment variables, not `.npmrc` keys:
  ```powershell
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
  ```
  For a permanent setting use `[Environment]::SetEnvironmentVariable(<name>, <value>, 'User')`.
- Models: hf-mirror.com first, ModelScope as fallback. The base URLs are configurable.
- CUDA llama.cpp assets come from GitHub releases and may need a proxy in China. App downloads use Electron `net.fetch`, which honours the system proxy.
- Never trigger a model download in dev. Dev config points at the files that already exist (below).

## Local dev resources (read-only, never copy or redownload)

All paths are relative to the repo root (`manga-lab/app-directapi`). They are wired through `dev.config.json`; see `design.md`.

| Role | Path |
|---|---|
| llama-server (Vulkan, b12318) | `../ocr-vl-test/llamacpp/bin/llama-server.exe` |
| OCR model | `../ocr-vl-test/llamacpp/models/PaddleOCR-VL-1.5.gguf` |
| OCR mmproj | `../ocr-vl-test/llamacpp/models/PaddleOCR-VL-1.5-mmproj.gguf` |
| Translation model | `../wb-tests/models/Index-Translate-2B.Q4_K_M.gguf` (1.31 GB) |
| Detector | `../ocr-vl-test/models/detector-v4-s_int8.onnx` (about 11 MB) |

Do not modify anything under `../libre-manga-translator`, `../ocr-vl-test`, `../translate-test`, `../wb-tests`, or any MultiDraft path. Reading is fine.

## llama-server rules

- Use only `POST /v1/chat/completions` and `GET /health`. Never use `/completion` (it echoes the source for Index-Translate-2B).
- Bind to `127.0.0.1` only. Spawn with `child_process.spawn(exe, args, { windowsHide: true, shell: false })`. Never use a shell or string-built command lines.
- Default flags (all values come from config):
  - OCR (port 18791): `-m PaddleOCR-VL-1.5.gguf --mmproj PaddleOCR-VL-1.5-mmproj.gguf --host 127.0.0.1 --port 18791 --ctx-size 4096 -np 1 -ngl 99`
  - Translation (port 18792): `-m Index-Translate-2B.Q4_K_M.gguf --host 127.0.0.1 --port 18792 --temp 0 -ngl 99 --ctx-size 8192 -np 1 --flash-attn on --reasoning off --alias Index-Translate-2B`
- Measured on Windows with an AMD Radeon RX 7700 XT (12 GB, Vulkan build, ctx 4096 / 8192, `-np 1 -ngl 99`); all numbers come from `../wb-tests/REPORT.md`:
  - Translation alone: about 0.104 s per bubble in steady state; the process holds about 1447 MiB dedicated VRAM and the adapter rises by about 1482 MiB. OCR alone adds about 1748 MiB.
  - OCR and translation loaded together: idle 5770 MiB, both loaded 8948 MiB (+3178 MiB over idle), peak 9254 MiB on the 12 GB card. Steady state is about 0.107 s per bubble for translation and 0.182 s per image for OCR. The "10 bubbles within 5 s" target is judged met from these per-bubble numbers; there is no page-level end-to-end timing.
  - Ports, ctx, `-ngl`, `-np` and model paths stay configurable for cards with less VRAM.
- Kill only a PID the app spawned and recorded: `taskkill /PID <pid> /T /F`. Never kill by image name (`/IM` is forbidden). PIDs are validated as positive integers before use.
- Orphan cleanup at startup uses the pid file `{pid, startTime, exePath}` and kills only when all three match a live process.

## Cloud translation and the extension bridge

- `translate.engine` picks who translates: `local` (both llama servers), `openai` (local OCR, remote translation) or `gemini` (bubbles cropped locally, sent to Gemini, nothing local loaded for OCR or translation).
- Cloud clients are thin HTTP clients over an injected `fetch` (Electron `net.fetch` in main): `src/main/gemini/client.ts` for `generateContent`, and the `remote` option of `src/main/llm/chat.ts` for OpenAI-compatible translation. They sit behind the same pipeline stages as the local clients, so cache, history and overlay do not care which engine ran. Gemini caps a request at 20 crops and splits larger pages into several requests.
- API keys live in `secrets.json` under userData, encrypted with Electron `safeStorage` (DPAPI on Windows). Keys never reach logs or error messages and are never written to the config file.
- The bridge (`src/main/bridge/`) is a `node:http` server on `127.0.0.1` only. It is enabled by default; there is no pairing code. Every request must carry `Host: 127.0.0.1:<port>` and `Origin: chrome-extension://<pinned id>`; anything else gets 403, and CORS is granted to that origin alone. Routes are `/ping`, `/translate`, `/history` and `/history/open`. Disabling it is a settings switch, not a port change.

## Electron security rules

- All renderers and views: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. No `remote`.
- Only preloads talk to main, through the typed IPC contract in `src/shared/ipc/`. Main validates every payload with zod and checks the sender (shell vs browse view). Messages from the browse view are untrusted page-adjacent input.
- The shell renderer has a strict CSP and loads only local files.
- The browse view allows only `http:` and `https:` navigation. Links and plain `window.open(url)` become tabs; `window.open` with window features (a sign-in popup) becomes a guarded child window that follows the same rules. Permission requests are denied by default.
- Secrets and tokens never go into logs; query strings are redacted.

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install via npmmirror (set the Electron mirror env vars first) |
| `npm run dev` | electron-vite dev with hot reload, using `dev.config.json` |
| `npm run typecheck` | `tsc --noEmit` for node and web projects plus `svelte-check` |
| `npm test` | Vitest, run once |
| `npm run build` | Licence check plus electron-vite production build into `out/` |
| `npm run dist:dir` | Unpacked Windows build under `release/<flavour>/win-unpacked` |
| `npm run dist` | `full` package by default; `RAWREADER_FLAVOR=lite` builds the NSIS lite installer |
| `cd extension && npm run build` | Builds the Chrome extension into `extension/.output/chrome-mv3` (separate npm package; the commands above do not include it) |

A change is done only when `npm run typecheck`, `npm test` and `npm run build` all pass.

## Coding conventions

- English identifiers, comments and log messages. Chinese only in UI string tables.
- Pure logic (prompts, tiling, box math, arg building, URL normalisation, cache keys) lives in modules with no Electron imports so Vitest can test it directly.
- Errors crossing IPC are plain `{ code, message }` objects; no thrown class instances.
- No git commits or pushes unless the user asks.
