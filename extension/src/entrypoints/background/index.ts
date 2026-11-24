// Portions ported from libre-manga-translator src/entrypoints/background/index.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: the model, download, GPU, WebLLM and api-mode handlers are gone. This worker keeps the
// image proxy (PROXY_IMAGE), the site-rule test, the offscreen relay for inpainting, and adds the only code
// that talks to the RawReader app: BRIDGE_PING and BRIDGE_TRANSLATE (design 5.1). No tab screenshots.
// Direct API mode (task 11): BRIDGE_TRANSLATE picks the backend per request (RawReader, else the configured
// direct API) and BACKEND_STATUS reports the choice. The API key is only read here, never sent to a page.
import { isAllowedImageUrl } from "@/lib/security";
import { arrayBufferToBase64DataUrl } from "@/lib/utils";
import { dataUrlToBytes, openHistoryInApp, pingBridge, postHistory, probeBridge, translateViaBridge } from "@/lib/bridge/client";
import { PriorityGate } from "@/lib/bridge/gate";
import { installBridgeOriginRule } from "@/lib/bridge/origin";
import {
  TASK_PORT_NAME,
  type BridgePingReply,
  type BridgeTaskStart,
  type BridgeTranslateMessage,
  type BridgeTranslateReply,
  type TaskEvent,
  type TaskPortRequest,
} from "@/lib/bridge/protocol";
import { DefaultConfig } from "@/lib/configs";
import { CONTEXT_MENU_ITEMS, MENU_TRANSLATE_IMAGE, messageForMenuClick } from "@/lib/context-menu";
import { translateDirect } from "@/lib/direct/client";
import { NO_BACKEND_CODE } from "@/lib/direct/errors";
import { createBrowserCodec } from "@/lib/direct/image-browser";
import { isDirectConfigured, originPatternFor } from "@/lib/direct/providers";
import { selectBackend, type BackendKind } from "@/lib/direct/select";
import type { BackendStatusReply } from "@/lib/direct/status";
import { loadBackendSettings } from "@/lib/direct/settings";
import { ImageDownloadError, proxyFetch, type ProxyFetchDeps, type SessionRuleApi } from "@/lib/image-proxy";
import { BRIDGE_TRANSLATE_TIMEOUT_MS, INPAINT_TIMEOUT_MS, MAX_BRIDGE_REQUESTS_PER_TAB } from "@/lib/timeouts";
import { appendPerfRecord, BgTimeline, PERF_LOG_KEY, type PerfRecord } from "@/lib/perf/timeline";
import {
  HISTORY_PENDING_KEY,
  addPending,
  mergePending,
  nextBatch,
  parsePending,
  pendingFromLegacy,
  removeSent,
  toBridgeItems,
} from "@/lib/history-sync";
import {
  MSG_HISTORY_OPEN,
  MSG_HISTORY_TOUCH,
  READING_HISTORY_ENABLED_KEY,
  READING_HISTORY_KEY,
  SerialQueue,
  parseHistory,
  type HistoryTouch,
} from "@/lib/reading-history";
import { createAsyncResponder, keepAliveWhile, withTimeout } from "./messaging";
import { ensureOffscreen } from "./utils";

/** Port that answered last time. Only a hint for the next probe; the app may have moved to another port. */
const BRIDGE_PORT_CACHE_KEY = "local:bridge-port-cache";

export default defineBackground(() => {
  // ── Measurement state: when this worker process started and how many tasks it has handled ──
  const workerStartedAt = performance.now();
  let workerTasks = 0;
  // Records are appended one after the other, so two tabs finishing together cannot overwrite each other.
  let perfWrites: Promise<unknown> = Promise.resolve();
  // Reading history: the history lives in the RawReader app. A visit waits in `local:history-pending` until the app has
  // taken it. Every change goes through this queue, one at a time, so two tabs finishing together cannot overwrite
  // each other.
  const historyWrites = new SerialQueue();
  const historyEnabled = async () => (await storage.getItem<boolean>(READING_HISTORY_ENABLED_KEY)) !== false;
  let lastHistoryFailAt = 0;
  /** After a failed attempt (app closed, old app) the queue waits this long before the next automatic try. */
  const HISTORY_RETRY_MS = 20_000;
  /**
   * Sends the waiting visits to the app. Without `force`, a recent failure skips the attempt. Older versions kept the
   * whole list here: it is moved into the queue once and removed. Visits leave the queue only after the app took them.
   */
  const flushHistory = (force = false) =>
    historyWrites
      .run(async () => {
        const legacy = parseHistory(await storage.getItem(READING_HISTORY_KEY));
        let pending = parsePending(await storage.getItem(HISTORY_PENDING_KEY));
        if (legacy.length > 0) {
          pending = mergePending(pending, pendingFromLegacy(legacy));
          await storage.setItem(HISTORY_PENDING_KEY, pending);
        }
        if ((await storage.getItem(READING_HISTORY_KEY)) !== null) await storage.removeItem(READING_HISTORY_KEY);
        if (pending.length === 0 || !(await historyEnabled())) return;
        if (!force && Date.now() - lastHistoryFailAt < HISTORY_RETRY_MS) return;
        const found = await findBridge();
        if (!found.ok) {
          lastHistoryFailAt = Date.now();
          return;
        }
        while (pending.length > 0) {
          const batch = nextBatch(pending);
          const reply = await postHistory({ port: found.port }, toBridgeItems(batch));
          if ("error" in reply) {
            lastHistoryFailAt = Date.now();
            return;
          }
          pending = removeSent(pending, batch);
          await storage.setItem(HISTORY_PENDING_KEY, pending);
        }
        lastHistoryFailAt = 0;
      })
      .catch((error) => console.warn("RawReader: reporting the reading history failed:", error));
  const savePerfRecord = (record: PerfRecord) => {
    perfWrites = perfWrites
      .then(async () => storage.setItem(PERF_LOG_KEY, appendPerfRecord(await storage.getItem<PerfRecord[]>(PERF_LOG_KEY), record)))
      .catch(() => {});
    return perfWrites;
  };
  // ── Per-tab state: a small concurrency cap and an abort switch for navigation ──
  const gates = new Map<number, PriorityGate>();
  const controllers = new Map<number, Set<AbortController>>();

  const gateFor = (tabId: number): PriorityGate => {
    let gate = gates.get(tabId);
    if (!gate) {
      gate = new PriorityGate(MAX_BRIDGE_REQUESTS_PER_TAB);
      gates.set(tabId, gate);
    }
    return gate;
  };

  const abortTab = (tabId: number) => {
    for (const controller of controllers.get(tabId) ?? []) controller.abort();
    controllers.delete(tabId);
  };

  browser.tabs.onRemoved.addListener((tabId) => {
    abortTab(tabId);
    gates.delete(tabId);
  });
  // A new page in the same tab: the old page's queued and running requests are no use any more.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) abortTab(tabId);
  });

  // Chrome sends no Origin on a GET from the service worker to a host it has permission for, and the app refuses
  // requests without the extension's Origin. This session rule adds it (see lib/bridge/origin.ts). It is set each
  // time the worker starts, and every bridge call waits for it.
  const originRuleReady = installBridgeOriginRule((browser as any).declarativeNetRequest, browser.runtime.id);

  /** Probes 18793-18797 (cached port first) and remembers the port that answered. */
  async function findBridge() {
    await originRuleReady;
    const cachedPort = await storage.getItem<number>(BRIDGE_PORT_CACHE_KEY).catch(() => null);
    const found = await probeBridge({ cachedPort });
    if (found.ok && found.port !== cachedPort) await storage.setItem(BRIDGE_PORT_CACHE_KEY, found.port).catch(() => {});
    return found;
  }

  const proxyDeps = (): ProxyFetchDeps => ({ dnr: (browser as any).declarativeNetRequest as Partial<SessionRuleApi> | undefined });

  /** Downloads the source image. Every failure here is an ImageDownloadError, so the caller can tell it apart. */
  async function imageBytes(src: string, referer: string | undefined): Promise<Uint8Array> {
    const inline = dataUrlToBytes(src);
    if (inline) return inline;
    try {
      if (!isAllowedImageUrl(src, referer)) throw new Error("安全拦截：图片地址不被允许或不安全");
      return new Uint8Array(await proxyFetch(src, referer, proxyDeps()));
    } catch (error) {
      throw new ImageDownloadError(error);
    }
  }

  // Opens the options page so the user can pick a backend. At most once per 10 minutes, so auto-translate on a
  // long page does not open a tab for every image.
  let lastGuideAt = 0;
  async function guideToOptions() {
    if (Date.now() - lastGuideAt < 10 * 60_000) return;
    lastGuideAt = Date.now();
    await browser.runtime.openOptionsPage().catch(() => {});
  }

  /**
   * One translation task. `emit` receives the task's events (stages, plan, segments): the page's task port passes
   * a function that posts them; the old one-shot message passes nothing.
   */
  async function runTask(
    data: BridgeTaskStart,
    tabId: number | undefined,
    controller: AbortController,
    emit: (event: TaskEvent) => void,
  ): Promise<BridgeTranslateReply> {
    const { src, referer, boxes, context, priority = 0, focus, onlySegments } = data;
    const key = tabId ?? -1;
    if (!controllers.has(key)) controllers.set(key, new Set());
    controllers.get(key)!.add(controller);
    let release: (() => void) | null = null;
    // Timings for the measurement log (times only, no addresses or text).
    const cold = workerTasks === 0;
    workerTasks += 1;
    let perf: BgTimeline | null = null;
    const withPerf = (reply: BridgeTranslateReply): BridgeTranslateReply => (perf ? { ...reply, perf: perf.finish() } : reply);
    try {
      emit({ type: "stage", stage: "queued" });
      await originRuleReady;
      // Choose the backend for every request: the app may have been closed, reopened or moved to another port,
      // and the user may have changed the settings.
      const settings = await loadBackendSettings();
      const probe = settings.choice === "direct" ? null : await findBridge();
      const kind = selectBackend({
        choice: settings.choice,
        bridge: probe ? { reachable: probe.ok, ready: probe.ok && probe.ping.ready } : null,
        directConfigured: isDirectConfigured(settings.direct),
      });

      if (kind === "none") {
        void guideToOptions();
        return { error: { code: NO_BACKEND_CODE, message: "No translation backend is available" } };
      }

      perf = new BgTimeline(
        {
          backend: kind === "direct" ? "direct" : "rawreader",
          cold,
          workerAgeMs: performance.now() - workerStartedAt,
          ...(kind === "direct" ? { provider: settings.direct.provider, model: settings.direct.model } : {}),
        },
      );
      const gate = gateFor(key);

      if (kind === "direct") {
        const pattern = originPatternFor(settings.direct.baseUrl);
        if (!pattern || !(await browser.permissions.contains({ origins: [pattern] }).catch(() => false))) {
          return withPerf({ error: { code: "direct-permission", message: "No permission for the API host" } });
        }
        const bytes = await perf.timed((ms) => (perf!.perf.imageMs += ms), () => imageBytes(src, referer));
        const targetLang = (await storage.getItem<string>("sync:target-lang").catch(() => null)) ?? DefaultConfig.targetLang;
        const timeline = perf;
        // The direct API takes a place at the gate for each request, not for the whole picture: a long strip that
        // is only half read gives its place back between segments, so a task that matters more goes next.
        let segmentTotal = 0;
        let announced = false;
        const reply = await translateDirect(settings.direct, {
          acquireSlot: async () => {
            const waitStart = performance.now();
            const give = await gate.acquire(priority, controller.signal);
            timeline.addGateWait(performance.now() - waitStart);
            if (!announced) {
              announced = true;
              emit({ type: "stage", stage: "translating", done: 0, ...(segmentTotal > 0 ? { total: segmentTotal } : {}) });
            }
            return give;
          },
          bytes,
          codec: createBrowserCodec((ms) => timeline.addDecode(ms)),
          targetLang,
          context,
          boxes,
          signal: controller.signal,
          focus,
          onlySegments,
          onProgress: (_done, total) => {
            segmentTotal = total;
          },
          onSegment: (info) => {
            timeline.addSegmentArrival(info.index);
            emit({ type: "segment", index: info.index, total: info.total, done: info.done, units: info.units, truncated: info.truncated });
          },
          onSegmentFailed: (info) => {
            (timeline.perf.failedSegments ??= []).push(info.index);
            emit({ type: "segment-failed", index: info.index, total: info.total, code: info.error.code, message: info.error.message });
          },
          trace: {
            plan: (info) => {
              timeline.perf.width = info.width;
              timeline.perf.height = info.height;
              timeline.perf.segments = info.segments;
              emit({ type: "plan", width: info.width, height: info.height, segments: info.segments });
            },
            encode: (segment, ms) => timeline.addEncode(segment, ms),
            roundTrip: (entry) => timeline.addRoundTrip(entry),
            parse: (segment, ms) => {
              const last = [...timeline.perf.roundTrips].reverse().find((r) => r.segment === segment);
              if (last) last.parseMs += Math.round(ms * 10) / 10;
            },
          },
        });
        return withPerf(reply);
      }

      if (!probe || !probe.ok) return { error: probe && !probe.ok ? probe.error : { code: "unreachable", message: "Cannot reach the app" } };
      // The app takes one request at a time per tab slot; the whole translation holds the place.
      const gateStart = performance.now();
      release = await gate.acquire(priority, controller.signal);
      perf.addGateWait(performance.now() - gateStart);
      emit({ type: "stage", stage: "translating" });
      const bytes = await perf.timed((ms) => (perf!.perf.imageMs += ms), () => imageBytes(src, referer));
      const reply = await translateViaBridge({ port: probe.port }, { bytes, boxes, context, priority, signal: controller.signal, timeoutMs: BRIDGE_TRANSLATE_TIMEOUT_MS });
      if ("result" in reply) perf.perf.app = reply.result.timings;
      return withPerf(reply);
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return { error: { code: "timeout", message: "Cancelled" } };
      if (error instanceof ImageDownloadError) {
        console.error("RawReader: image download failed:", error.message);
        return { error: { code: "image-unavailable", message: error.message } };
      }
      console.error("RawReader: bridge translate failed:", error);
      return { error: { code: "internal-error", message: (error as Error)?.message ?? String(error) } };
    } finally {
      release?.();
      controllers.get(key)?.delete(controller);
    }
  }

  /** The old one-shot message (the options page's tests use it): same task, no events. */
  const bridgeTranslate = (msg: BridgeTranslateMessage, tabId: number | undefined): Promise<BridgeTranslateReply> =>
    runTask(msg.data, tabId, new AbortController(), () => {});

  // A page's translation task: one long-lived port. The page closing the port cancels the task.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== TASK_PORT_NAME) return;
    const controller = new AbortController();
    port.onDisconnect.addListener(() => controller.abort());
    let started = false;
    const post = (message: TaskEvent) => {
      try {
        port.postMessage(message);
      } catch {
        // The page is gone.
      }
    };
    port.onMessage.addListener((message: TaskPortRequest) => {
      if (started || message?.type !== "start" || !message.data) return;
      started = true;
      const run = runTask(message.data, port.sender?.tab?.id, controller, post).then((reply) => {
        post("error" in reply ? { type: "error", reply } : { type: "done", reply });
      });
      void keepAliveWhile(run);
    });
  });

  // Nothing to set up: look for the app at browser start and after an install or update, so the port is cached.
  browser.runtime.onStartup.addListener(() => {
    void findBridge();
    void flushHistory(true);
  });
  browser.runtime.onInstalled.addListener(() => void findBridge());
  // The worker wakes for many reasons: take this chance to hand over visits that are waiting for the app.
  void flushHistory();

  // ── Right-click menu: manual fallback for images that auto-detection missed ──
  // Menu items persist across worker restarts, so they are (re)created only on install or update.
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll(() => {
      for (const item of CONTEXT_MENU_ITEMS) {
        browser.contextMenus.create({ id: item.id, title: item.title, contexts: item.contexts }, () => {
          void browser.runtime.lastError; // Read the error so a duplicate id does not log "Unchecked runtime.lastError".
        });
      }
    });
  });
  // An older version hid this entry after a right-click that found no picture, and menu items persist: show it again.
  // It is never hidden now; a command that finds no picture only shows a short note.
  browser.contextMenus.update(MENU_TRANSLATE_IMAGE, { visible: true }, () => void browser.runtime.lastError);
  // The click is handled by the page's content script, which finds the <img> and runs the normal pipeline.
  browser.contextMenus.onClicked.addListener((info, tab) => {
    const message = messageForMenuClick(info);
    if (!message || tab?.id === undefined) return;
    browser.tabs.sendMessage(tab.id, message, info.frameId !== undefined ? { frameId: info.frameId } : undefined).catch((error) => {
      console.warn("RawReader: the page did not take the menu command:", (error as Error)?.message ?? error);
    });
  });

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const respond = createAsyncResponder(sendResponse);
    const respondErr = (err: unknown) => respond({ error: (err as Error).message ?? String(err) });

    if (msg.type === "BRIDGE_PING") {
      const run = async (): Promise<BridgePingReply> => {
        await originRuleReady;
        const cachedPort = await storage.getItem<number>(BRIDGE_PORT_CACHE_KEY).catch(() => null);
        const reply = await pingBridge({ cachedPort });
        if (reply.ok && reply.port !== cachedPort) await storage.setItem(BRIDGE_PORT_CACHE_KEY, reply.port).catch(() => {});
        // The app is there: hand over the visits that waited for it.
        if (reply.ok) void flushHistory(true);
        return reply;
      };
      keepAliveWhile(run().then(respond).catch(respondErr));
      return true;
    }

    if (msg.type === "BACKEND_STATUS") {
      const run = async (): Promise<BackendStatusReply> => {
        await originRuleReady;
        const settings = await loadBackendSettings();
        const cachedPort = await storage.getItem<number>(BRIDGE_PORT_CACHE_KEY).catch(() => null);
        const ping = settings.choice === "direct" ? null : await pingBridge({ cachedPort });
        if (ping?.ok && ping.port !== cachedPort) await storage.setItem(BRIDGE_PORT_CACHE_KEY, ping.port).catch(() => {});
        const configured = isDirectConfigured(settings.direct);
        const backend: BackendKind = selectBackend({
          choice: settings.choice,
          bridge: ping ? { reachable: ping.ok, ready: ping.ok && ping.ready } : null,
          directConfigured: configured,
        });
        return {
          backend,
          choice: settings.choice,
          ping,
          direct: { configured, provider: settings.direct.provider, model: settings.direct.model },
        };
      };
      keepAliveWhile(run().then(respond).catch(respondErr));
      return true;
    }

    if (msg.type === "BRIDGE_TRANSLATE") {
      keepAliveWhile(bridgeTranslate(msg as BridgeTranslateMessage, sender.tab?.id).then(respond).catch(respondErr));
      return true;
    }

    // Reading history. A visit comes from a page (top frame, normal window only) and is reported to the app.
    if (msg.type === MSG_HISTORY_TOUCH) {
      const touch = msg.data as HistoryTouch | undefined;
      const fromPage = sender.tab !== undefined;
      // Not in a private window, not from a frame inside a page, and only when the reporting is switched on.
      if (touch && typeof touch.url === "string" && fromPage && !sender.tab?.incognito && sender.frameId === 0) {
        void historyWrites
          .run(async () => {
            if (!(await historyEnabled())) return;
            const current = parsePending(await storage.getItem(HISTORY_PENDING_KEY));
            const next = addPending(current, touch, Date.now());
            if (next !== current) await storage.setItem(HISTORY_PENDING_KEY, next);
          })
          .then(() => flushHistory())
          .catch((error) => console.warn("RawReader: reading history write failed:", error));
      }
      return false;
    }
    // The popup asks the app to show its history page.
    if (msg.type === MSG_HISTORY_OPEN) {
      const run = async (): Promise<{ ok: true } | { error: { code: string; message: string } }> => {
        const found = await findBridge();
        if (!found.ok) return { error: found.error };
        const reply = await openHistoryInApp({ port: found.port });
        if (!("error" in reply)) void flushHistory(true);
        return reply;
      };
      keepAliveWhile(run().then(respond).catch(respondErr));
      return true;
    }
    // Timing record of one finished task (times and sizes only), written to the local ring log.
    if (msg.type === "PERF_RECORD") {
      const record = msg.data as PerfRecord | undefined;
      if (record && record.v === 1 && !sender.tab?.incognito) void savePerfRecord(record);
      return false;
    }

    // Proxy image fetch for cross-origin or hotlink-protected images (Referer checks); answers a data URL.
    if (msg.type === "PROXY_IMAGE") {
      const { url, referer } = msg.data ?? {};
      if (!url || !isAllowedImageUrl(url, referer)) {
        respondErr(new Error("安全拦截：图片地址不被允许或不安全"));
        return true;
      }
      keepAliveWhile(
        proxyFetch(url, referer, proxyDeps())
          .then((buf) => ({ dataUrl: arrayBufferToBase64DataUrl(buf) }))
          .then(respond)
          .catch(respondErr),
      );
      return true;
    }

    // Text cleaning runs in the offscreen document (canvas work). Only the algorithmic ladder is left.
    if (msg.type === "INPAINT_IMAGE") {
      const run = async () => {
        await ensureOffscreen();
        return browser.runtime.sendMessage({ ...msg, type: "OFFSCREEN_INPAINT_IMAGE" });
      };
      keepAliveWhile(withTimeout(run(), INPAINT_TIMEOUT_MS, "INPAINT_IMAGE").then(respond).catch(respondErr));
      return true;
    }

    // The old setup wizard is replaced by the options page.
    if (msg.type === "OPEN_SETUP_TAB") {
      browser.runtime
        .openOptionsPage()
        .then(() => respond({ success: true }))
        .catch(respondErr);
      return true;
    }

    // Test a site rule regex against the active tab.
    if (msg.type === "TEST_SITE_RULE") {
      const run = async () => {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          return browser.tabs.sendMessage(tabs[0].id, { type: "TEST_REGEX_RULE", data: { rule: msg.data?.rule } });
        }
        return { error: "没有活动的标签页。" };
      };
      keepAliveWhile(run().then(respond).catch(respondErr));
      return true;
    }

    return false;
  });
});
