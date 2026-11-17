# RawReader

RawReader is a Windows-first desktop reader that translates raw manga, manhwa and webtoons into Simplified Chinese while you read them in a built-in browser. The page stays where it is; translated text is drawn over each speech bubble, and one toggle brings the original back. By default all OCR and translation run on your own machine.

The app is built with Electron, Svelte 5 and TypeScript. The local engine uses two `llama-server` processes from llama.cpp: PaddleOCR-VL-1.5 for OCR and Index-Translate-2B for translation. A bundled RT-DETR detector finds bubbles and text boxes. Nothing is uploaded unless you choose an engine that calls a remote API.

A typical session looks like this: open an all-ages manga chapter on a site you already use, turn on auto-translate, and scroll. Bubbles are translated as they come into view; turn the overlay off whenever you want the untouched page.

## Features

- **Built-in browser.** Address bar, tabs, back/forward/reload, and a persistent `persist:browse` session, so logins survive restarts. `target=_blank` links open in the same view; permission requests are denied.
- **Translate as you scroll.** Images entering the viewport are queued nearest-first. Each image is captured from bytes the browser already loaded (CDP `Network.getResponseBody`), with `session.fetch` on the same session as a fallback. No screenshots.
- **Local bubble detection and OCR.** A bundled int8 RT-DETR detector runs in a utility process; PaddleOCR-VL reads each bubble through a local llama-server.
- **Local translation.** Index-Translate-2B translates one bubble per request, with bounded concurrency and neighbouring bubbles as context.
- **Overlay control.** A global toggle hides every overlay without discarding cached results.
- **Three engine modes.** Local models; local OCR with an OpenAI-compatible translation API; or Gemini for both OCR and translation ("one-stop" mode). The setup wizard explains the trade-offs.
- **Result cache.** Results are keyed by image content hash in a local SQLite database with an LRU cap (2 GB by default). Raw page images are not kept long-term.
- **Ad blocking.** A Ghostery filter engine is attached to the browse session and refreshed in the background.
- **First-run setup.** The wizard checks CPU, RAM, disk and GPU, recommends an engine, and can download models with resume from a mirror. Existing model files can be selected instead.
- **Licences in the app.** `LICENSE` and `THIRD_PARTY_NOTICES.md` ship with the packaged app.

## Packages: full and lite

Two packages are produced from one code base. The flavour is chosen at build time with `RAWREADER_FLAVOR`; anything other than `lite` builds `full`.

| | Full (default) | Lite |
|---|---|---|
| `RAWREADER_FLAVOR` | unset or `full` | `lite` |
| Windows target | `zip` | `nsis` |
| Installer | None. Extract the zip and run the app where it was extracted. | Per-user NSIS installer (`oneClick: false`, installation directory can be changed). |
| Model files | Bundled under `resources/models`: the OCR pair and Index-Translate-2B (about 3.1 GB). | None. |
| First run | Local engine by default. | The setup wizard starts on Gemini; local models can be downloaded later from settings. |
| Artifact name | `<productName>-<version>-full.zip` | `<productName>-Setup-<version>-lite.exe` |

The full package is a zip because NSIS cannot build installers above 2 GB. Both packages include the same Vulkan `llama-server` runtime, the detector, icons, the bundled font and the licence files; the difference is the model files and the installer format. Both keep the other engine modes available.

Model files are not committed to the repository. The full packaging step copies them from the paths listed in `MODEL_SOURCES` in `electron-builder.config.mjs`; if those files are missing, packaging that flavour will fail. Which model files a build should contain is defined only by that list.

## Run from source

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

In development, `dev.config.json` points the local engine at model files that already exist on the maintainer's machine and disables automatic downloads. To run the local engine, either provide files at those paths (or an overlay in `dev.config.local.json`), or choose another engine in settings. Do not trigger a model download during development.

Useful commands:

| Command | Purpose |
|---|---|
| `npm run dev` | electron-vite development build with hot reload. |
| `npm run typecheck` | `tsc --noEmit` for the Node and web projects plus `svelte-check`. |
| `npm test` | Vitest, one run. End-to-end tests that start real models are excluded unless `RAWREADER_E2E=1`. |
| `npm run build` | Licence check and production build into `out/`. |
| `npm run dist:dir` | Unpacked Windows build under `release/<flavour>/`. |
| `npm run dist` | Full package by default. |

Build the lite package in PowerShell:

```powershell
$env:RAWREADER_FLAVOR = "lite"
npm run dist
```

Packaging runs `scripts/fetch-resources.mjs` first. It puts the Vulkan llama.cpp build into `resources/llama/vulkan/` and verifies the committed detector and font. Model files for the full package are copied from the `MODEL_SOURCES` paths described above.

## Copyright and content

RawReader is a reading and translation tool. It does not host, provide, bundle or distribute comics, and it does not include a catalogue or a download service. You open pages in the built-in browser yourself, on sites you already use.

You are responsible for the material you view and translate and for how you use the result. Make sure you have the right to access and translate that material, and follow the terms of the sites you visit. Do not use the app to bypass paywalls, DRM or other access controls. The project takes no position on, and accepts no liability for, content accessed by users.

Translation output is generated automatically and can be wrong. It is not a substitute for a human translation.

## Licence

RawReader is free software under the GNU Affero General Public License, version 3 (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Third-party components, bundled binaries, fonts and models are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), together with their licences and, where applicable, the source files they were ported from.
