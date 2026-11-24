---
inclusion: always
---

# Repository structure

Current layout for phase 1. Create folders when the first file in them is written; do not create empty placeholders.

```
app-directapi/
├─ .kiro/
│  ├─ steering/            product.md, tech.md, structure.md (always included)
│  ├─ specs/               module-plan/, phase1-mvp/ (requirements, design, tasks)
│  └─ hooks/               Kiro hooks + README.md describing each hook and how to disable it
├─ app-identity.json       productName, appId, userDataDirName (single source; see below)
├─ dev.config.json         dev-only config overlay pointing at existing local models
├─ electron.vite.config.ts
├─ electron-builder.config.mjs
├─ package.json, .npmrc, tsconfig*.json, vitest.config.ts
├─ LICENSE                 AGPL-3.0
├─ THIRD_PARTY_NOTICES.md
├─ resources/              extraResources for the packaged app (populated by scripts, not committed)
│  ├─ llama/vulkan/        llama.cpp b12318 Vulkan build
│  └─ detector/            detector-v4-s_int8.onnx
├─ scripts/                build-time helpers (fetch resources, licence check)
├─ src/
   ├─ shared/              code imported by main, preloads and renderer (no Electron, no Node-only APIs)
   │  ├─ app-identity.ts   re-exports app-identity.json with types
   │  ├─ bridge.ts         bridge ports and the pinned extension ID / Origin
   │  ├─ config/           zod config schema, defaults, types
   │  ├─ models/           local translator catalogue (translators.ts)
   │  ├─ setup/            engine recommendation rules for the first-run wizard
   │  └─ ipc/              channel names, zod payload schemas, typed API interfaces
   ├─ main/
   │  ├─ index.ts          app lifecycle, userData path, quit handling
   │  ├─ window/           shell window, tabs (incl. popup handling), browse view, context menu, tray, navigation guards, layout
   │  ├─ ipc/              handler registration, sender checks, validation
   │  ├─ config/           electron-store wrapper, dev overlay, migrations
   │  ├─ llama/            process manager, arg builder, pid files, health, backend resolution
   │  ├─ capture/          CDP response capture, session.fetch fallback, MIME sniff, URL checks
   │  ├─ pipeline/         scheduler, per-image state machine, stage queues
   │  ├─ detect/           utility-process entry and ported LMT detection code
   │  ├─ ocr/              OCR client for llama-server #1
   │  ├─ translate/        local translation client; prompts/ holds the ported pure prompt functions
   │  ├─ gemini/           Gemini one-stop cloud engine (bubble crops, at most 20 per request)
   │  ├─ llm/              shared OpenAI-compatible fetch client (/v1/chat/completions only)
   │  ├─ secrets/          encrypted API-key store (Electron safeStorage)
   │  ├─ cache/            SQLite result cache, keys, LRU eviction
   │  ├─ history/          reading-history SQLite store, URL normalisation, tab recorder
   │  ├─ models/           manifest, downloader, verification, CUDA backend download
   │  ├─ system/           CPU, RAM, free disk and GPU detection for the first-run wizard
   │  ├─ bridge/           local HTTP server for the Chrome extension: guards, protocol, routes
   │  ├─ webtext/          Google web-page translation bar (policy, request, page service)
   │  ├─ adblock/          Ghostery filter engine: cached download, refresh, session attachment
   │  ├─ overlay/          bundled font subset for the overlay
   │  ├─ headless/         Electron smoke, detect-worker and overlay test harnesses
   │  └─ log/              electron-log setup and redaction
   ├─ preload/
   │  ├─ shell/            exposes the typed shell API via contextBridge
   │  └─ browse/           image discovery, scroll queue, overlay (Shadow DOM), text fit, context-image, webtext
   └─ renderer/            Svelte 5 shell UI (address bar, tabs, toggles, popovers, settings)
      └─ src/
         ├─ i18n/zh-CN.ts all UI strings
         ├─ ui/           Popover and shared bits
         ├─ settings/     settings tabs (engine, models, servers, advanced, bridge) and history panel
         └─ setup/        first-run wizard (hardware, engine, models or API key)
└─ extension/                separate npm package (WXT + TypeScript + Svelte 5)
   ├─ wxt.config.ts         manifest (pinned key, host permissions, direct-API preset hosts)
   ├─ src/entrypoints/      background worker, content script, popup, options, offscreen
   ├─ src/lib/bridge/       wire types, HTTP client to 127.0.0.1, memo, priority gate
   ├─ src/lib/direct/       direct-API presets (providers.ts), request builders, prompt, parser, backend selection
   ├─ src/lib/inpaint/, canvas/  inpainting and canvas work
   └─ .output/chrome-mv3/   build output loaded unpacked in Chrome
```

## Rules

- **App identity.** `productName`, `appId` and `userDataDirName` live only in `app-identity.json`. Main imports it through `src/shared/app-identity.ts`; `electron-builder.config.mjs` reads the same JSON. Dev builds append `-dev` to the userData folder. The browse partition name `persist:browse` is a constant in `src/shared/` and does not contain the product name.
- **Process boundaries.** `src/shared` must not import from `main`, `preload` or `renderer`. The renderer never imports from `main`. Only `src/main/ipc` registers IPC handlers.
- **Pure vs Electron code.** Keep Electron and Node side effects at the edges (`window/`, `ipc/`, `llama/` spawn code, `capture/` debugger code). Logic beside them is pure and unit-tested.
- **Tests.** Colocate unit tests as `*.test.ts` next to the code. Fixtures go in `src/**/__fixtures__/`. Tests that spawn real processes are named `*.win.test.ts` and are skipped off Windows.
- **Ported LMT code.** Ported files sit in the target folders from the module plan port map (`detect/`, `translate/prompts/`, `pipeline/state.ts`, `preload/browse/`, `models/`, `capture/`). Each starts with:
  ```
  // Portions ported from libre-manga-translator src/<path> @ <commit>,
  // AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
  ```
  Add or update the matching `THIRD_PARTY_NOTICES.md` entry in the same change.
- **Bridge.** The extension bridge lives in `src/main/bridge/` and is enabled by default (`bridge.enabled`). It binds `127.0.0.1` only and has no pairing code; every request must come from the pinned extension `Origin` in `src/shared/bridge.ts`, and anything else gets 403. The extension keeps its own copy of the port list in `extension/src/lib/bridge/protocol.ts`; the two must stay equal.
- **Cloud engines.** `gemini/` and the `remote` option in `llm/chat.ts` are pipeline stages like the local clients; API keys go through `secrets/` and never into config or logs. The extension's presets live in `extension/src/lib/direct/providers.ts` and are the single source for its endpoint hosts.
- **Runtime data** lives under `app.getPath('userData')`: `config.json`, `secrets.json`, `cache/cache.db`, `history/history.db`, `models/`, `llama/cuda-<build>/`, `run/*.pid.json`, `logs/`. Never write to the install directory or the repo at runtime.
- **Not committed:** `node_modules/`, `out/`, `release/`, models, `*.gguf`, files under `resources/llama/` and `resources/detector/`, local dev overrides (`dev.config.local.json`), and the extension's `node_modules/` and `.output/`.
- **Hooks.** Every hook in `.kiro/hooks/` is listed in `.kiro/hooks/README.md` with its trigger, action and how to disable it. Hooks that inject prompts into the agent must say so, so they can be turned off during bulk implementation.
