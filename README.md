# RawReader

RawReader is a Windows-first desktop reader that translates raw manga, manhwa and webtoons into Simplified Chinese while you read them in a built-in browser. The page stays where it is; translated text is drawn over each speech bubble, and one toggle brings the original back. By default all detection, OCR and translation run on your own machine.

The app is built with Electron, Svelte 5 and TypeScript. The local engine uses two `llama-server` processes from llama.cpp: PaddleOCR-VL-1.5 for OCR and Index-Translate-2B for translation. A bundled RT-DETR detector finds bubbles and text boxes. You can also switch to a cloud engine: an OpenAI-compatible translation API, or Gemini doing OCR and translation in one request. Nothing is uploaded unless you choose one of those engines.

A typical session looks like this: open an all-ages manga chapter on a site you already use, turn on auto-translate, and scroll. Bubbles are translated as they come into view; turn the overlay off whenever you want the untouched page.

This repository is the source of the project. RawReader is developed in the open on GitHub; there is no separate installer download and no published set of binaries. You get the app by cloning the repository and building it, as described below.

## Features

- **Built-in browser.** Address bar, tabs, back/forward/reload, a persistent `persist:browse` session so logins survive restarts, and a tray icon that keeps translation running after the window is closed. Links and plain `window.open` become tabs; sign-in popups open as a guarded child window. Permission requests are denied.
- **Translate as you scroll.** Images entering the viewport are queued nearest-first. Each image is captured from bytes the browser already loaded (CDP `Network.getResponseBody`), with `session.fetch` on the same session as a fallback. No screenshots.
- **Local bubble detection and OCR.** A bundled int8 RT-DETR detector runs in a utility process; PaddleOCR-VL reads each bubble through a local llama-server.
- **Local translation.** Index-Translate-2B translates bubbles one at a time or batched per image, with bounded concurrency and earlier bubbles of the image as context. Other local translation models and custom GGUF files can be selected.
- **Optional cloud translation.** Three engine modes: local models; local OCR with an OpenAI-compatible translation API; or Gemini for both OCR and translation. The setup wizard explains the trade-offs, and API keys are stored encrypted on the machine, never in logs.
- **Translate one image on demand.** Right-click a picture in the built-in browser and choose **翻译这张图片**. The desktop menu has no 翻译本页图片 entry; whole-page work there is done by auto-translate.
- **Overlay control.** A global toggle hides every overlay without discarding cached results.
- **Reading history.** Visits are kept in a local SQLite file (address, title, site, series, chapter, time; never images or translations) and opened from the clock button in the toolbar. Search, open one entry, delete one, clear all.
- **Web page translation bar.** Pages in another language offer a bar with translate / always translate this language / never this language / never this site / show original. It asks Google's public translate endpoint from the main process.
- **Result cache.** Results are keyed by image content hash in a local SQLite database with an LRU cap (2 GB by default). Raw page images are not kept long-term.
- **Ad blocking.** A Ghostery filter engine is attached to the browse session and refreshed in the background.
- **First-run setup.** The wizard checks CPU, RAM, disk and GPU, recommends an engine, and can download models with resume from a mirror. Existing model files can be selected instead.
- **Inference backend.** Vulkan is bundled. NVIDIA users can download the CUDA build from settings, or point the app at a custom llama.cpp folder.
- **Licences in the app.** `LICENSE` and `THIRD_PARTY_NOTICES.md` ship with the packaged app.

## Chrome extension

A Manifest V3 extension in `extension/` is part of this repository. It translates the comic images of the page you are reading, either through the RawReader desktop app on `127.0.0.1` (detection, OCR and translation run there) or by calling a vision API you configure directly. It adds two right-click entries, **翻译这张图片** and **翻译本页图片**.

The extension is not published to any browser store. Load it unpacked from your own build:

```powershell
cd extension
npm install
npm run build
```

The unpacked extension is written to `extension\.output\chrome-mv3`. Then:

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select `extension\.output\chrome-mv3`.
4. Open the RawReader desktop app. The bridge is on by default, so there is nothing to pair or configure. After rebuilding the extension, click the reload icon on its card.

The bridge listens on `127.0.0.1` only (port 18793, or the next free one of 18794-18797) and accepts only the extension ID pinned in the build. Direct API presets are Google Gemini, 智谱 GLM, 硅基流动, 阿里云百炼, 火山引擎豆包 and a custom OpenAI-compatible endpoint. See [extension/README.md](extension/README.md) for details.

## Build and run from source

Requirements:

- Windows (the packaging configuration targets Windows x64).
- Node.js 22.12 or newer.
- npm.

Install dependencies. The repository's `.npmrc` already points at the npmmirror registry:

```powershell
npm install
```

If Electron or electron-builder binaries download slowly, set the mirrors in the shell before installing:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

Start the development app:

```powershell
npm run dev
```

In development, `dev.config.json` points the local engine at model files that already exist on the maintainer's machine and disables automatic downloads. To run the local engine, either provide files at those paths (or an overlay in `dev.config.local.json`), point the app at files you have, or choose another engine in settings. Do not trigger a model download during development.

Useful commands:

| Command | Purpose |
|---|---|
| `npm run dev` | electron-vite development build with hot reload. |
| `npm run typecheck` | `tsc --noEmit` for the Node and web projects plus `svelte-check`. |
| `npm test` | Vitest, one run. Tests that start real models are excluded unless `RAWREADER_E2E=1`. |
| `npm run build` | Licence check and production build into `out/`. |
| `npm run dist:dir` | Unpacked Windows build under `release\<flavour>\win-unpacked`. |
| `npm run dist` | Packages Windows for the selected flavour (full by default). |

To run a packaged build, make an unpacked build and start the executable inside it:

```powershell
npm run dist:dir
.\release\full\win-unpacked\RawReader.exe
```

### Package flavours

Two packages are produced from one code base. The flavour is chosen at build time with `RAWREADER_FLAVOR`; anything other than `lite` builds `full`.

| | Full (default) | Lite |
|---|---|---|
| `RAWREADER_FLAVOR` | unset or `full` | `lite` |
| Windows target | `zip` | `nsis` |
| Result | A folder you run where it was extracted. | Per-user installer (`oneClick: false`, installation directory can be changed). |
| Model files | Bundled under `resources/models`: the OCR pair and Index-Translate-2B (about 3.1 GB). | None. |
| First run | Local engine by default. | The setup wizard starts on Gemini; local models can be downloaded later from settings. |
| Artifact name | `<productName>-<version>-full.zip` | `<productName>-Setup-<version>-lite.exe` |

The full package is a zip because NSIS cannot build installers above 2 GB. Both packages include the same Vulkan `llama-server` runtime, the detector, icons, the bundled font and the licence files; the difference is the model files and the installer format. Both keep the other engine modes available.

Model files are not committed to the repository. The full packaging step copies them from the paths listed in `MODEL_SOURCES` in `electron-builder.config.mjs`; if those files are missing, packaging that flavour will fail. Which model files a build should contain is defined only by that list. Build the lite package with:

```powershell
$env:RAWREADER_FLAVOR = "lite"
npm run dist
```

Packaging runs `scripts/fetch-resources.mjs` first. It puts the Vulkan llama.cpp build into `resources/llama/vulkan/` and verifies the committed detector and font.

## Configuration

Settings are written to the app's user data folder, not to this repository. API keys entered in settings are encrypted with the operating system's credential protection and are never logged. Never put a real key in a file that is committed to the repository; use placeholders such as `YOUR_API_KEY` or `sk-********` in notes and examples.

## Copyright and content

RawReader is a reading and translation tool. It does not host, provide, bundle or distribute comics, and it does not include a catalogue or a download service. You open pages in the built-in browser yourself, on sites you already use.

You are responsible for the material you view and translate and for how you use the result. Make sure you have the right to access and translate that material, and follow the terms of the sites you visit. Do not use the app to bypass paywalls, DRM or other access controls. The project takes no position on, and accepts no liability for, content accessed by users.

Translation output is generated automatically and can be wrong. It is not a substitute for a human translation.

## Licence

RawReader is free software under the GNU Affero General Public License, version 3 (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Third-party components, bundled binaries, fonts and models are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), together with their licences and, where applicable, the source files they were ported from.
