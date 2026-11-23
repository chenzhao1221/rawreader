// Headless measurement and page checks for the RawReader extension.
//
// What it does
//   * starts the local mock vision API (scripts/mock-vision-api.mjs) and a static server for tests/fixtures/perf
//   * starts the system Chrome in headless mode with a throw-away profile under _local/perf-profile/ and loads the
//     built extension through the DevTools pipe (Extensions.loadUnpacked). No new dependency, no real window.
//   * points the extension at the mock API (direct mode), triggers "translate this image" the way the menu does,
//     and reads the extension's own timing records (local:perf-log) back.
//   * every number it prints is a MOCK number: the API round trip is the fixed delay of the mock, not a real service.
//
// Usage (from app-directapi/extension, after a build):
//   node scripts/perf-headless.mjs --ext .output/chrome-mv3 --label after --scenario normal,strip --samples 5
//   node scripts/perf-headless.mjs --ext <dir> --check            page checks (right-click targets, status bar, failure retry, ...)
//
// Safety: it only ever kills the Chrome process it started (by PID) and removes the profile it created.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { startMock } from "./mock-vision-api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixturesDir = path.join(root, "tests", "fixtures", "perf");
const manga = path.resolve(root, "..", "..");
const profilesRoot = path.join(manga, "_local", "perf-profile");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const CHROME = opt("chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
const EXT_DIR = path.resolve(root, opt("ext", ".output/chrome-mv3"));
const LABEL = opt("label", "run");
const SAMPLES = Number(opt("samples", 5));
const DELAY = Number(opt("delay", 1500));
const SCENARIOS = opt("scenario", "normal,strip").split(",");
const CONDITIONS = opt("conditions", "cold,warm,cache").split(",");
const OUT = opt("out", "");

// ───────────────────────── fixtures (synthetic pictures only) ─────────────────────────

function crc32(buf) {
  return zlib.crc32(buf);
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Plain 8-bit RGB PNG written with node:zlib. `pixel(x, y)` returns [r, g, b]. */
function writePng(file, width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

/** A page-like picture: paper, panel frames, white ellipses with stripes standing in for lettering. */
function comicPixel(width, height, block) {
  return (x, y) => {
    const by = y % block;
    const rel = by / block;
    // Two bubbles per block, at the places the mock API reports them (0..1000 scale of the block).
    const bubbles = [
      [120, 80, 520, 190],
      [480, 560, 880, 690],
    ];
    for (const [x1, y1, x2, y2] of bubbles) {
      const cx = ((x1 + x2) / 2 / 1000) * width;
      const cy = ((y1 + y2) / 2 / 1000) * block;
      const rx = (((x2 - x1) / 2) / 1000) * width;
      const ry = (((y2 - y1) / 2) / 1000) * block;
      const dx = (x - cx) / rx;
      const dy = (by - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d < 1) return Math.floor((by - cy) / 9) % 2 === 0 && Math.abs(dx) < 0.7 ? [30, 30, 30] : [252, 252, 252];
      if (d < 1.08) return [10, 10, 10];
    }
    const frame = x % Math.floor(width / 2) < 6 || by < 6;
    if (frame) return [20, 20, 20];
    const shade = 200 + Math.round(40 * Math.sin((x + y) / 90) * Math.cos(rel * 6));
    return [shade, shade - 6, shade - 14];
  };
}

function ensureFixtures() {
  const img = path.join(fixturesDir, "img");
  const make = (name, w, h, block) => {
    const file = path.join(img, name);
    if (!fs.existsSync(file)) writePng(file, w, h, comicPixel(w, h, block));
  };
  make("page-1200x1700.png", 1200, 1700, 1700);
  make("strip-800x10000.png", 800, 10000, 3072);
}

// ───────────────────────── static server ─────────────────────────

function startStatic() {
  const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".js": "text/javascript" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const file = path.join(fixturesDir, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""));
    if (!file.startsWith(fixturesDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => new Promise((d) => server.close(() => d())) }));
  });
}

// ───────────────────────── Chrome over the DevTools pipe ─────────────────────────

class Chrome {
  constructor(profileDir) {
    this.profileDir = profileDir;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.buffer = "";
  }

  async start() {
    fs.mkdirSync(this.profileDir, { recursive: true });
    const flags = [
      "--headless=new",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "--mute-audio",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-sync",
      "about:blank",
    ];
    this.proc = spawn(CHROME, flags, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
    this.pid = this.proc.pid;
    this.write = this.proc.stdio[3];
    this.read = this.proc.stdio[4];
    this.read.on("data", (chunk) => this.onData(chunk));
    this.exited = new Promise((resolve) => this.proc.once("exit", resolve));
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let at;
    while ((at = this.buffer.indexOf("\0")) >= 0) {
      const text = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!text) continue;
      const msg = JSON.parse(text);
      if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
          else waiter.resolve(msg.result);
        }
      } else {
        for (const l of this.listeners) l(msg);
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.write.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  /** Kills only the process this object started (and its children), by PID. */
  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    spawnSync("taskkill", ["/PID", String(this.pid), "/T", "/F"], { stdio: "ignore" });
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 5000))]);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs, label, stepMs = 100) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

class Session {
  constructor(chrome, { mock, staticServer }) {
    this.chrome = chrome;
    this.mock = mock;
    this.staticServer = staticServer;
    /** Console messages and exceptions of the pages and the worker (printed with --verbose). */
    this.logs = [];
    chrome.listeners.push((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        this.logs.push(`exception: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
      } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
        this.logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
      }
    });
  }

  /** Starts Chrome, loads the extension, and writes the mock-API settings into the throw-away profile. */
  async open() {
    await this.chrome.start();
    const loaded = await until(async () => {
      try {
        return await this.chrome.send("Extensions.loadUnpacked", { path: EXT_DIR });
      } catch (error) {
        if (/not.*(available|supported)|wasn't found/i.test(String(error))) throw error;
        return null;
      }
    }, 20000, "Extensions.loadUnpacked");
    this.extId = loaded.id;
    await this.chrome.send("Target.setDiscoverTargets", { discover: true });
    const sw = await until(async () => {
      const { targetInfos } = await this.chrome.send("Target.getTargets");
      return targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${this.extId}/`));
    }, 20000, "the extension service worker");
    const { sessionId } = await this.chrome.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    this.sw = sessionId;
    await this.chrome.send("Runtime.enable", {}, this.sw);
    await this.swEval(`(async () => {
      await chrome.storage.local.set({
        "backend-choice": "direct",
        "direct-api": { provider: "custom", baseUrl: ${JSON.stringify(this.mock.baseUrl)}, apiKey: "sk-mock-not-a-secret", model: "mock-vision", maxTokens: 4096, disableThinking: false },
      });
      await chrome.storage.sync.set({ "skip-bbox-refining": true, "auto-translate": false });
    })()`);
  }

  async swEval(expression) {
    const res = await this.chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, this.sw);
    if (res.exceptionDetails) throw new Error(`service worker: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  }

  async openPage(url) {
    const { targetId } = await this.chrome.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.chrome.send("Target.attachToTarget", { targetId, flatten: true });
    await this.chrome.send("Page.enable", {}, sessionId);
    await this.chrome.send("Runtime.enable", {}, sessionId);
    await this.chrome.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.chrome.send("Page.navigate", { url }, sessionId);
    await until(async () => (await this.pageEval({ sessionId }, "document.readyState")) === "complete", 20000, "page load");
    return { targetId, sessionId, url };
  }

  async pageEval(page, expression) {
    const res = await this.chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, page.sessionId);
    if (res.exceptionDetails) throw new Error(`page: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  }

  async closePage(page) {
    await this.chrome.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
  }

  async perfLog() {
    return (await this.swEval(`chrome.storage.local.get("perf-log").then((r) => r["perf-log"] ?? [])`)) ?? [];
  }

  async clearPerfLog() {
    await this.swEval(`chrome.storage.local.remove("perf-log")`);
  }

  /** Sends the right-click (a real mouse event) and then the menu command, like the browser does for the menu entry. */
  async rightClickAndTranslate(page, point, srcUrl, { sendSrc = true } = {}) {
    await this.chrome.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, page.sessionId);
    await this.chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "right", clickCount: 1 }, page.sessionId);
    await this.chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "right", clickCount: 1 }, page.sessionId);
    return this.sendMenuCommand(page, srcUrl, sendSrc);
  }

  async sendMenuCommand(page, srcUrl, sendSrc = true) {
    const data = { clickedAt: Date.now(), frameId: 0, ...(sendSrc && srcUrl ? { srcUrl } : {}) };
    return until(
      async () => {
        const ok = await this.swEval(`(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((t) => t.url === ${JSON.stringify(page.url)});
          if (!tab) return "no-tab";
          try { await chrome.tabs.sendMessage(tab.id, { type: "CONTEXT_TRANSLATE_IMAGE", data: ${JSON.stringify(data)} }); return "sent"; }
          catch (e) { return String(e.message || e); }
        })()`);
        return ok === "sent" ? data.clickedAt : null;
      },
      15000,
      "the content script to take the menu command",
      200,
    );
  }

  /** The menu entry "translate this page's pictures" (queues every loaded picture, none of them by hand). */
  async sendPageCommand(page) {
    const ok = await this.swEval(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === ${JSON.stringify(page.url)});
      if (!tab) return "no-tab";
      try { await chrome.tabs.sendMessage(tab.id, { type: "CONTEXT_TRANSLATE_PAGE" }); return "sent"; } catch (e) { return String(e.message || e); }
    })()`);
    if (ok !== "sent") throw new Error(`page command: ${ok}`);
  }

  async close() {
    if (flag("verbose") && this.logs.length) console.log(`\nbrowser log:\n${this.logs.slice(-30).join("\n")}`);
    await this.chrome.stop();
  }
}

// ───────────────────────── measuring ─────────────────────────

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (n) => (n === null || n === undefined ? "-" : Math.round(n));

const SCENARIO = {
  normal: { page: "normal.html", image: "img/page-1200x1700.png", point: { x: 640, y: 300 } },
  strip: { page: "strip.html", image: "img/strip-800x10000.png", point: { x: 640, y: 300 } },
  // The same strip, read down to the third segment (rows 5652-8724): the click is at row 6500.
  "strip-mid": { page: "strip.html", image: "img/strip-800x10000.png", point: { x: 640, y: 300 }, scroll: 6200 },
};

function imageUrl(base, scenario, tag) {
  return `${base}/${SCENARIO[scenario].image}?v=${tag}`;
}

/** The first record after the first `before` ones that `pick` accepts (default: any). */
async function waitForRecord(session, before, timeoutMs = 90000, pick = () => true) {
  return until(async () => {
    const log = await session.perfLog();
    return log.slice(before).find(pick) ?? null;
  }, timeoutMs, "a timing record", 250);
}
const isStrip = (record) => record.height === 10000;

async function oneRun(session, base, scenario, tag, { scrollTo = 0 } = {}) {
  const spec = SCENARIO[scenario];
  const url = `${base}/${spec.page}?v=${tag}`;
  const page = await session.openPage(url);
  if (scrollTo) await session.pageEval(page, `window.scrollTo(0, ${scrollTo})`);
  await sleep(400);
  const before = (await session.perfLog()).length;
  const srcUrl = `${base}/${spec.image}?v=${tag}`;
  await session.rightClickAndTranslate(page, spec.point, srcUrl);
  const record = await waitForRecord(session, before);
  await sleep(600); // the page cache write is fire-and-forget
  return { page, record, url };
}

async function measureScenario(scenario, ctx) {
  const rows = {};
  const base = `http://127.0.0.1:${ctx.staticServer.port}`;
  const scroll = SCENARIO[scenario].scroll ?? 0;
  const samples = { cold: [], warm: [], cache: [] };

  if (CONDITIONS.includes("cold")) {
    for (let i = 0; i < SAMPLES; i++) {
      const dir = path.join(profilesRoot, `cold-${Date.now()}-${i}`);
      const session = new Session(new Chrome(dir), ctx);
      try {
        await session.open();
        await sleep(500);
        const { record, page } = await oneRun(session, base, scenario, `cold${i}`, { scrollTo: scroll });
        samples.cold.push(record);
        await session.closePage(page);
      } finally {
        await session.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  if (CONDITIONS.includes("warm") || CONDITIONS.includes("cache")) {
    const dir = path.join(profilesRoot, `warm-${Date.now()}`);
    const session = new Session(new Chrome(dir), ctx);
    try {
      await session.open();
      await sleep(500);
      // Warm-up: another picture first, so the worker, the offscreen document and the fonts are ready.
      const warmUp = await oneRun(session, base, scenario, "warmup");
      await session.closePage(warmUp.page);
      for (let i = 0; i < SAMPLES; i++) {
        const run = await oneRun(session, base, scenario, `warm${i}`, { scrollTo: scroll });
        if (CONDITIONS.includes("warm")) samples.warm.push(run.record);
        if (CONDITIONS.includes("cache")) {
          // Same picture again after a reload: the page cache answers.
          await session.closePage(run.page);
          const again = await oneRun(session, base, scenario, `warm${i}`, { scrollTo: scroll });
          samples.cache.push(again.record);
          await session.closePage(again.page);
        } else {
          await session.closePage(run.page);
        }
      }
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [condition, records] of Object.entries(samples)) {
    if (!records.length) continue;
    rows[condition] = {
      n: records.length,
      firstVisibleMs: records.map((r) => r.firstVisibleMs),
      doneMs: records.map((r) => r.doneMs),
      records,
    };
  }
  return rows;
}

function summarize(rows) {
  const lines = [];
  for (const [scenario, byCondition] of Object.entries(rows)) {
    for (const [condition, row] of Object.entries(byCondition)) {
      const f = row.firstVisibleMs.filter((x) => typeof x === "number");
      const d = row.doneMs.filter((x) => typeof x === "number");
      const stat = (xs) => (xs.length ? `${fmt(median(xs))} (${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))})` : "-");
      lines.push(`${scenario.padEnd(7)} ${condition.padEnd(6)} n=${row.n} first-sentence ${stat(f)} ms | whole-image ${stat(d)} ms`);
    }
  }
  return lines.join("\n");
}

// ───────────────────────── page checks (--check) ─────────────────────────

const STATE_JS = `(() => {
  const bar = document.querySelector("lmt-task-status");
  const lines = bar && bar.shadowRoot
    ? [...bar.shadowRoot.querySelectorAll("[role=status]")].map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent.trim().replace(/\\s+/g, " "), phase: e.dataset.phase || "", left: Math.round(r.left), top: Math.round(r.top) }; })
    : [];
  const overlays = [...document.querySelectorAll("lmt-overlay")].map((h) => {
    const own = h.parentElement && h.parentElement.querySelector(":scope > img, :scope > canvas");
    return { imgId: own ? own.id : "", shown: !!(h.shadowRoot && h.shadowRoot.querySelector("img")), mode: h.parentElement ? h.parentElement.getAttribute("data-lmt-mode") : "", note: h.parentElement ? h.parentElement.getAttribute("data-lmt-progress") : "" };
  });
  return { lines, overlays, trigger: !!document.querySelector("lmt-floating-trigger"), scrollY: Math.round(scrollY) };
})()`;

async function runChecks(ctx) {
  const results = [];
  const base = `http://127.0.0.1:${ctx.staticServer.port}`;
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  };
  const dir = path.join(profilesRoot, `check-${Date.now()}`);
  const session = new Session(new Chrome(dir), ctx);

  /** Polls the page state until `done(state)` is true, and returns every distinct status line text seen on the way. */
  const watch = async (page, done, timeoutMs = 60000) => {
    const texts = [];
    const start = Date.now();
    for (;;) {
      const state = await session.pageEval(page, STATE_JS);
      for (const line of state.lines) if (line.phase && texts[texts.length - 1] !== line.text) texts.push(line.text);
      if (done(state)) return { state, texts };
      if (Date.now() - start > timeoutMs) return { state, texts, timedOut: true };
      await sleep(60);
    }
  };
  const pointOf = (page, selector) =>
    session.pageEval(page, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(Math.min(Math.max(r.top + 120, 60), innerHeight - 60)) }; })()`);

  try {
    await session.open();
    await sleep(500);

    // 1. Plain picture: no floating button, status line goes through the real stages, moving the mouse changes nothing.
    {
      const page = await session.openPage(`${base}/normal.html?v=check1`);
      await sleep(300);
      const point = await pointOf(page, "#page");
      await session.rightClickAndTranslate(page, point, `${base}/img/page-1200x1700.png?v=check1`);
      await session.chrome.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, page.sessionId);
      const { state, texts, timedOut } = await watch(page, (s) => s.overlays.some((o) => o.shown));
      check("plain picture: translated picture is shown", !timedOut && state.overlays.length === 1, texts.join(" > "));
      check("plain picture: no floating translate button on the page", state.trigger === false);
      check("plain picture: status line shows the stages in order", texts[0] === "排队中" || texts[0] === "正在取图", texts.join(" > "));
      check("plain picture: status line says 翻译中 before the end", texts.includes("翻译中"), texts.join(" > "));
      await sleep(1500);
      const after = await session.pageEval(page, STATE_JS);
      check("plain picture: status line is gone after 完成", after.lines.length === 0, JSON.stringify(after.lines));
      await session.closePage(page);
    }

    // 2. Transparent flip layer (no address from the browser), a picture inside a link, and a click on nothing.
    {
      const page = await session.openPage(`${base}/overlay.html`);
      await sleep(300);
      const requestsBefore = ctx.mock.control.count;
      const layered = await pointOf(page, "#layered");
      await session.rightClickAndTranslate(page, layered, undefined, { sendSrc: false });
      const first = await watch(page, (s) => s.overlays.some((o) => o.shown));
      const owner = first.state.overlays.find((o) => o.shown);
      check("flip layer: the picture under the transparent layer is translated", !first.timedOut && !!owner);
      const wrapperParent = await session.pageEval(page, `(() => { const h = document.querySelector("lmt-overlay"); return h && h.parentElement && h.parentElement.parentElement ? h.parentElement.parentElement.id : ""; })()`);
      check("flip layer: it is the one inside the layer's stage, not the linked one", wrapperParent === "layered", wrapperParent);

      const noteBefore = ctx.mock.control.count;
      await session.rightClickAndTranslate(page, { x: 20, y: 20 }, undefined, { sendSrc: false });
      let note = "";
      for (let i = 0; i < 20 && !note; i++) {
        await sleep(100);
        const s = await session.pageEval(page, STATE_JS);
        note = s.lines.find((l) => l.phase === "")?.text ?? "";
      }
      check("no comic under the click: short note, nothing translated", note === "这里没找到漫画图片" && ctx.mock.control.count === noteBefore, note);

      const linked = await pointOf(page, "#linked");
      await session.rightClickAndTranslate(page, linked, `${base}/img/page-1200x1700.png?v=link`);
      const second = await watch(page, (s) => s.overlays.filter((o) => o.shown).length >= 2);
      check("link: the picture inside a link is translated too", !second.timedOut);
      check("requests: one per picture, none for the click on nothing", ctx.mock.control.count - requestsBefore === 2, String(ctx.mock.control.count - requestsBefore));
      await session.closePage(page);
    }

    // 3. Canvas reader: no address at all.
    {
      const page = await session.openPage(`${base}/canvas.html`);
      await sleep(800);
      const point = await pointOf(page, "#page");
      await session.rightClickAndTranslate(page, point, undefined, { sendSrc: false });
      const out = await watch(page, (s) => s.overlays.some((o) => o.shown));
      check("canvas: the canvas is found by the click position and translated", !out.timedOut && out.state.overlays[0]?.imgId === "page");
      await session.closePage(page);
    }

    // 4. The same picture address twice: the clicked copy is the one that is translated; both lines stay apart.
    {
      const page = await session.openPage(`${base}/dup.html`);
      await sleep(300);
      await session.pageEval(page, "window.scrollTo(0, 800)");
      await sleep(200);
      const second = await pointOf(page, "#second");
      await session.rightClickAndTranslate(page, second, `${base}/img/page-1200x1700.png?v=same`);
      const out = await watch(page, (s) => s.overlays.length >= 1 && s.overlays.some((o) => o.shown));
      check("same address twice: right-click on the second translates the second", !out.timedOut && out.state.overlays.length === 1 && out.state.overlays[0].imgId === "second", JSON.stringify(out.state.overlays));
      await sleep(1200);
      const first = await pointOf(page, "#first");
      await session.rightClickAndTranslate(page, first, `${base}/img/page-1200x1700.png?v=same`);
      const both = await watch(page, (s) => s.overlays.filter((o) => o.shown).length >= 2);
      const ids = both.state.overlays.map((o) => o.imgId).sort().join(",");
      check("same address twice: the first can be translated afterwards, each has its own overlay", !both.timedOut && ids === "first,second", ids);
      await session.closePage(page);
    }

    // 5. Long strip: the first sentence comes long before the whole picture; read to the middle, that segment goes first.
    {
      await sleep(1500); // records of the earlier pages are written a moment after they finish
      const before = (await session.perfLog()).length;
      const page = await session.openPage(`${base}/strip.html?v=check5`);
      await sleep(300);
      ctx.mock.control.count = 0;
      await session.rightClickAndTranslate(page, SCENARIO.strip.point, `${base}/img/strip-800x10000.png?v=check5`);
      const rec = await waitForRecord(session, before, 90000, isStrip);
      check("strip: the first sentence is painted well before the whole picture", rec.firstVisibleMs !== null && rec.doneMs !== null && rec.doneMs - rec.firstVisibleMs > 3000, `${rec.firstVisibleMs} ms / ${rec.doneMs} ms`);
      // The strip was drawn piece by piece (erasing only the new regions each time). Opened again from the page cache it is
      // drawn in one go from the original: the two pictures must be the same.
      const srcOf = (p) => session.pageEval(p, `(() => { const h = document.querySelector("lmt-overlay"); const i = h && h.shadowRoot && h.shadowRoot.querySelector("img"); return i ? i.src : ""; })()`);
      await sleep(800);
      const grownSrc = await srcOf(page);
      await session.closePage(page);
      const again = await session.openPage(`${base}/strip.html?v=check5`);
      await sleep(300);
      await session.rightClickAndTranslate(again, SCENARIO.strip.point, `${base}/img/strip-800x10000.png?v=check5`);
      await watch(again, (s) => s.overlays.some((o) => o.shown));
      await sleep(500);
      const wholeSrc = await srcOf(again);
      if (process.env.RAWREADER_DUMP_DIR) {
        // Debug aid: keep the two pictures to look at them.
        const save = (name, src) => fs.writeFileSync(path.join(process.env.RAWREADER_DUMP_DIR, name), Buffer.from(src.split(",")[1] ?? "", "base64"));
        fs.mkdirSync(process.env.RAWREADER_DUMP_DIR, { recursive: true });
        save("strip-piece-by-piece.png", grownSrc);
        save("strip-in-one-go.png", wholeSrc);
      }
      // Piece by piece, only the new regions are erased on top of the picture cleaned before; in one go everything is erased
      // from the original. Not byte-identical: where two boxes overlap, the order of erasing changes the fill. The mock answers
      // every segment with the same relative boxes, so neighbouring segments produce overlapping boxes (about 0.3 % of the
      // picture); a real strip does not. Everything else must match.
      const diff = await session.pageEval(again, `(async () => {
        const load = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
        const [a, b] = await Promise.all([load(${JSON.stringify(grownSrc)}), load(${JSON.stringify(wholeSrc)})]);
        if (a.width !== b.width || a.height !== b.height) return { size: false };
        const pixels = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
        const da = pixels(a), db = pixels(b);
        let different = 0, biggest = 0;
        for (let k = 0; k < da.length; k += 4) { const d = Math.max(Math.abs(da[k] - db[k]), Math.abs(da[k + 1] - db[k + 1]), Math.abs(da[k + 2] - db[k + 2])); if (d > 12) different++; if (d > biggest) biggest = d; }
        return { size: true, share: different / (da.length / 4), biggest };
      })()`);
      check("strip: drawn piece by piece it is the same picture as drawn in one go (page cache)", grownSrc !== "" && diff.size === true && diff.share < 0.005, JSON.stringify(diff));
      await session.closePage(again);
      check("strip: four segments, four requests, the picture decoded once", rec.bg?.segments === 4 && ctx.mock.control.count === 4 && rec.bg?.decodeCount === 1, `requests ${ctx.mock.control.count}, decodes ${rec.bg?.decodeCount}`);

      const before2 = (await session.perfLog()).length;
      const mid = await session.openPage(`${base}/strip.html?v=check5b`);
      await session.pageEval(mid, "window.scrollTo(0, 6200)");
      await sleep(400);
      await session.rightClickAndTranslate(mid, SCENARIO.strip.point, `${base}/img/strip-800x10000.png?v=check5b`);
      const rec2 = await waitForRecord(session, before2, 90000, isStrip);
      const order = (rec2.bg?.segmentArrivals ?? []).map((a) => a.segment);
      check("strip read to the middle: the segment around the click is read first", order[0] === 2, `arrival order ${order.join(",")}`);
      check("strip read to the middle: first sentence at about one request time", rec2.firstVisibleMs !== null && rec2.firstVisibleMs < DELAY + 2500, `${rec2.firstVisibleMs} ms`);
      await session.closePage(mid);
    }

    // 6. One segment fails twice: the other three stay, nothing is cached, only that segment is asked for again.
    {
      const before = (await session.perfLog()).length;
      const page = await session.openPage(`${base}/strip.html?v=check6`);
      await sleep(300);
      ctx.mock.control.count = 0;
      ctx.mock.control.failOn = new Set([2, 3]);
      const cacheKeys = () => session.swEval(`chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith("page-cache-")).length)`);
      const cachedBefore = await cacheKeys();
      await session.rightClickAndTranslate(page, SCENARIO.strip.point, `${base}/img/strip-800x10000.png?v=check6`);
      const out = await watch(page, (s) => s.lines.some((l) => l.phase === "partial"), 90000);
      const line = out.state.lines.find((l) => l.phase === "partial");
      check("failed segment: the status line names it", !!line && /第 2 段失败/.test(line.text), line?.text ?? "none");
      await sleep(800);
      const shown = await session.pageEval(page, STATE_JS);
      check("failed segment: the picture is shown with the other segments", shown.overlays.some((o) => o.shown));
      check("failed segment: nothing is cached", (await cacheKeys()) === cachedBefore, String(await cacheKeys()));
      const requestsAfterRun = ctx.mock.control.count;
      ctx.mock.control.failOn = new Set();
      await session.pageEval(page, `(() => { const bar = document.querySelector("lmt-task-status"); const b = [...bar.shadowRoot.querySelectorAll("button")].find((x) => x.textContent.trim() === "重试"); b && b.click(); return !!b; })()`);
      const retried = await watch(page, (s) => s.lines.some((l) => l.phase === "done") || s.lines.length === 0, 60000);
      await sleep(1200);
      check("retry: only the failed segment is requested", ctx.mock.control.count - requestsAfterRun === 1, String(ctx.mock.control.count - requestsAfterRun));
      check("retry: the picture is complete and now cached", !retried.timedOut && (await cacheKeys()) === cachedBefore + 1, String(await cacheKeys()));
      const rec = (await session.perfLog()).slice(before).filter(isStrip).pop();
      check("failed segment: the timing record says partial", rec?.outcome === "partial", rec?.outcome);
      await session.closePage(page);
    }

    // 7. Queue order: pictures queued from off screen first, then the menu click on the strip that is in view.
    {
      const page = await session.openPage(`${base}/queue.html`);
      await session.pageEval(page, "window.scrollTo(0, 9000)"); // rows 9000-9900 of the strip are in view, the five pictures are below
      await sleep(500);
      await sleep(1500);
      const before = (await session.perfLog()).length;
      await session.sendPageCommand(page); // queue order: far1..far5, then the strip; three run at once
      await sleep(200);
      await session.rightClickAndTranslate(page, SCENARIO.strip.point, `${base}/img/strip-800x10000.png?v=queue`);
      const records = [];
      await until(async () => {
        const log = (await session.perfLog()).slice(before);
        records.length = 0;
        records.push(...log);
        return log.length >= 6;
      }, 180000, "six timing records", 500);
      const strip = records.find(isStrip);
      const far = records.filter((r) => !isStrip(r)).sort((a, b) => a.marks.dequeue - b.marks.dequeue);
      check("queue: the strip was started before the 4th and 5th off-screen picture", !!strip && far.length === 5 && strip.marks.dequeue < far[3].marks.dequeue, `strip ${strip?.marks.dequeue} ms, off-screen starts ${far.map((r) => Math.round(r.marks.dequeue)).join(", ")}`);
      check("queue: the strip is the manual one", strip?.origin === "manual", strip?.origin);
      await session.closePage(page);
    }

    // 8. Reading history: a translation writes one entry, the popup lists, searches, opens, deletes and clears.
    {
      const readHistory = () => session.swEval(`chrome.storage.local.get("reading-history").then((r) => r["reading-history"] ?? [])`);
      await session.swEval(`chrome.storage.local.remove("reading-history")`);
      const translateOnce = async (url, srcPath) => {
        const page = await session.openPage(url);
        await sleep(300);
        await session.rightClickAndTranslate(page, SCENARIO.normal.point, `${base}/${srcPath}`);
        await watch(page, (s) => s.overlays.some((o) => o.shown));
        await sleep(400);
        await session.closePage(page);
      };
      await translateOnce(`${base}/normal.html?v=hist1&utm_source=newsletter#top`, "img/page-1200x1700.png?v=hist1");
      let history = await readHistory();
      check("history: a translation writes one entry", history.length === 1, String(history.length));
      check("history: the address has no fragment and no tracking parameter, the title is kept", history[0]?.url === `${base}/normal.html?v=hist1` && /Sample Series/.test(history[0]?.title ?? ""), history[0]?.url);
      check("history: only the planned fields are stored", Object.keys(history[0] ?? {}).sort().join(",") === "chapter,firstVisitedAt,id,lastVisitedAt,series,site,title,url,visits", Object.keys(history[0] ?? {}).sort().join(","));
      await translateOnce(`${base}/strip.html?v=hist2`, "img/strip-800x10000.png?v=hist2");
      history = await readHistory();
      check("history: another page address is a second entry, newest first", history.length === 2 && /strip\.html/.test(history[0]?.url ?? ""), history.map((h) => h.url.split("/").pop()).join(" | "));

      await session.swEval(`chrome.storage.local.set({ "reading-history-enabled": false })`);
      await translateOnce(`${base}/normal.html?v=hist3`, "img/page-1200x1700.png?v=hist3");
      check("history: the switch turns recording off and keeps what is there", (await readHistory()).length === 2);
      await session.swEval(`chrome.storage.local.remove("reading-history-enabled")`);

      // The popup.
      const popup = await session.openPage(`chrome-extension://${session.extId}/popup.html`);
      await sleep(600);
      const click = (js) => session.pageEval(popup, js);
      await click(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "历史").click()`);
      await until(async () => (await click(`document.querySelectorAll("[data-history-id]").length`)) === 2, 8000, "two history rows");
      check("history popup: lists both pages", true);
      const hasPermission = await session.swEval(`chrome.runtime.getManifest().permissions.includes("history")`);
      check("history: the manifest has no history permission", hasPermission === false);
      await click(`(() => { const i = document.querySelector("input[type=text]"); i.value = "STRIP"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await until(async () => (await click(`document.querySelectorAll("[data-history-id]").length`)) === 1, 8000, "search to narrow the list");
      check("history popup: search narrows the list without regard to case", true);
      const targetsBefore = (await session.chrome.send("Target.getTargets")).targetInfos.length;
      await click(`document.querySelector("[data-history-id] button").click()`);
      const opened = await until(async () => {
        const { targetInfos } = await session.chrome.send("Target.getTargets");
        return targetInfos.length > targetsBefore && targetInfos.some((t) => /strip\.html\?v=hist2/.test(t.url)) ? true : null;
      }, 8000, "the page to open in a new tab").catch(() => false);
      check("history popup: a click opens the page in a new tab", opened === true);
      await click(`document.querySelector('button[aria-label="删除这条记录"]').click()`);
      await until(async () => (await readHistory()).length === 1, 8000, "one entry to be deleted");
      check("history popup: delete removes one entry", (await readHistory())[0]?.url === `${base}/normal.html?v=hist1`);
      await click(`window.confirm = () => true; [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "清空全部").click()`);
      await until(async () => (await readHistory()).length === 0, 8000, "the history to be cleared");
      check("history popup: clear removes everything", true);
      await session.closePage(popup);
    }
  } finally {
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed ? 1 : 0;
}

// ───────────────────────── main ─────────────────────────

async function main() {
  if (!fs.existsSync(path.join(EXT_DIR, "manifest.json"))) throw new Error(`no built extension at ${EXT_DIR}`);
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
  ensureFixtures();
  const mock = await startMock({ delayMs: DELAY });
  const staticServer = await startStatic();
  const ctx = { mock, staticServer };
  let exitCode = 0;
  try {
    if (flag("smoke")) {
      const dir = path.join(profilesRoot, `smoke-${Date.now()}`);
      const session = new Session(new Chrome(dir), ctx);
      try {
        await session.open();
        console.log(`extension loaded: ${session.extId}, mock API ${mock.baseUrl}`);
        const base = `http://127.0.0.1:${staticServer.port}`;
        const spec = SCENARIO[SCENARIOS[0]] ?? SCENARIO.normal;
        const page = await session.openPage(`${base}/${spec.page}`);
        if (spec.scroll) await session.pageEval(page, `window.scrollTo(0, ${spec.scroll})`);
        await sleep(500);
        const started = Date.now();
        await session.rightClickAndTranslate(page, spec.point, `${base}/${spec.image}`);
        let last = "";
        for (let i = 0; i < 160; i++) {
          const s = await session.pageEval(page, STATE_JS);
          const text = `${Date.now() - started} ms  lines=${JSON.stringify(s.lines.map((l) => l.text))} overlays=${JSON.stringify(s.overlays)} requests=${mock.control.count}`;
          if (text.replace(/^\d+ ms /, "") !== last.replace(/^\d+ ms /, "")) console.log(text);
          last = text;
          if (s.overlays.some((o) => o.shown) && !s.lines.length) break;
          await sleep(250);
        }
      } finally {
        await session.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } else if (flag("check")) {
      exitCode = await runChecks(ctx);
    } else {
      const rows = {};
      for (const scenario of SCENARIOS) {
        mock.control.count = 0;
        rows[scenario] = await measureScenario(scenario, ctx);
      }
      console.log(`\nMOCK API measurement (fixed ${DELAY} ms per request, not a real service). label=${LABEL}\n${summarize(rows)}`);
      if (OUT) {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, mock: true, delayMs: DELAY, samples: SAMPLES, rows }, null, 2));
        console.log(`written ${OUT}`);
      }
    }
  } finally {
    await mock.close();
    await staticServer.close();
    fs.rmSync(profilesRoot, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(profilesRoot, { recursive: true, force: true });
  process.exitCode = 1;
});
