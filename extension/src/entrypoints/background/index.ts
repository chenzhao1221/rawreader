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
import { dataUrlToBytes, pingBridge, probeBridge, translateViaBridge } from "@/lib/bridge/client";
import { PriorityGate } from "@/lib/bridge/gate";
import { installBridgeOriginRule } from "@/lib/bridge/origin";
import type { BridgePingReply, BridgeTranslateMessage, BridgeTranslateReply } from "@/lib/bridge/protocol";
import { DefaultConfig } from "@/lib/configs";
import { CONTEXT_MENU_ITEMS, messageForMenuClick } from "@/lib/context-menu";
import { translateDirect } from "@/lib/direct/client";
import { NO_BACKEND_CODE } from "@/lib/direct/errors";
import { browserImageCodec } from "@/lib/direct/image-browser";
import { isDirectConfigured, originPatternFor } from "@/lib/direct/providers";
import { selectBackend, type BackendKind } from "@/lib/direct/select";
import type { BackendStatusReply } from "@/lib/direct/status";
import { loadBackendSettings } from "@/lib/direct/settings";
import { ImageDownloadError, proxyFetch, type ProxyFetchDeps, type SessionRuleApi } from "@/lib/image-proxy";
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

  async function bridgeTranslate(msg: BridgeTranslateMessage, tabId: number | undefined): Promise<BridgeTranslateReply> {
    const { src, referer, boxes, context, priority = 0 } = msg.data;
    const controller = new AbortController();
    const key = tabId ?? -1;
    if (!controllers.has(key)) controllers.set(key, new Set());
    controllers.get(key)!.add(controller);
    let release: (() => void) | null = null;
    try {
      release = await gateFor(key).acquire(priority, controller.signal);
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

      if (kind === "direct") {
        const pattern = originPatternFor(settings.direct.baseUrl);
        if (!pattern || !(await browser.permissions.contains({ origins: [pattern] }).catch(() => false))) {
          return { error: { code: "direct-permission", message: "No permission for the API host" } };
        }
        const bytes = await imageBytes(src, referer);
        const targetLang = (await storage.getItem<string>("sync:target-lang").catch(() => null)) ?? DefaultConfig.targetLang;
        return await translateDirect(settings.direct, {
          bytes,
          codec: browserImageCodec,
          targetLang,
          context,
          boxes,
          signal: controller.signal,
        });
      }

      if (!probe || !probe.ok) return { error: probe && !probe.ok ? probe.error : { code: "unreachable", message: "Cannot reach the app" } };
      const bytes = await imageBytes(src, referer);
      return await translateViaBridge({ port: probe.port }, { bytes, boxes, context, priority, signal: controller.signal, timeoutMs: BRIDGE_TRANSLATE_TIMEOUT_MS });
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

  // Nothing to set up: look for the app at browser start and after an install or update, so the port is cached.
  browser.runtime.onStartup.addListener(() => void findBridge());
  browser.runtime.onInstalled.addListener(() => void findBridge());

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
