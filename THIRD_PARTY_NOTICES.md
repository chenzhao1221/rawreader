# Third-party notices

This application is licensed AGPL-3.0 (see `LICENSE`). It includes or depends on the components below. Each entry lists the licence declared in the package metadata. Full licence texts ship inside each package under `node_modules/` and, for Electron, in `LICENSE` and `LICENSES.chromium.html` next to the packaged executable.

This file covers the skeleton slice. Entries for llama.cpp, the fonts, the models and the libre-manga-translator (LMT) ports are added in the same change that introduces them.

## Shipped in the application

| Component | Version | Licence | Use |
|---|---|---|---|
| Electron (includes Chromium and Node.js) | 45.3.1 | MIT (Chromium and Node.js components carry their own licences, listed in `LICENSES.chromium.html`) | Application runtime |
| Svelte | 5.57.3 | MIT | Shell UI, compiled into the renderer bundle |
| zod | 4.6.7 | MIT | Config and IPC schema validation |
| electron-store | 12.0.0 | MIT | Config persistence |
| conf | 16.0.0 | MIT | Dependency of electron-store |
| ajv | 8.20.0 | MIT | Dependency of conf |
| ajv-formats | 3.0.1 | MIT | Dependency of conf |
| atomically | 2.1.1 | MIT | Dependency of conf |
| debounce-fn | 6.0.0 | MIT | Dependency of conf |
| dot-prop | 10.2.0 | MIT | Dependency of conf |
| env-paths | 4.0.0 | MIT | Dependency of conf |
| fast-deep-equal | 3.1.3 | MIT | Dependency of ajv |
| fast-uri | 3.1.9 | BSD-3-Clause | Dependency of ajv |
| is-safe-filename | 0.1.1 | MIT | Dependency of conf |
| json-schema-traverse | 1.0.0 | MIT | Dependency of ajv |
| json-schema-typed | 8.0.2 | BSD-2-Clause | Dependency of conf |
| mimic-function | 5.0.1 | MIT | Dependency of debounce-fn |
| require-from-string | 2.0.2 | MIT | Dependency of ajv |
| semver | 7.8.6 | ISC | Dependency of conf |
| stubborn-fs | 2.0.0 | MIT | Dependency of atomically |
| stubborn-utils | 1.0.2 | MIT | Dependency of atomically |
| tagged-tag | 1.0.0 | MIT | Dependency of type-fest |
| type-fest | 5.10.0 | MIT OR CC0-1.0 | Dependency of conf |
| uint8array-extras | 1.6.0 | MIT | Dependency of conf |
| when-exit | 2.1.5 | MIT | Dependency of atomically |

## Build and test tooling (not shipped)

| Component | Version | Licence |
|---|---|---|
| electron-vite | 6.0.0 | MIT |
| vite | 8.3.8 | MIT |
| @sveltejs/vite-plugin-svelte | 7.3.1 | MIT |
| svelte-check | 4.7.8 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| vitest | 5.1.0 | MIT |
| electron-builder | 26.18.0 | MIT |
| @types/node | 24.19.2 | MIT |

The NSIS installer stub used by electron-builder is covered by the zlib/libpng licence.

## Not yet bundled (later slices)

llama.cpp `llama-server` (b12318, MIT), the detector model, the OCR and translation models, Noto Sans SC (OFL-1.1) and the ported libre-manga-translator code (AGPL-3.0-or-later). The skeleton reads the Vulkan llama.cpp build and the models from the developer's existing local folders in dev mode only; nothing from them is copied into this repository.
