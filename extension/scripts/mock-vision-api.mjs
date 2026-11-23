// Local stand-in for a vision translation API (OpenAI-compatible POST <base>/chat/completions).
// Used only by the headless measurements (scripts/perf-headless.mjs). It never forwards anything anywhere:
// it answers every request from this machine with fixed boxes and Chinese text after a fixed delay.
//
// Run by hand:  node scripts/mock-vision-api.mjs [--port 0] [--delay 1500] [--fail 2,3]
//   --delay  milliseconds every request waits before it is answered (default 1500)
//   --fail   request numbers (1-based, counted from the last reset) that answer HTTP 500
// Control endpoints (GET/POST, same server):
//   /__reset                 zero the counter and clear the log
//   /__config?delay=800&fail=2,3   change the delay and the failing request numbers
//   /__log                   JSON list of the requests seen: number, time, sent size, region count, answered status
import http from "node:http";

/** Pulls the sent image size ("1200x1700 pixels") and the region count out of the prompt the extension builds. */
export function readPrompt(text) {
  const size = /(\d+)x(\d+) pixels/.exec(text);
  const regions = /Return exactly (\d+) items/.exec(text);
  const boxes = [...text.matchAll(/^\d+\. \[(\d+),(\d+),(\d+),(\d+)\]$/gm)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  return {
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    regionCount: regions ? Number(regions[1]) : 0,
    regions: boxes,
  };
}

/** The fixed answer: two bubbles per image, or one item per region the extension asked for. */
export function answerFor(prompt, n) {
  if (prompt.regionCount > 0) {
    return {
      items: prompt.regions.slice(0, prompt.regionCount).map((box, i) => ({ box, source: `原文${i + 1}`, translation: `区域译文 ${n}-${i + 1}` })),
    };
  }
  return {
    items: [
      { box: [120, 80, 520, 190], source: "こんにちは", translation: `你好，这是第 ${n} 次请求的第一句` },
      { box: [480, 560, 880, 690], source: "さようなら", translation: `再见，这是第 ${n} 次请求的第二句` },
    ],
  };
}

export function startMock({ port = 0, delayMs = 1500, failOn = [] } = {}) {
  const state = { delayMs, failOn: new Set(failOn), count: 0, log: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/__reset") {
      state.count = 0;
      state.log = [];
      return json(200, { ok: true });
    }
    if (url.pathname === "/__config") {
      if (url.searchParams.has("delay")) state.delayMs = Number(url.searchParams.get("delay")) || 0;
      if (url.searchParams.has("fail")) {
        state.failOn = new Set((url.searchParams.get("fail") ?? "").split(",").filter(Boolean).map(Number));
      }
      return json(200, { delayMs: state.delayMs, failOn: [...state.failOn] });
    }
    if (url.pathname === "/__log") return json(200, state.log);
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return json(404, { error: { message: "not found" } });

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const n = ++state.count;
      const receivedAt = Date.now();
      let prompt = { width: 0, height: 0, regionCount: 0, regions: [] };
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const content = body?.messages?.[0]?.content;
        const text = Array.isArray(content) ? content.find((p) => p?.type === "text")?.text ?? "" : String(content ?? "");
        prompt = readPrompt(text);
      } catch {
        // An unreadable body is answered like any other request.
      }
      const entry = { n, receivedAt, width: prompt.width, height: prompt.height, regions: prompt.regionCount, status: 0 };
      state.log.push(entry);
      setTimeout(() => {
        if (state.failOn.has(n)) {
          entry.status = 500;
          json(500, { error: { message: "mock failure" } });
          return;
        }
        entry.status = 200;
        json(200, { choices: [{ message: { content: JSON.stringify(answerFor(prompt, n)) }, finish_reason: "stop" }] });
      }, state.delayMs);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        control: state,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (isMain) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const mock = await startMock({
    port: Number(arg("port", 0)),
    delayMs: Number(arg("delay", 1500)),
    failOn: String(arg("fail", "")).split(",").filter(Boolean).map(Number),
  });
  console.log(`mock vision API on ${mock.baseUrl} (pid ${process.pid}); stop it with Ctrl+C`);
}
