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

  async close() {
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
};

function imageUrl(base, scenario, tag) {
  return `${base}/${SCENARIO[scenario].image}?v=${tag}`;
}

async function waitForRecord(session, before, timeoutMs = 90000) {
  return until(async () => {
    const log = await session.perfLog();
    return log.length > before ? log[log.length - 1] : null;
  }, timeoutMs, "a timing record", 250);
}

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
  const scroll = scenario === "strip" ? 0 : 0;
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

async function runChecks() {
  console.log("page checks are added with the right-click step");
  return 0;
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
        const page = await session.openPage(`${base}/normal.html`);
        await sleep(500);
        const started = Date.now();
        await session.rightClickAndTranslate(page, SCENARIO.normal.point, `${base}/${SCENARIO.normal.image}`);
        const state = () => session.pageEval(page, `(() => { const h = document.querySelector("lmt-overlay"); const i = h && h.shadowRoot && h.shadowRoot.querySelector("img"); return { host: !!h, img: !!i, trigger: !!document.querySelector("lmt-floating-trigger") }; })()`);
        const result = await until(async () => {
          const s = await state();
          return s.img ? s : null;
        }, 60000, "the translated picture", 250);
        console.log(`translated picture shown after ${Date.now() - started} ms (wall clock)`, result, "mock requests:", mock.control.count);
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
