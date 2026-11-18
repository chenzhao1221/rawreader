// Portions ported from libre-manga-translator src/entrypoints/background/index.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: the model, download, GPU, WebLLM and api-mode handlers are gone. This worker keeps the
// image proxy (PROXY_IMAGE), the site-rule test, the offscreen relay for inpainting, and adds the only code
// that talks to the RawReader app: BRIDGE_PING and BRIDGE_TRANSLATE (design 5.1). No tab screenshots.
import { isAllowedImageUrl } from "@/lib/security";
import { arrayBufferToBase64DataUrl } from "@/lib/utils";
import { dataUrlToBytes, pingBridge, probeBridge, translateViaBridge } from "@/lib/bridge/client";
import { PriorityGate } from "@/lib/bridge/gate";
import type { BridgePingReply, BridgeTranslateMessage, BridgeTranslateReply } from "@/lib/bridge/protocol";
import { BRIDGE_TRANSLATE_TIMEOUT_MS, INPAINT_TIMEOUT_MS, MAX_BRIDGE_REQUESTS_PER_TAB } from "@/lib/timeouts";
import { createAsyncResponder, keepAliveWhile, withTimeout } from "./messaging";
import { ensureOffscreen } from "./utils";

/** Port that answered last time. Only a hint for the next probe; the app may have moved to another port. */
const BRIDGE_PORT_CACHE_KEY = "local:bridge-port-cache";

export default defineBackground(() => {
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

  /** Probes 18793-18797 (cached port first) and remembers the port that answered. */
  async function findBridge() {
    const cachedPort = await storage.getItem<number>(BRIDGE_PORT_CACHE_KEY).catch(() => null);
    const found = await probeBridge({ cachedPort });
    if (found.ok && found.port !== cachedPort) await storage.setItem(BRIDGE_PORT_CACHE_KEY, found.port).catch(() => {});
    return found;
  }

  // Fetches an image the way LMT does: through declarativeNetRequest so CDNs that check the Referer accept the request.
  async function proxyFetch(url: string, referer: string | undefined): Promise<ArrayBuffer> {
    const ruleId = 99999;
    const dnr = (browser as any).declarativeNetRequest;
    if (dnr?.updateSessionRules && referer) {
      try {
        await dnr.updateSessionRules({
          removeRuleIds: [ruleId],
          addRules: [
            {
              id: ruleId,
              priority: 1,
              action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: referer }] },
              condition: { urlFilter: url.replace(/[?#].*$/, ""), resourceTypes: ["xmlhttprequest", "other", "image"] },
            },
          ],
        });
      } catch (e) {
        console.warn("RawReader: Failed to set DNR rule for proxy fetch:", e);
      }
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Proxy fetch failed with status ${res.status}: ${res.statusText}`);
      return await res.arrayBuffer();
    } finally {
      if (dnr?.updateSessionRules && referer) await dnr.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
    }
  }

  async function imageBytes(src: string, referer: string | undefined): Promise<Uint8Array> {
    const inline = dataUrlToBytes(src);
    if (inline) return inline;
    if (!isAllowedImageUrl(src, referer)) throw new Error("安全拦截：图片地址不被允许或不安全");
    return new Uint8Array(await proxyFetch(src, referer));
  }

  async function bridgeTranslate(msg: BridgeTranslateMessage, tabId: number | undefined): Promise<BridgeTranslateReply> {
    const { src, referer, boxes, context, priority = 0 } = msg.data;
    const controller = new AbortController();
    const key = tabId ?? -1;
    if (!controllers.has(key)) controllers.set(key, new Set());
    controllers.get(key)!.add(controller);
    let release: (() => void) | null = null;
    try {
      release = await gateFor(key).acquire(priority, controller.signal);
      // Probe before every translation: the app may have been closed, reopened or moved to another port.
      const found = await findBridge();
      if (!found.ok) return { error: found.error };
      const bytes = await imageBytes(src, referer);
      return await translateViaBridge({ port: found.port }, { bytes, boxes, context, priority, signal: controller.signal, timeoutMs: BRIDGE_TRANSLATE_TIMEOUT_MS });
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return { error: { code: "timeout", message: "Cancelled" } };
      return { error: { code: "image-unavailable", message: (error as Error).message ?? String(error) } };
    } finally {
      release?.();
      controllers.get(key)?.delete(controller);
    }
  }

  // Nothing to set up: look for the app at browser start and after an install or update, so the port is cached.
  browser.runtime.onStartup.addListener(() => void findBridge());
  browser.runtime.onInstalled.addListener(() => void findBridge());

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const respond = createAsyncResponder(sendResponse);
    const respondErr = (err: unknown) => respond({ error: (err as Error).message ?? String(err) });

    if (msg.type === "BRIDGE_PING") {
      const run = async (): Promise<BridgePingReply> => {
        const cachedPort = await storage.getItem<number>(BRIDGE_PORT_CACHE_KEY).catch(() => null);
        const reply = await pingBridge({ cachedPort });
        if (reply.ok && reply.port !== cachedPort) await storage.setItem(BRIDGE_PORT_CACHE_KEY, reply.port).catch(() => {});
        return reply;
      };
      keepAliveWhile(run().then(respond).catch(respondErr));
      return true;
    }

    if (msg.type === "BRIDGE_TRANSLATE") {
      keepAliveWhile(bridgeTranslate(msg as BridgeTranslateMessage, sender.tab?.id).then(respond).catch(respondErr));
      return true;
    }

    // Proxy image fetch for cross-origin or hotlink-protected images (Referer checks); answers a data URL.
    if (msg.type === "PROXY_IMAGE") {
      const { url, referer } = msg.data ?? {};
      if (!url || !isAllowedImageUrl(url, referer)) {
        respondErr(new Error("安全拦截：图片地址不被允许或不安全"));
        return true;
      }
      keepAliveWhile(
        proxyFetch(url, referer)
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
