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

The first install opens the extension's options page in a tab.

## Pair it with the app

The app's bridge is off by default. Nothing listens on the network until you turn it on.

1. In the RawReader app open **Settings → 浏览器插件** and switch on **启用浏览器插件桥接**. The default port is **18793**; it listens on `127.0.0.1` only.
2. Click **显示** next to the pairing code (16 characters, shown as `XXXX-XXXX-XXXX-XXXX`) and copy it.
3. In Chrome open the extension's options page (right-click the extension icon → Options, or the **设置** button in the popup).
4. Enter the same port (default 18793) and paste the pairing code. Settings save automatically.
5. Click **测试连接**. A green line means the app answered and its models are ready. An amber line means the app is reachable but cannot translate yet (for example the models are missing).

The first successful request records the extension's ID in the app, so a different extension cannot use the same code. **重新生成** in the app invalidates the old code; paste the new one in the options page.

## Use it

Open a page with comic images, hover an image and use the floating button, or turn on **自动翻译** in the popup to translate images as they appear. The options page also holds the text style, inpainting and per-site rules.

If a request fails the extension shows a Chinese message with the reason: wrong pairing code, app not running, bridge not enabled, or models not ready.

## Layout

| Path | Content |
|---|---|
| `src/entrypoints/background/` | Service worker: talks to the app (`BRIDGE_PING`, `BRIDGE_TRANSLATE`), per-tab request gate |
| `src/entrypoints/content/` | Content script: finds images, draws the overlay, calls the background worker |
| `src/entrypoints/popup/`, `options/` | Toolbar popup and the options page (port, pairing code, test, text style, site rules) |
| `src/entrypoints/offscreen/` | Canvas work for text cleaning |
| `src/lib/bridge/` | Wire types, HTTP client, per-image memo, priority gate |
| `tests/unit/` | Vitest unit tests |

## Licence

AGPL-3.0-only. Much of the code is adapted from libre-manga-translator (AGPL-3.0-or-later). See `THIRD_PARTY_NOTICES.md` here and `NOTICE` in the repository root.