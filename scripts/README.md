# Scripts

| Script | What it does |
|---|---|
| `fetch-resources.mjs` | Puts the Vulkan llama.cpp build (b12318, sha256 pinned) into `resources/llama/vulkan/` for the installer. Downloads the official zip; if that fails it copies the local build from `../ocr-vl-test/llamacpp/bin` (read-only source). Also verifies the committed detector and font. Run by `npm run dist` and `npm run dist:dir`. |
| `check-licenses.mjs` | Fails when an installed production dependency has a licence outside the allowlist (MIT, ISC, BSD-*, Apache-2.0, LGPL-3.0, GPL-3.0, AGPL-3.0, OFL-1.1, zlib) or is missing from `THIRD_PARTY_NOTICES.md`. Run by `npm run build`. |
| `build-font-subset.py` | Regenerates `resources/fonts/NotoSansSC-Bold-subset.woff` from a Noto Sans SC variable font (needs Python and fontTools). The result is committed. |
| `smoke-electron.mjs` | Runs a headless Electron smoke (see below). |

## Headless smokes (nothing is shown on screen)

| Command | Launches | Checks |
|---|---|---|
| `npm run smoke:detect-worker` | `electron . --headless-smoke=detect-worker`: no window at all, no llama-server | The built detection worker runs under Electron's `utilityProcess`, finds the three bubbles on `fixtures/smoke/panel.png`, and the worker and Electron processes are gone afterwards. Report: `.e2e-out/detect-worker-smoke.json`. |
| `npm run smoke:overlay` | `electron . --headless-smoke=overlay`: one hidden window (`show: false`), no llama-server | The real overlay renderer under a page CSP of `default-src 'none'`: Shadow DOM host, bundled font, geometry follow, show/hide, text fit, click-through. Report: `.e2e-out/overlay-smoke.json`. |
| `$env:RAWREADER_E2E='1'; npx vitest run src/main/pipeline/smoke.e2e.test.ts` | Node only | Real detector, OCR and translation through two real llama-servers started and stopped by PID. Output: `.e2e-out/pipeline-smoke/`. |

The two `--headless-smoke` flags work only in unpackaged builds and are checked in `src/main/index.ts` before any window code.
