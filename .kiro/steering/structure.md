---
inclusion: always
---

# Repository structure

Target layout for phase 1. Create folders when the first file in them is written; do not create empty placeholders.

```
app/
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
├─ resources/              extraResources for the installer (populated by scripts, not committed)
│  ├─ llama/vulkan/        llama.cpp b12318 Vulkan build
│  └─ detector/            detector-v4-s_int8.onnx
├─ scripts/                build-time helpers (fetch resources, licence check)
└─ src/
   ├─ shared/              code imported by main, preloads and renderer (no Electron, no Node-only APIs)
   │  ├─ app-identity.ts   re-exports app-identity.json with types
   │  ├─ config/           zod config schema, defaults, types
   │  ├─ setup/            engine recommendation rules for the first-run wizard
   │  └─ ipc/              channel names, zod payload schemas, typed API interfaces
   ├─ main/
   │  ├─ index.ts          app lifecycle, userData path, quit handling
   │  ├─ window/           shell window, browse view, navigation guards, layout
   │  ├─ ipc/              handler registration, sender checks, validation
   │  ├─ config/           electron-store wrapper, dev overlay, migrations
   │  ├─ llama/            process manager, arg builder, pid files, health, backend resolution
   │  ├─ capture/          CDP response capture, session.fetch fallback, MIME sniff, URL checks
   │  ├─ pipeline/         scheduler, per-image state machine, stage queues
   │  ├─ detect/           utility-process entry and ported LMT detection code
   │  ├─ ocr/              OCR client for llama-server #1
   │  ├─ translate/        translation client; prompts/ holds the ported pure prompt functions
   │  ├─ llm/              shared OpenAI-compatible fetch client (/v1/chat/completions only)
   │  ├─ cache/            SQLite result cache, keys, LRU eviction
   │  ├─ models/           manifest, downloader, verification, CUDA backend download
   │  ├─ system/           CPU, RAM, free disk and GPU detection for the first-run wizard
   │  ├─ adblock/          Ghostery filter engine: cached download, refresh, session attachment
   │  └─ log/              electron-log setup and redaction
   ├─ preload/
   │  ├─ shell/            exposes the typed shell API via contextBridge
   │  └─ browse/           image discovery, scroll queue, overlay (Shadow DOM), text fit
   └─ renderer/            Svelte 5 shell UI (address bar, toggles, status, settings)
      └─ src/
         ├─ i18n/zh-CN.ts all UI strings
         ├─ settings/     settings tabs
         └─ setup/        first-run wizard (hardware, engine, models or API key)
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
- **Runtime data** lives under `app.getPath('userData')`: `config.json`, `cache/cache.db`, `models/`, `llama/cuda-<build>/`, `run/*.pid.json`, `logs/`. Never write to the install directory or the repo at runtime.
- **Not committed:** `node_modules/`, `out/`, `release/`, models, `*.gguf`, files under `resources/llama/` and `resources/detector/`, local dev overrides (`dev.config.local.json`).
- **Hooks.** Every hook in `.kiro/hooks/` is listed in `.kiro/hooks/README.md` with its trigger, action and how to disable it. Hooks that inject prompts into the agent must say so, so they can be turned off during bulk implementation.
