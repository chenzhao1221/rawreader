# Third-party notices

This application is licensed AGPL-3.0 (see `LICENSE`). It includes or depends on the components below. Each entry lists the licence declared in the package metadata. Full licence texts ship inside each package under `node_modules/` and, for Electron, in `LICENSE` and `LICENSES.chromium.html` next to the packaged executable.

This file covers every component that ships with, or is downloaded by, phase 1 of the application: npm dependencies, llama.cpp, the bundled font and detector, the downloadable models and the code ported from libre-manga-translator (LMT). The licence gate (scripts/check-licenses.mjs, run by 
pm run build) fails when an installed production dependency is missing from the tables below or has a licence outside the allowlist.

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
| @ghostery/adblocker-electron | 2.20.3 | MPL-2.0 | Ad and tracker blocking in the built-in browser (unmodified; MPL-2.0 is file-level copyleft and GPL-compatible through its section 3.3) |
| @ghostery/adblocker | 2.20.3 | MPL-2.0 | Dependency of @ghostery/adblocker-electron |
| @ghostery/adblocker-electron-preload | 2.20.3 | MPL-2.0 | Dependency of @ghostery/adblocker-electron (cosmetic filtering in frames) |
| @ghostery/adblocker-content | 2.20.3 | MPL-2.0 | Dependency of @ghostery/adblocker-electron-preload |
| @ghostery/adblocker-extended-selectors | 2.20.3 | MPL-2.0 | Dependency of @ghostery/adblocker |
| @ghostery/url-parser | 1.3.1 | MPL-2.0 | Dependency of @ghostery/adblocker |
| @remusao/smaz | 2.2.0 | MPL-2.0 | Dependency of @ghostery/adblocker |
| @remusao/smaz-compress | 2.2.0 | MPL-2.0 | Dependency of @remusao/smaz |
| @remusao/smaz-decompress | 2.2.0 | MPL-2.0 | Dependency of @remusao/smaz |
| @remusao/trie | 2.1.0 | MPL-2.0 | Dependency of @ghostery/adblocker |
| @remusao/small | 2.1.0 | MPL-2.0 | Dependency of @remusao/trie |
| @remusao/guess-url-type | 2.1.0 | MPL-2.0 | Dependency of @ghostery/adblocker |
| tldts-experimental | 7.5.1 | MIT | Dependency of @ghostery/adblocker-electron |
| tldts-core | 7.5.1 | MIT | Dependency of tldts-experimental |
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
| better-sqlite3 | 13.1.1 | MIT | Result cache (SQLite, N-API prebuilt binary, unpacked from the asar archive) |
| node-addon-api | 8.9.2 | MIT | Dependency of better-sqlite3 |
| sharp | 0.35.5 | Apache-2.0 | Image decoding, resizing and cropping in the detection utility process |
| @img/sharp-win32-x64 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | Prebuilt sharp binary with libvips (LGPL-3.0-or-later, dynamically linked) |
| @img/colour | 1.1.0 | MIT | Dependency of sharp |
| detect-libc | 2.1.2 | Apache-2.0 | Dependency of sharp |

The ad-block filter lists themselves are not bundled. On first start `@ghostery/adblocker-electron` downloads the
project's prebuilt engine from `ghostery/adblocker` on raw.githubusercontent.com (built from EasyList and EasyPrivacy,
published under GPL-3.0 and CC BY-SA 3.0) and caches it under `userData/adblock/engine.bin`; it is refreshed every
three days when the network allows.

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

## Bundled with the installer (not npm packages)

| Component | Version | Licence | Use |
|---|---|---|---|
| llama.cpp `llama-server` and the ggml / llama / mtmd libraries (Vulkan build) | b12318 | MIT, (C) 2023-2026 The ggml authors (full text below) | Local inference servers for OCR and translation. Unpacked next to the application as `resources/llama/vulkan/`; downloaded from the official release by `scripts/fetch-resources.mjs`. |
| LLVM OpenMP runtime (`libomp.dll`, `LICENSE-LLVM-OpenMP`) | shipped inside the llama.cpp release | Apache-2.0 WITH LLVM-exception (text in `LICENSE-LLVM-OpenMP` next to the DLL) | Threading in the ggml CPU backends |
| Noto Sans SC Bold, subset to ASCII, punctuation and the GB2312 hanzi (`resources/fonts/NotoSansSC-Bold-subset.woff`) | 2.004 | SIL Open Font License 1.1, (C) 2014-2021 Adobe, with Reserved Font Name 'Source' (full text in `resources/fonts/OFL.txt`, shown in the app) | Translated text in the overlay. The subset keeps the original name table; it is generated by `scripts/build-font-subset.py` from the Noto Sans SC variable font. |

### llama.cpp licence text (MIT)

```
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Downloaded on the user's request (not bundled)

These files are fetched only after the user starts or approves the download. They are not part of the installer.

| Component | Licence | Source | Use |
|---|---|---|---|
| PaddleOCR-VL-1.5.gguf and PaddleOCR-VL-1.5-mmproj.gguf (sha256 pinned in `src/main/models/manifest.ts`) | Apache-2.0 | PaddlePaddle/PaddleOCR-VL-1.5-GGUF on hf-mirror.com / Hugging Face, fallback ModelScope | OCR of detected text regions |
| Index-Translate-2B.Q4_K_M.gguf (sha256 044b313d29342bd3b2c77cbb64023ca0d209bd9b3247763f9d162767ef2d746a) | Apache-2.0 | IndexTeam/Index-Translate-2B-GGUF on hf-mirror.com / Hugging Face, fallback ModelScope | Translation of OCR text to Simplified Chinese |
| llama.cpp CUDA 12.4 build and CUDA runtime DLLs (`llama-b12318-bin-win-cuda-12.4-x64.zip`, `cudart-llama-bin-win-cuda-12.4-x64.zip`) | llama.cpp: MIT. The runtime DLLs are NVIDIA CUDA Toolkit components redistributed by the llama.cpp project under the NVIDIA CUDA Toolkit EULA. | GitHub release b12318 (sha256 pinned in `src/main/models/cuda.ts`) | Optional GPU backend for NVIDIA cards, installed under `userData/llama/cuda-b12318/` on request |
## Models and data bundled in the repository

| Component | Licence | Source | Use |
|---|---|---|---|
| detector-v4-s_int8.onnx (11,120,765 bytes, sha256 5FE9E4F576E49D4E7E8B0E029D6D3CDC252ABD4694113E1CAE120E62C931EA79) in resources/detector/ | Apache-2.0 | ogkalu/comic-text-and-bubble-detector (RT-DETR-v2, classes bubble, text_bubble, text_free), copied from the developer's existing local download | Bubble and text detection |

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
| src/preload/browse/overlay-geometry.ts | entrypoints/content/utils.ts (syncWrapperGeometry, createImageObservers) | Pure functions on rectangles; fixed-position hosts instead of a wrapper around the image; position as well as size is tracked; viewport culling |
| src/preload/browse/text-fit.ts | lib/canvas/text-fit.ts (calculateFittedTextLayout, wrapText) | Measurement injected (unit tested); CJK-aware wrapping with line-start and line-end punctuation rules; the size loop stops at the minimum size and checks width as well as height |
| src/main/translate/prompts/lmt.ts | lib/webllm.ts (zhLangName, stripThinking, buildMtBackground, buildMtPrompt Index branch, looksLikePromptEcho, buildBareMtPrompt, token cap in runPlainChat); lib/prompts.ts (style rules for Chinese output) | Index-Translate branch only; context is the previous bubbles of the same image; the Chinese style rules are condensed into four numbered constraints; engine code not ported |
