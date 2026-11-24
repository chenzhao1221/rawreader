# RawReader Chrome extension

A Manifest V3 Chrome extension that translates the comic images of the page you are reading and draws the Chinese translation over them. It has two backends: the RawReader desktop app on the same computer (detection, OCR and translation all run there, the extension only talks to `127.0.0.1`), or a vision model API you configure (Gemini, Zhipu GLM, SiliconFlow or any OpenAI-compatible service). There is no telemetry.

It is a separate npm package (WXT + TypeScript + Svelte 5). The desktop app's own `npm run typecheck`, `npm test` and `npm run build` do not include it.

## Build

```powershell
cd extension
npm install
npm run build
```

The build output is the unpacked extension:

```
<repo>\extension\.output\chrome-mv3
```

On this machine that is `C:\Users\chenxiao\.kiro\crew\workspace\manga-lab\app\extension\.output\chrome-mv3`.

Other commands: `npm test` (Vitest, headless, no Chrome), `npm run typecheck` (svelte-check), `npm run dev` (WXT dev mode, starts a browser), `npm run zip` (a `.zip` in `.output/`).

## Load it unpacked

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `.output\chrome-mv3` folder above.
4. After a rebuild, click the reload icon on the extension card.

The extension ID is fixed by the `key` in `extension-key.json` (ID `gpkjhmgphgimhomimgpjbdehibhenlce`). Do not remove the key: the app only accepts requests from this ID.

## Connect to the app

There is nothing to configure. Install the extension, open the RawReader app, and it works.

- The app's bridge is on by default and starts with the app. It listens on `127.0.0.1` only, on port **18793**, or the next free one of **18794-18797** when 18793 is taken. **Settings → 浏览器插件** has a switch to turn it off.
- There is no pairing code. The app answers only requests whose `Origin` is `chrome-extension://gpkjhmgphgimhomimgpjbdehibhenlce`, the ID pinned by the manifest `key`. Web pages, other extensions and requests without an `Origin` get `403`, and CORS is granted to that one ID only.
- The extension probes `GET /ping` on 18793-18797 when the browser starts and before every translation, uses the first port that answers and caches it. If the app is closed, the popup says **请先打开 RawReader**.
- The options page shows the connection state and a **重新检测** button. It has no port or code fields.

## Direct API mode (no RawReader needed)

The options page has a **翻译后端** card with three choices:

| Choice | Behaviour |
|---|---|
| 自动 (default) | Use RawReader when it is running and ready, otherwise the direct API if one is configured. When neither exists, the translate request fails with a Chinese message and the options page opens (at most once per 10 minutes). |
| 只用 RawReader | Never uses the API. |
| 只用直连 API | Never probes the app. |

In direct mode the extension sends the image you right-clicked (shrunk to at most 3072 px on the long side and about 3.5 MB, re-encoded as JPEG only when needed) to the vision model in **one request**. The model finds the text, reads it and translates it into the target language already set in the extension (`sync:target-lang`, default Simplified Chinese), and answers with JSON:

```json
{"items":[{"box":[x1,y1,x2,y2],"source":"original text","translation":"translated text"}]}
```

`box` is on a 0-1000 scale relative to the image. The extension also accepts fractions, pixel values above 1000, Gemini's `box_2d` and a few other key names. If the answer is cut off, the complete items are kept. If it is not JSON at all, the whole answer is shown as one translation in a box at the top of the image. If you edit or draw regions, the model is asked to translate exactly those regions.

Presets (all fields stay editable):

| Provider | Base URL | Recommended models |
|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` (free), `glm-4.1v-thinking-flash`, `glm-4v-plus-0111` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-32B-Instruct`, `Qwen/Qwen2.5-VL-72B-Instruct`, `Pro/Qwen/Qwen2.5-VL-7B-Instruct` |
| 自定义 (OpenAI compatible) | your own, `https` (plain `http` only for `localhost` / `127.0.0.1`) | any model that accepts images |

Gemini uses its native `generateContent` API; the others use `POST <base>/chat/completions`. Box accuracy varies by model: Gemini and Qwen-VL place boxes well, small free models less so. Very tall strips (more than twice as tall as wide) are cut into overlapping segments at their original resolution, one request per segment, and the boxes are mapped back to the whole image. Other images are shrunk to 3072 px on the long side. The output length is set in the options page under advanced settings (default 8192 tokens). If the service cuts an answer short, the overlay shows a note.

Privacy and permissions:

- The API key is saved only in `chrome.storage.local` (not synced), is read only by the background worker and the options page, never goes into a log or a URL (Gemini gets it in the `x-goog-api-key` header, the others in `Authorization`), and is removed from error messages. It is sent only to the Base URL you configured.
- The manifest lists the three preset API hosts in `host_permissions` and `https://*/*`, `http://127.0.0.1/*`, `http://localhost/*` in `optional_host_permissions`. For a custom Base URL the options page asks the browser for that one host when you click 保存. The manifest still has `<all_urls>` for fetching comic images from any site and for the app bridge, so in the current build the custom-host prompt is normally a no-op.
- Image bytes leave the computer only in direct mode, and only to that API. With RawReader they stay on `127.0.0.1`.
## Use it

Open a page with comic images, right-click the picture and choose **翻译这张图片** (**翻译本页图片** does every loaded picture on the page), or turn on **自动翻译** in the popup to translate images as they appear. There is no button over the picture any more: a thin status line at the edge of the picture shows 正在取图 / 排队中 / 翻译中 / 完成, and on a failure the reason and a 重试 button. The options page also holds the text style, inpainting and per-site rules.

The menu entry works on plain pictures, on pictures under a transparent page-flip layer or inside a link, on `<canvas>` readers and on a picture that appears twice (the one you clicked is translated). Not supported: pictures inside an iframe, and pages that block the right-click themselves.

If a request fails the extension shows a Chinese message with the reason: app not running (open RawReader first), request refused (not the official extension build), or models not ready.

### Long strips (direct mode)

A picture taller than twice its width is cut into overlapping segments (at most 3072 px on the long side each) and the segments are sent one after another. The picture is decoded once per task and every segment is cut from the same bitmap. The segment around the right-click goes first, then the ones on screen, then the rest, and **each segment is drawn as soon as it comes back**, so the part you are reading is readable long before the whole strip is done (when 直接翻译 is on or 自动翻译 runs; with the box-adjusting step on, the strip is shown when all of it has arrived, as before). A bubble that two neighbouring segments both read is shown once.

A segment that fails twice does not throw the others away: the picture is shown with the rest, the status line says `第 N 段失败：原因` with a 重试 button, and only the failed segments are asked for again. A strip that is missing segments is **not** written to the page cache and does not feed the series context until it is complete.

Order of work, at the page queue and at the per-tab request gate: your menu click, then pictures on screen, then pictures off screen. A running request is never interrupted; the next free place goes to the most urgent task. In direct mode a place is taken per segment, so a click waits for one segment at most, not for a whole strip.

## Reading history

The history lives in the RawReader desktop app (设置 > 阅读历史, or the clock button in the toolbar): list, search, open, delete one entry, 清空全部. The popup no longer has a list. Its button 在 RawReader 里看历史 asks the app (over the local bridge, `POST /history/open`) to show that page; with the app closed it says 请先打开 RawReader。

- What is reported: address (without `#` and tracking parameters), title, series and chapter (only when a site rule gives them), time. Never a picture, the original text or a translation. The app stores it in its own SQLite file under its data folder; nothing is uploaded or synced. The extension does not use the browser's own history: the manifest has no `history` permission.
- How: each visit goes into `chrome.storage.local` (key `history-pending`, at most 300 visits, one per address) and is sent to `POST /history` on `127.0.0.1` at once. It leaves the queue only after the app took it. With the app closed (or an older app that has no history routes) the visits wait and are sent when the app answers again: at the next visit, when the browser starts, when the worker wakes up, or when the popup checks the connection. A list kept in the extension by older versions (`reading-history`) is moved into the queue once and removed.
- When: the first time a translation starts on a page address (menu, auto, 翻译本页图片), or after 10 seconds on a page that matches a site rule you wrote yourself. A single-page reader that changes address is reported again for the new address.
- Not in private windows. The switch 记录阅读历史 in the popup stops the reporting (visits already waiting stay in the queue and are not sent until it is switched on again).
## Measuring (development)

`scripts/perf-headless.mjs` loads a build into a headless Chrome with a throw-away profile (`--headless=new`, DevTools pipe, no window, no extra dependency) and points the extension at `scripts/mock-vision-api.mjs`, a local stand-in for a vision API that answers after a fixed delay. It never contacts a real service and never touches your own Chrome profile.

    npm run build                                   # or RAWREADER_OUT_DIR=<dir> npm run build to build elsewhere
    node scripts/perf-headless.mjs --ext .output/chrome-mv3 --scenario normal,strip,strip-mid --samples 5 --out result.json
    node scripts/perf-headless.mjs --ext .output/chrome-mv3 --check      # page checks: right-click targets, status line, failure and retry, queue order

Every number it prints is a mock number (the API round trip is the mock's delay). The extension keeps its own timing records (times, sizes and task numbers only; no address, text or picture) in `local:perf-log`; the in-page settings sidebar (tab 系统, card 测速记录) exports them as JSON and clears them.

## Layout

| Path | Content |
|---|---|
| `src/entrypoints/background/` | Service worker: picks the backend per request, talks to the app (`BRIDGE_PING`, `BRIDGE_TRANSLATE`, `BACKEND_STATUS`) or the API, per-tab request gate |
| `src/entrypoints/content/` | Content script: finds images, draws the overlay, calls the background worker |
| `src/entrypoints/popup/`, `options/` | Toolbar popup and the options page (connection state, text style, site rules) |
| `src/entrypoints/offscreen/` | Canvas work for text cleaning |
| `src/lib/bridge/` | Wire types, HTTP client, per-image memo (segments arriving in pieces), task port client, priority gate |
| `src/lib/direct/` | Direct API mode: presets, request builders, prompt, tolerant JSON parser, image shrinking, backend selection |
| `src/lib/perf/`, `reading-history.ts`, `history-sync.ts`, `task-status.ts`, `context-target.ts` | Timing marks, reading history, status-line phases, which picture a right-click means (all pure logic) |
| `scripts/`, `tests/fixtures/perf/` | Mock vision API, headless measurement and page checks, synthetic sample pages |
| `tests/unit/` | Vitest unit tests |

## Licence

AGPL-3.0-only. Much of the code is adapted from libre-manga-translator (AGPL-3.0-or-later). See `THIRD_PARTY_NOTICES.md` here and `NOTICE` in the repository root.