# Third-party notices (extension)

This file covers the browser extension in `extension/`. The desktop app's notices are in the root `THIRD_PARTY_NOTICES.md`; the repository `NOTICE` explains the Libre Manga Translator derivation. The extension is distributed under AGPL-3.0-only.

## Libre Manga Translator (LMT)

- Source: https://github.com/mardhianto/libre-manga-translator
- Commit: `1ddddc761ff18e6155a071ad3a3f603a836d7136` (local zh-cn branch, based on 1.0.4)
- Licence: AGPL-3.0-or-later, (C) 2026 Libre Manga Translator. Used under version 3.

Every file copied from LMT starts with the header

```
Portions ported from libre-manga-translator <path> @ <commit>,
AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
```

and names what RawReader changed. Files copied (with changes) are in `src/entrypoints/` (background, content, offscreen, popup, `untaint.content.ts`), `src/lib/` (adapters, canvas, components, configs, env, inpaint, security, series-context, series-context-store, timeouts, utils), `src/assets/app.css`, `wxt.config.ts`, and the tests `tests/unit/{adapters,lock,security,series-context,telea}.test.ts`.

Not carried over: WebLLM, the in-browser OCR and detection models, the ONNX runtime and WASM files, the setup wizard, model download management and LMT's own backends. The bridge client (`src/lib/bridge/`), the options page, `BridgeSettings.svelte`, `user-settings.ts` and the bridge tests are new RawReader code.

## Bundled in the extension build

| Component | Version | Licence | Use |
|---|---|---|---|
| Svelte | 5.57.3 | MIT | UI runtime (compiled into the content script and pages) |
| lucide-svelte | 0.563.0 | ISC | Icons |
| Bangers (Regular) | from LMT `src/assets/fonts` | SIL OFL 1.1 | Selectable overlay font |
| Comic Neue (Regular) | from LMT `src/assets/fonts` | SIL OFL 1.1 | Selectable overlay font |
| Noto Sans (Regular) | from LMT `src/assets/fonts` | SIL OFL 1.1 | Selectable overlay font |

The icons in `public/icon/` are RawReader's own.

## Build and test tools (not shipped)

WXT 0.20.11 (MIT), `@wxt-dev/module-svelte` 2.0.3 (MIT), Tailwind CSS and `@tailwindcss/vite` 4.1.18 (MIT), Vite (MIT, via WXT), terser 5.46.0 (BSD-2-Clause), TypeScript 5.9.2 (Apache-2.0), svelte-check 4.7.8 (MIT), tslib 2.8.1 (0BSD), Vitest 5.1.0 (MIT), happy-dom 20.0.0 (MIT). Versions are pinned in `package.json` and `package-lock.json`.

## Evaluated, not used

The ImageTrans Chrome extension (GPL-3.0) was evaluated and not used. No ImageTrans code, key or asset is part of this package.