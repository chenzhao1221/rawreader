# Third-party notices

This application is licensed AGPL-3.0 (see `LICENSE`). It includes or depends on the components below. Each entry lists the licence declared in the package metadata. Full licence texts ship inside each package under `node_modules/` and, for Electron, in `LICENSE` and `LICENSES.chromium.html` next to the packaged executable.

This file covers the skeleton slice and the logging, capture, scroll queue, detection, OCR, translation and pipeline slices. Entries for llama.cpp, the fonts, the OCR and translation models and the remaining libre-manga-translator (LMT) ports are added in the same change that introduces them.

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
| electron-log | 5.4.4 | MIT | Rotating file logs in the main process |
| p-queue | 10.0.0 | MIT | Per-stage queues with priority in the pipeline |
| onnxruntime-node | 1.31.1 | MIT | RT-DETR detector inference (CPU execution provider), runs in a utility process |
| onnxruntime-common | 1.31.1 | MIT | Dependency of onnxruntime-node |
| global-agent | 4.1.7 | BSD-3-Clause | Dependency of onnxruntime-node (install script only) |
| adm-zip | 0.6.1 | MIT | Dependency of onnxruntime-node (install script only) |
| matcher | 4.0.0 | MIT | Dependency of global-agent |
| serialize-error | 8.1.0 | MIT | Dependency of global-agent |
| escape-string-regexp | 4.0.0 | MIT | Dependency of matcher |
| globalthis | 1.0.4 | MIT | Dependency of global-agent |
| define-properties | 1.2.1 | MIT | Dependency of globalthis |
| define-data-property | 1.1.4 | MIT | Dependency of define-properties |
| has-property-descriptors | 1.0.2 | MIT | Dependency of define-properties |
| es-define-property | 1.0.1 | MIT | Dependency of define-data-property |
| es-errors | 1.3.0 | MIT | Dependency of define-data-property |
| gopd | 1.2.0 | MIT | Dependency of define-data-property |
| object-keys | 1.1.1 | MIT | Dependency of define-properties |
| type-fest | 0.20.2 | MIT OR CC0-1.0 | Dependency of serialize-error |
| sharp | 0.35.5 | Apache-2.0 | Image decoding, resizing and cropping in the detection utility process |
| @img/sharp-win32-x64 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | Prebuilt sharp binary with libvips (LGPL-3.0-or-later, dynamically linked) |
| @img/colour | 1.1.0 | MIT | Dependency of sharp |
| detect-libc | 2.1.2 | Apache-2.0 | Dependency of sharp |

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

llama.cpp `llama-server` (b12318, MIT), the OCR and translation models, Noto Sans SC (OFL-1.1) and the remaining ported libre-manga-translator code (overlay geometry and text fit, model downloader state). The skeleton reads the Vulkan llama.cpp build and the models from the developer's existing local folders in dev mode only; the only file copied into this repository is the 11 MB detector listed above.

## Models and data bundled in the repository

| Component | Licence | Source | Use |
|---|---|---|---|
| detector-v4-s_int8.onnx (11,120,765 bytes, sha256 5FE9E4F576E49D4E7E8B0E029D6D3CDC252ABD4694113E1CAE120E62C931EA79) in rresources/detector/ | Apache-2.0 | ogkalu/comic-text-and-bubble-detector (RT-DETR-v2, classes bubble, text_bubble, text_free), copied from the developer's existing local download | Bubble and text detection |

## Code ported from libre-manga-translator (LMT)

Source: https://github.com/mardhianto/libre-manga-translator, licence AGPL-3.0-or-later, (C) 2026 Libre Manga Translator. Commit: 1ddddc761ff18e6155a071ad3a3f603a836d7136 (local zh-cn branch, based on 1.0.4). Every ported file starts with a header naming its LMT source file and stating that it was modified by RawReader. RawReader is AGPL-3.0, so the licences are compatible.

| RawReader file | LMT source (src/...) | Changes |
|---|---|---|
| src/main/capture/url-check.ts | lib/security.ts | isAllowedImageUrl kept; added data: handling for the fetch fallback and a URL key helper |
| src/main/capture/sniff.ts | lib/utils.ts (sniffMime) | Unknown content returns null instead of JPEG; AVIF brand check |
| src/preload/browse/enqueue-guard.ts | entrypoints/content/auto-translate.ts (AutoTranslateQueue bookkeeping) | In-page queue only de-duplicates and batches; concurrency and priority moved to main |
| src/preload/browse/scroll-queue.ts | entrypoints/content/auto-translate.ts (AutoTranslateOrchestrator) | WXT storage replaced by IPC config; site rules and canvas readers removed; attribute watching for lazy images |
| src/main/pipeline/state.ts | entrypoints/content/translation-registry.ts | Keyed by content hash; main process; claim tokens; element subscriptions |
| src/main/detect/utils.ts | lib/detections/utils.ts | Canvas letterboxing replaced by letterboxLayout and sharp; restoreBoundingBox and containmentNMS ported |
| src/main/detect/tiling.ts | lib/detections/tiling.ts | Typed only |
| src/main/detect/boxes.ts | lib/detections/boxes.ts | Typed only; applied to text boxes, not to bubble boxes |
| src/main/detect/rtdetr.ts | lib/detections/rtdetr.ts | Pure parts only; the "text boxes else bubble boxes" selection is not ported, so bubble-only boxes are kept |
| src/main/detect/detector.ts | lib/detections/rtdetr.ts (control flow) | onnxruntime-web and OffscreenCanvas replaced by onnxruntime-node and sharp |
| src/main/translate/prompts/ocr-text.ts | lib/ocr-text.ts | Unchanged behaviour |
| src/main/translate/prompts/limits.ts | lib/series-context.ts (utf8ByteLength, truncateUtf8) | Byte helpers only; context limits are ours |
| src/main/translate/prompts/lmt.ts | lib/webllm.ts (zhLangName, stripThinking, buildMtBackground, buildMtPrompt Index branch, looksLikePromptEcho, buildBareMtPrompt, token cap in runPlainChat) | Index-Translate branch only; context is the previous bubbles of the same image; engine code not ported |
