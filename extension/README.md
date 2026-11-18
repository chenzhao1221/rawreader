# RawReader Chrome extension

A Manifest V3 Chrome extension that sends the comic images of the page you are reading to the RawReader desktop app on the same computer and draws the Chinese translation over them. Detection, OCR and translation all run in the app; the extension only talks to `127.0.0.1`. There is no telemetry.

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
## Use it

Open a page with comic images, hover an image and use the floating button, or turn on **自动翻译** in the popup to translate images as they appear. The options page also holds the text style, inpainting and per-site rules.

If a request fails the extension shows a Chinese message with the reason: app not running (open RawReader first), request refused (not the official extension build), or models not ready.

## Layout

| Path | Content |
|---|---|
| `src/entrypoints/background/` | Service worker: talks to the app (`BRIDGE_PING`, `BRIDGE_TRANSLATE`), per-tab request gate |
| `src/entrypoints/content/` | Content script: finds images, draws the overlay, calls the background worker |
| `src/entrypoints/popup/`, `options/` | Toolbar popup and the options page (connection state, text style, site rules) |
| `src/entrypoints/offscreen/` | Canvas work for text cleaning |
| `src/lib/bridge/` | Wire types, HTTP client, per-image memo, priority gate |
| `tests/unit/` | Vitest unit tests |

## Licence

AGPL-3.0-only. Much of the code is adapted from libre-manga-translator (AGPL-3.0-or-later). See `THIRD_PARTY_NOTICES.md` here and `NOTICE` in the repository root.