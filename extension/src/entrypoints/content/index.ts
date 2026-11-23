// Portions ported from libre-manga-translator src/entrypoints/content/index.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
import Overlay from "@/lib/components/Overlay.svelte";
import Sidebar from "@/lib/components/Sidebar.svelte";
import TaskStatusBar from "@/lib/components/TaskStatusBar.svelte";
import { AutoTranslateOrchestrator } from "./auto-translate";
import * as Registry from "./translation-registry";
import { joinSharedCall } from "./translation-registry";
import { taskPriority } from "@/lib/bridge/gate";
import { mount, unmount } from "svelte";
import { ShadowRootContentScriptUi, storage } from "#imports";
import { getSiteRule } from "@/lib/adapters";
import { DefaultConfig, resolveLangGroup } from "@/lib/configs";
import {
  BridgeMemo,
  responseToBboxes,
  responseToTranslation,
  runBridgeTask,
  shouldWritePageCache,
  type BridgeCall,
  type CallHooks,
  type PartialSnapshot,
} from "@/lib/bridge/memo";
import { contextToBridge, describeBridgeError } from "@/lib/bridge/client";
import { browserImageCodec } from "@/lib/direct/image-browser";
import { acquireImageDataUrl, dataUrlByteLength } from "@/lib/image-source";
import { findImageForSrcUrl, matchRank } from "@/lib/image-match";
import { MSG_CONTEXT_TARGET, MSG_CONTEXT_TRANSLATE_PAGE, isContextTranslateMessage } from "@/lib/context-menu";
import {
  meetsBeneathSize,
  meetsPageSize,
  pickForCommand,
  resolveContextTarget,
  type ContextRecord,
  type TargetEnv,
} from "@/lib/context-target";
import type { TaskStatusEvent } from "@/lib/task-status";
import { MSG_HISTORY_TOUCH } from "@/lib/reading-history";

/** A status event without its task number (added when it is sent). */
type StatusEventBody = TaskStatusEvent extends infer E ? (E extends { taskId: string } ? Omit<E, "taskId"> : never) : never;
import type { BridgeFocus, BridgeTaskStart, BridgeTranslateReply, TaskEvent } from "@/lib/bridge/protocol";
import { TaskTimeline, type BgPerf, type TaskOrigin } from "@/lib/perf/timeline";
import { logDebugEntry, updateDebugEntry } from "./debug";
import {
  createImageObservers,
  imageToBase64,
  repaintWithTranslations,
  inpaintImage,
  drawTranslations,
  exportCanvasToJpeg,
  quickHash,
  resolveImagePageIndex,
  fetchAsImageBitmap,
  inpaintBbox,
  type MangaTargetElement,
} from "./utils";
import { getElementSrc, imageToDataUrl } from "@/lib/canvas";
import { seriesContextFromStored } from "@/lib/series-context";
import {
  localHistoryKey,
  syncContextKey,
  updateSeriesContext,
} from "@/lib/series-context-store";
import "@/assets/app.css";

const srcKey = (src: string) =>
  src.startsWith("data:") ? quickHash(src) : src;

/**
 * Copy the run-level diagnostic facts onto a `DebugEntry` (LMT-032).
 *
 * The validator already clips `rawResponse`; passing `undefined` for every
 * absent field keeps the stored entry honest instead of writing zeros that
 * look like measurements.
 */
function runDiagnosticFields(d?: TranslationDiagnostics) {
  return {
    rawResponse: d?.rawResponse,
    llmCalls: d?.llmCalls,
    finishReason: d?.finishReason,
    promptChars: d?.promptChars,
    padded: d?.padded,
    truncated: d?.truncated,
  };
}

// Wait until the image has a real layout (loaded + non-zero rendered box).
// Measuring a hidden/not-yet-loaded image freezes the wrapper at 0×0 and
// misplaces the whole overlay on revisit.
async function waitForLaidOutImage(
  img: MangaTargetElement,
  timeoutMs = 3000,
): Promise<boolean> {
  const ready = () => {
    const naturalW = "naturalWidth" in img ? img.naturalWidth : img.width;
    const naturalH = "naturalHeight" in img ? img.naturalHeight : img.height;
    const rect = img.getBoundingClientRect();
    const inViewport =
      rect.right > 4 &&
      rect.bottom > 4 &&
      rect.left < window.innerWidth - 4 &&
      rect.top < window.innerHeight - 4;
    return (
      document.body.contains(img) &&
      ("complete" in img ? img.complete : true) &&
      naturalW > 0 &&
      naturalH > 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      (img instanceof HTMLCanvasElement ? inViewport : true)
    );
  };
  if (ready()) return true;
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (!document.body.contains(img)) return false;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (ready()) return true;
  }
  return ready();
}

export default defineContentScript({
  matches: ["<all_urls>"],
  cssInjectionMode: "ui",

  async main(ctx) {
    const translatedSrcMap = new Map<string, string>();
    const inpaintedSrcCache = new Map<
      string,
      { url: string; boxesKey: string }
    >(); // inpainted base images, keyed to the exact set of painted boxes
    const debugEntryIdBySrc = new Map<string, string>(); // src → last debug entry id
    // One entry per page element that is queued or running. The status bar and the timing record share its number.
    interface TaskCtx {
      id: string;
      el: MangaTargetElement;
      origin: TaskOrigin;
      /** `performance.now()` and `Date.now()` when the page heard of the task. */
      receivedAt: number;
      receivedWall: number;
      /** Menu click time (ms since epoch), for a manual task. */
      clickedAt?: number | undefined;
      /** The pipeline has begun: a later request for the same element starts a new task. */
      started: boolean;
    }
    const taskCtx = new WeakMap<Element, TaskCtx>();
    // The last right-click: where it landed and which picture it meant (see the right-click memory below).
    let lastContext: ContextRecord | null = null;
    // What can still be asked of a task that came back in part: ask again for the segments that failed.
    const liveRuns = new WeakMap<Element, { retry: () => Promise<void> }>();
    let taskSeq = 0;
    let originHint: TaskOrigin | null = null;
    const manifestVersion = () => (browser.runtime.getManifest() as any).version_name || browser.runtime.getManifest().version;
    // Overlays are kept per page element: the same picture address can appear twice on a page.
    const overlays = new WeakMap<
      Element,
      { ui: ShadowRootContentScriptUi<any>; wrapper: HTMLElement }
    >();
    let lastDetectMs: number | undefined = undefined;

    const emitStatus = (task: TaskCtx, event: StatusEventBody) => {
      document.dispatchEvent(
        new CustomEvent("lmt:task-status-event", { detail: { event: { ...event, taskId: task.id }, el: task.el } }),
      );
    };
    const beginTask = (el: MangaTargetElement, origin: TaskOrigin, clickedAt?: number): TaskCtx => {
      const existing = taskCtx.get(el);
      if (existing && !existing.started) {
        if (origin === "manual") {
          existing.origin = "manual";
          existing.clickedAt = clickedAt;
        }
        return existing;
      }
      const task: TaskCtx = {
        id: `t${++taskSeq}-${Date.now().toString(36)}`,
        el,
        origin,
        receivedAt: performance.now(),
        receivedWall: Date.now(),
        clickedAt,
        started: false,
      };
      taskCtx.set(el, task);
      return task;
    };

    // ── Reading history ──────────────────────────────────────────────────
    // A page is remembered (title, address, series and chapter when a site rule gives them) when a translation starts on
    // it, or when it matches a site rule the user wrote and stays open for 10 seconds. The background stores it, in this
    // extension's own storage, and never in a private window. Nothing else about the page leaves it.
    let historyUrl = "";
    const touchHistoryNow = async () => {
      try {
        if (window.top !== window || !/^https?:$/.test(window.location.protocol)) return;
        if (browser.extension.inIncognitoContext) return;
        const site = await getSiteRule();
        // The fallback rule guesses from the title; only a real rule gives a series and a chapter worth merging on.
        const known = site.ruleId !== "fallback";
        await browser.runtime.sendMessage({
          type: MSG_HISTORY_TOUCH,
          data: {
            url: window.location.href,
            title: document.title,
            ...(known ? { series: site.seriesName, chapter: site.chapterId } : {}),
          },
        });
      } catch {
        // The history is a convenience: a failure here must never get in the way of translating.
      }
    };
    /** A translation started: remember this address once (the background also ignores repeats within 5 seconds). */
    const noteTranslationStarted = () => {
      if (historyUrl === window.location.href) return;
      historyUrl = window.location.href;
      void touchHistoryNow();
    };
    let dwellTimer: ReturnType<typeof setTimeout> | undefined;
    /** On a site the user wrote a rule for: remember the page after it stayed open for 10 seconds. */
    const scheduleDwell = () => {
      clearTimeout(dwellTimer);
      const at = window.location.href;
      dwellTimer = setTimeout(async () => {
        if (window.location.href !== at || historyUrl === at) return;
        const custom = (await storage.getItem<SiteRule[]>("sync:custom-site-rules").catch(() => null)) ?? [];
        if (!Array.isArray(custom) || !custom.some((rule) => rule.domain && window.location.hostname.includes(rule.domain))) return;
        historyUrl = at;
        void touchHistoryNow();
      }, 10_000);
    };
    // A reader that changes chapter or page without loading a new document: watch the address.
    let seenHref = window.location.href;
    const onAddressChange = () => {
      if (window.location.href === seenHref) return;
      seenHref = window.location.href;
      historyUrl = "";
      scheduleDwell();
    };
    const nav = (window as unknown as { navigation?: EventTarget }).navigation;
    if (nav) nav.addEventListener("navigatesuccess", onAddressChange);
    else {
      const poll = setInterval(onAddressChange, 1000);
      ctx.onInvalidated(() => clearInterval(poll));
    }
    scheduleDwell();
    ctx.onInvalidated(() => clearTimeout(dwellTimer));

    // Mount independent sidebar shadow UI
    createShadowRootUi(ctx, {
      name: "lmt-sidebar",
      position: "inline",
      anchor: "body",
      append: "last",
      onMount: (uiContainer) =>
        mount(Sidebar, {
          target: uiContainer,
        }),
      onRemove: (app) => {
        if (app) unmount(app);
      },
    }).then((ui) => {
      ui.mount();
    });

    async function startTranslationPipeline(imgElement: MangaTargetElement) {
      const dequeuedAt = performance.now();
      if (!imgElement || !document.body.contains(imgElement)) return;
      const rawSrc = getElementSrc(imgElement);
      if (!rawSrc) return;
      const clicked = srcKey(rawSrc);
      const originalSrc = (clicked && translatedSrcMap.get(clicked)) ?? rawSrc;
      if (!originalSrc) return;

      // A picture that was queued has a status line saying "排队中"; every way out below that does not start it removes the line.
      const abandonQueuedLine = () => {
        const waiting = taskCtx.get(imgElement);
        if (waiting && !waiting.started) {
          document.dispatchEvent(new CustomEvent("lmt:task-status-event", { detail: { remove: true, taskId: waiting.id } }));
          taskCtx.delete(imgElement);
        }
      };

      // ── Strict early registry guard (LMT-only, no page-world exposure) ──
      if (Registry.isPending(originalSrc, imgElement)) {
        abandonQueuedLine();
        return;
      }
      if (Registry.getStatus(originalSrc, imgElement) === "done" && overlays.has(imgElement)) {
        const existingDone = overlays.get(imgElement)!;
        if (document.body.contains(existingDone.wrapper)) {
          existingDone.wrapper.dispatchEvent(
            new CustomEvent("lmt:back-to-refine"),
          );
          abandonQueuedLine();
          return;
        }
        // Overlay was done but wrapper detached — clear stale done so cache-restore can run
        Registry.markIdle(originalSrc, undefined, imgElement);
      }

      // If overlay already exists (idle/refining state), bring it back to refine mode
      if (overlays.has(imgElement)) {
        const existing = overlays.get(imgElement)!;

        if (!document.body.contains(existing.wrapper)) {
          existing.ui.remove();
          overlays.delete(imgElement);
        } else {
          // It is still alive on the page, just bring it back to refine mode
          existing.wrapper.dispatchEvent(
            new CustomEvent("lmt:back-to-refine"),
          );
          abandonQueuedLine();
          return;
        }
      }

      // Don't claim the pipeline while the image has no layout yet (hidden
      // page, not-yet-loaded). Geometry captured now would freeze the wrapper
      // at 0×0. Nothing is claimed yet, so a plain return is safe — the queue
      // releases the slot and rescan retries when the page is visible.
      if (!(await waitForLaidOutImage(imgElement))) {
        abandonQueuedLine();
        return;
      }

      // Claim the pipeline SYNCHRONOUSLY (before the first await below)
      // so queue slot accounting sees pending on the same tick the queue
      // dispatched this call. The full cacheKey attaches right after.
      Registry.markPending(originalSrc, undefined, imgElement);

      // Compute full cacheKey early for strict block on pending cacheKey
      let pendingCacheKey: string | undefined;
      try {
        pendingCacheKey = await Registry.resolveCacheKey(imgElement, originalSrc);
        if (Registry.getStatusByCacheKey(pendingCacheKey, imgElement) === "pending") {
          Registry.markIdle(originalSrc, undefined, imgElement);
          abandonQueuedLine();
          return;
        }
      } catch {
        console.warn("LMT: cache-key resolve failed; continuing without dedupe guard");
      }

      // Attach the cacheKey to the pending claim (idempotent re-mark).
      // Mark pending BEFORE any heavy work / overlay creation so second call strict-blocks
      Registry.markPending(originalSrc, pendingCacheKey, imgElement);

      // The first translation on this page address goes into the reading history.
      noteTranslationStarted();

      // The task of this element: made when it was queued, or now for a picture that starts at once.
      const task = beginTask(imgElement, "auto");
      const fresh = !task.started;
      task.started = true;
      if (fresh) emitStatus(task, { type: "start", phase: "fetching" });
      else emitStatus(task, { type: "fetching" });

      // Timing marks for the measurement log. A manual task starts at the menu click.
      const timeline = new TaskTimeline(
        task.id,
        task.origin,
        undefined,
        performance.now() - task.receivedAt + (task.clickedAt !== undefined ? Math.max(0, task.receivedWall - task.clickedAt) : 0),
      );
      if (task.clickedAt !== undefined) timeline.markAt("click", task.receivedAt - Math.max(0, task.receivedWall - task.clickedAt));
      timeline.markAt("enqueue", task.receivedAt);
      timeline.markAt("dequeue", dequeuedAt);
      timeline.set("width", "naturalWidth" in imgElement ? imgElement.naturalWidth : imgElement.width);
      timeline.set("height", "naturalHeight" in imgElement ? imgElement.naturalHeight : imgElement.height);
      let bgPerf: BgPerf | undefined;
      // The answer lacked some segments of a long strip (the picture is shown with the rest).
      let hasFailures = false;
      // Cancels the request when the overlay goes away.
      const taskAbort = new AbortController();
      let timelineDone = false;
      const finishTask = (outcome: "done" | "partial" | "error" | "closed", error?: string) => {
        if (timelineDone) return;
        timelineDone = true;
        const record = timeline.toRecord({ version: manifestVersion(), outcome, ...(error ? { error } : {}), ...(bgPerf ? { bg: bgPerf } : {}) });
        browser.runtime.sendMessage({ type: "PERF_RECORD", data: record }).catch(() => {});
      };
      const failTask = (message: string) => {
        emitStatus(task, { type: "failed", error: message });
        finishTask("error", message);
      };

      // Yield the main thread immediately so the user's click handler returns
      // and the browser can process the next UI event (e.g. opening the popup
      // via the action icon) before we start blocking the page on heavy work.
      // Without this, a popup mount triggered right after click is queued
      // behind our synchronous canvas.encode + DOM mutations and never paints
      // until the pipeline advances to its first await point.
      await new Promise<void>((r) => setTimeout(r, 0));

      // Use base64 when offscreen fetch would fail:
      //   - blob: URLs are page-scoped - offscreen cannot fetch them
      //   - cross-origin images may lack CORS headers - offscreen fetch is blocked
      // imageToBase64 runs in the content script (page context) so both cases succeed.
      // Same-origin https images use the raw URL to avoid JPEG re-encode and the
      // MaxPool ceil() shape error it causes in PaddleOCR.
      // Falls back to background proxy fetch with Referer header rewriting when canvas is tainted.
      let src = originalSrc;
      // Set when every way of getting the image failed; the bridge call below then answers image-unavailable.
      let imageFailure: string | null = null;
      timeline.mark("fetch-start");
      if (!originalSrc.startsWith("data:")) {
        if (imgElement instanceof HTMLCanvasElement) {
          // No tab screenshots (ER7.8): a canvas that cannot be exported is skipped.
          const canvasUrl = imageToBase64(imgElement);
          if (!canvasUrl) {
            Registry.markIdle(originalSrc, pendingCacheKey, imgElement);
            failTask("这块画布不允许读取，无法翻译");
            return;
          }
          src = canvasUrl;
        } else {
          // Three steps, see lib/image-source.ts: draw the loaded <img>, fetch from the page with its cookies,
          // then ask the background worker (Referer rule). Each failed step is logged to the console.
          try {
            const got = await acquireImageDataUrl(originalSrc, {
              readElement: (quality) => imageToDataUrl(imgElement, quality),
              fetchImpl: (url, init) => fetch(url, init),
              reencodeJpeg: async (bytes, quality) => {
                const { width, height } = await browserImageCodec.measure(bytes);
                return browserImageCodec.encodeJpeg(bytes, width, height, quality);
              },
              background: async (url) => {
                const res = await browser.runtime.sendMessage({
                  type: "PROXY_IMAGE",
                  data: { url, referer: window.location.href },
                });
                if (res?.dataUrl) return res.dataUrl as string;
                throw new Error(typeof res?.error === "string" && res.error ? res.error : "no answer from the background worker");
              },
              log: (step, reason) => console.warn(`RawReader: image step "${step}" failed: ${reason}`),
            });
            src = got.dataUrl;
            timeline.set("image-step", got.step);
            timeline.set("image-bytes", dataUrlByteLength(got.dataUrl));
          } catch (err) {
            imageFailure = err instanceof Error ? err.message : String(err);
          }
        }
      }
      timeline.mark("fetch-end");

        // Bridge mode: one request to the RawReader app (through the background worker) answers both stages.
        const loadBridgeContext = async () => {
          const { seriesName } = await getSiteRule();
          const items = await storage.getItems([syncContextKey(seriesName), localHistoryKey(seriesName)]);
          const values = Object.fromEntries(items.map((i) => [i.key, i.value]));
          return contextToBridge(
            seriesContextFromStored(values[syncContextKey(seriesName)], values[localHistoryKey(seriesName)], seriesName),
          );
        };
        // How urgent this task is when it goes to the background worker (larger is more urgent): a menu click first,
        // then a picture on screen (the more of the screen it covers, the earlier), then the ones off screen by distance.
        // Worked out when the request is sent. A retry is a click too.
        const currentPriority = (retry: boolean) => {
          const r = imgElement.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const overlapX = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
          const overlapY = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          return taskPriority({
            manual: retry || task.origin === "manual",
            viewportCoverage: vw > 0 && vh > 0 ? (overlapX * overlapY) / (vw * vh) : 0,
            distancePx: r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : 0,
          });
        };
        // Where the reader is looking, as fractions of the picture: the click (for a menu task) and the part on screen.
        const computeFocus = (): BridgeFocus | undefined => {
          const r = imgElement.getBoundingClientRect();
          if (!(r.height > 0)) return undefined;
          const frac = (y: number) => Math.max(0, Math.min(1, (y - r.top) / r.height));
          const top = frac(0);
          const bottom = frac(window.innerHeight);
          const clicked = task.origin === "manual" && lastContext !== null && lastContext.resolved === imgElement;
          return {
            ...(clicked && lastContext ? { point: frac(lastContext.y) } : {}),
            ...(bottom > top ? { view: { top, bottom } } : {}),
          };
        };
        // What the task reports on its port goes to the status line, the timing marks and the memo.
        const onTaskEvent = (event: TaskEvent, hooks?: CallHooks) => {
          if (event.type === "stage") {
            if (event.stage === "queued") emitStatus(task, { type: "queued" });
            else
              emitStatus(task, {
                type: "translating",
                ...(event.done !== undefined ? { done: event.done } : {}),
                ...(event.total !== undefined ? { total: event.total } : {}),
              });
          } else if (event.type === "segment") {
            timeline.mark("first-segment");
            emitStatus(task, { type: "progress", done: event.done, total: event.total });
          }
          hooks?.onEvent?.(event);
        };
        const cancelled: BridgeTranslateReply = { error: { code: "timeout", message: "Cancelled" } };
        const callBridge: BridgeCall = async (boxes, hooks) => {
          // Every way of getting the image failed: no point asking the backend; report the last step's reason.
          if (imageFailure !== null) return { error: { code: "image-unavailable", message: imageFailure } };
          timeline.mark("request-sent");
          const start: BridgeTaskStart = {
            src,
            referer: window.location.href,
            boxes,
            context: await loadBridgeContext(),
            priority: currentPriority(hooks?.onlySegments !== undefined),
            focus: computeFocus(),
            onlySegments: hooks?.onlySegments,
          };
          const run = (emit: (event: TaskEvent) => void, signal: AbortSignal) =>
            runBridgeTask((info) => browser.runtime.connect(info), start, { onEvent: emit, signal });
          // The same picture address shown twice is read once: the second picture joins the request that is running.
          const shareable = boxes === undefined && hooks?.onlySegments === undefined;
          const reply = shareable
            ? await joinSharedCall(Registry.srcKeyOf(originalSrc), run, {
                onEvent: (event) => onTaskEvent(event, hooks),
                signal: taskAbort.signal,
                cancelled,
              })
            : await run((event) => onTaskEvent(event, hooks), taskAbort.signal);
          timeline.mark("result-received");
          if (reply.perf && !bgPerf) bgPerf = reply.perf;
          return reply;
        };
        const bridgeMemo = new BridgeMemo(callBridge);
        // Overlay-facing view of what has been read so far.
        const toPartial = (snapshot: PartialSnapshot) => {
          const reply = responseToTranslation(snapshot.response);
          return {
            bboxes: responseToBboxes(snapshot.response),
            translations: reply.translations,
            sourceTexts: reply.sourceTexts,
            complete: snapshot.complete,
            failedCount: snapshot.failed.length,
          };
        };

        // A strip that was missing segments and has them all now: the page is complete, so it is cached like any other.
        const commitCompletePage = async (finalBoxes: Bbox[], finalTranslations: Translations, finalSources: string[]) => {
          const { seriesName, chapterId, pageIndex } = await getSiteRule();
          const resolvedPage = resolveImagePageIndex(imgElement, originalSrc, pageIndex);
          const items = await storage.getItems([syncContextKey(seriesName), localHistoryKey(seriesName)]);
          const values = Object.fromEntries(items.map((i) => [i.key, i.value]));
          const seriesContext = seriesContextFromStored(values[syncContextKey(seriesName)], values[localHistoryKey(seriesName)], seriesName);
          const isContinuous =
            seriesContext.lastChapterId === chapterId &&
            seriesContext.lastPageIndex !== null &&
            resolvedPage === seriesContext.lastPageIndex + 1;
          const reply = responseToTranslation({
            v: 1, hash: "", width: 0, height: 0, cached: false, timings: { detectMs: 0, ocrMs: 0, translateMs: 0 },
            units: finalTranslations.map((translation, i) => ({
              kind: "bubble" as const, bubbleOnly: false, drawBox: finalBoxes[i]!, ocrBox: finalBoxes[i]!, ocrText: finalSources[i] ?? "",
              translation, status: translation ? ("ok" as const) : ("no-text" as const),
            })),
          });
          if (!shouldWritePageCache(reply)) return;
          storage
            .setItem<PageCache>(`local:${await translationKey()}`, { bboxes: finalBoxes, translations: finalTranslations, sourceTexts: finalSources })
            .catch((err) => console.warn("LMT: page-cache persist failed:", err));
          updateSeriesContext(seriesName, chapterId, resolvedPage, finalTranslations, undefined, { resetHistory: !isContinuous, diagnostics: reply.diagnostics }).catch((err) =>
            console.warn("LMT: series-context update failed:", err),
          );
        };

        // The status bar's retry button on a strip that came back in part: ask for the missing segments only.
        liveRuns.set(imgElement, {
          retry: async () => {
            if (bridgeMemo.failedSegments.length === 0) return;
            emitStatus(task, { type: "retry" });
            Registry.markPending(originalSrc, pendingCacheKey, imgElement);
            const out = await bridgeMemo.retryFailed();
            if (out.failed.length > 0) {
              hasFailures = true;
              Registry.markPartial(originalSrc, pendingCacheKey, imgElement);
              emitStatus(task, { type: "partial", failed: out.failed.map((f) => f.segment), error: out.error ?? describeBridgeError(out.failed[0]!) });
            }
            // When nothing is missing any more the overlay finishes the picture and calls onSettled.
          },
        });

        const translationKey = async () => {
          const { seriesName, chapterId, pageIndex } = await getSiteRule();
          const resolvedPage = resolveImagePageIndex(
            imgElement,
            originalSrc,
            pageIndex,
          );
          const targetLang =
            (await storage.getItem<string>("sync:target-lang")) ??
            DefaultConfig.targetLang;
          const imgHash = quickHash(originalSrc);
          return `page-cache-${targetLang}-${seriesName}-${chapterId}-p${resolvedPage}-${imgHash}`;
        };

        const rect = imgElement.getBoundingClientRect();
        const naturalW = "naturalWidth" in imgElement ? imgElement.naturalWidth : imgElement.width;
        const naturalH = "naturalHeight" in imgElement ? imgElement.naturalHeight : imgElement.height;
        const scaleX = rect.width / (naturalW || 1);
        const scaleY = rect.height / (naturalH || 1);

        const wrapper = document.createElement("div");
        wrapper.style.cssText = `position:relative;display:inline-block;width:${rect.width}px;height:${rect.height}px;`;
        imgElement.insertAdjacentElement("beforebegin", wrapper);
        wrapper.appendChild(imgElement);

        const { styleObserver, domObserver, sizeObserver } =
          createImageObservers(originalSrc, wrapper);

        // Yield once more before mounting the Overlay Svelte component. The
        // overlay runs several synchronous $effects on mount (cache lookup,
        // reading-direction read, etc.) and the page main thread is otherwise
        // starved from running the popup's mount handler.
        await new Promise<void>((r) => setTimeout(r, 0));

        createShadowRootUi(ctx, {
          name: "lmt-overlay",
          position: "inline",
          anchor: wrapper,
          append: "last",

          onMount: (uiContainer) =>
            mount(Overlay, {
              target: uiContainer,
              props: {
                wrapper,
                targetImageRect: rect,
                scaleX,
                scaleY,
                originalSrc,
                ownerEl: imgElement,
                rawImageUrl: src,
                getNotice: () => bridgeMemo.notice,

                getTranslationCache: async () => {
                  const cache = await storage.getItem<PageCache>(
                    `local:${await translationKey()}`,
                  );
                  if (!cache) return;
                  // Pages cached by an earlier build can hold a translation
                  // model's echoed prompt instead of a translation. Drop them
                  // so the page is translated again.
                  const PROMPT_ECHO = /【(约束要求|注意|硬性要求|背景信息|待翻译文本|源文)】|请将以下|只输出译文|不要进行任何解释/;
                  if (cache.translations?.some((t) => typeof t === "string" && PROMPT_ECHO.test(t))) {
                    await storage.removeItem(`local:${await translationKey()}`);
                    return;
                  }
                  const tRepaint = performance.now();
                  const translatedSrc = await repaintWithTranslations(
                    src,
                    cache.bboxes,
                    cache.translations,
                  );
                  timeline.set("cache-hit", true);
                  timeline.add("draw-ms", performance.now() - tRepaint);
                  timeline.mark("cache-restored");
                  translatedSrcMap.set(srcKey(translatedSrc), originalSrc);
                  return {
                    bboxes: cache.bboxes,
                    translatedSrc,
                    translations: cache.translations,
                    sourceTexts: cache.sourceTexts,
                    cleanedSrc: cache.cleanedSrc,
                  };
                },

                requestBubbleDetection: async () => {
                  const tStart = performance.now();
                  const res = await bridgeMemo.detect();
                  lastDetectMs = performance.now() - tStart;
                  if (!Array.isArray(res)) failTask(res.error);
                  return res;
                },

                requestTextTranslation: async (
                  bboxes: Bbox[],
                  isManuallySorted: boolean,
                  opts?: {
                    gateForce?: boolean;
                    transient?: boolean;
                    rawText?: string;
                  },
                ) => {
                  const t0 = performance.now();
                  const { seriesName, chapterId, pageIndex } =
                    await getSiteRule();
                  const resolvedPage = resolveImagePageIndex(
                    imgElement,
                    originalSrc,
                    pageIndex,
                  );

                  // One storage read for the series context and the languages; the app owns every other setting.
                  const cfgItems = await storage.getItems([
                    syncContextKey(seriesName),
                    localHistoryKey(seriesName),
                    "sync:source-lang",
                    "sync:target-lang",
                  ]);
                  const cfg = Object.fromEntries(
                    cfgItems.map((i) => [i.key, i.value]),
                  );

                  const seriesContext = seriesContextFromStored(
                    cfg[syncContextKey(seriesName)],
                    cfg[localHistoryKey(seriesName)],
                    seriesName,
                  );

                  // Continuity is computed here, outside the update path, so a
                  // dirty page (which must not append history) still advances
                  // the stored position instead of forcing a reset next time.
                  const isContinuous =
                    seriesContext.lastChapterId === chapterId &&
                    seriesContext.lastPageIndex !== null &&
                    resolvedPage === seriesContext.lastPageIndex + 1;

                  const curMode = DefaultConfig.currentMode;
                  const srcLang =
                    (cfg["sync:source-lang"] as string | undefined) ??
                    DefaultConfig.sourceLang;
                  const tgtLang =
                    (cfg["sync:target-lang"] as string | undefined) ??
                    DefaultConfig.targetLang;
                  const debugCtx = {
                    version: (browser.runtime.getManifest() as any).version_name || browser.runtime.getManifest().version,
                    device: undefined as string | undefined,
                    langGroup: resolveLangGroup(srcLang).group,
                    ocrMinConfidence: undefined as number | undefined,
                    detectionMinConfidence: undefined as number | undefined,
                    temperature: undefined as number | undefined,
                    serverSchema: undefined as string | undefined,
                    geminiModel: undefined as string | undefined,
                    ocrModel: "rawreader",
                    detectionModel: "rawreader",
                    llmModel: undefined as string | undefined,
                    serverModel: undefined as string | undefined,
                  };

                  // The app reads, translates and caches; the series context was sent with the request as prompt background.
                  const resp = await bridgeMemo.translate(bboxes, { rawText: opts?.rawText });
                  timeline.mark("translate-returned");
                  if (!("error" in resp) && !opts?.transient) {
                    // A long strip that came back in part: say which segments are missing; nothing is cached.
                    const missing = resp.failedSegments ?? [];
                    hasFailures = missing.length > 0;
                    if (hasFailures) {
                      emitStatus(task, { type: "partial", failed: missing.map((m) => m.segment), error: describeBridgeError(missing[0]!) });
                      Registry.markPartial(originalSrc, pendingCacheKey, imgElement);
                    }
                  }

                  const duration = performance.now() - t0;

                  if ("error" in resp) {
                    if (!opts?.transient) failTask(resp.error);
                    if (!opts?.transient) {

                      // Fire-and-forget debug log so a slow storage write never
                      // blocks the next pipeline stage or the popup from opening.
                      logDebugEntry({
                        id: crypto.randomUUID(),
                        timestamp: Date.now(),
                        success: false,
                        mode: curMode,
                        version: debugCtx.version,
                        device: debugCtx.device,
                        sourceLang: srcLang,
                        targetLang: tgtLang,
                        langGroup: debugCtx.langGroup,
                        langGroupFallback: resolveLangGroup(srcLang).fellBack,
                        bboxCount: bboxes.length,
                        timing: { total: duration },

                        ocrMinConfidence: debugCtx.ocrMinConfidence,
                        detectionMinConfidence: debugCtx.detectionMinConfidence,
                        temperature: debugCtx.temperature,
                        serverSchema: debugCtx.serverSchema,
                        geminiModel:

                          curMode === "gemini" ? debugCtx.geminiModel : undefined,
                        models: {

                          detection: debugCtx.detectionModel,
                          ocr: debugCtx.ocrModel,

                          llm: curMode === "webgpu" ? debugCtx.llmModel : undefined,
                          server: curMode === "api" ? debugCtx.serverModel : undefined,
                        },
                        // A failed page is where the raw answer matters most
                        // (truncated JSON, wrong shape) — the backend stamps
                        // these onto the error and the offscreen relay forwards
                        // them (LMT-032).
                                                error: resp.error,
                      })

                        .then((entryId) => debugEntryIdBySrc.set(src, entryId))
                        .catch((err) => console.warn("LMT: debug-log write failed:", err));
                    }
                    return resp;
                  }

                  const { translations, sourceTexts, diagnostics } = resp;
                  const context = undefined;
                  // Echoed boxes keep the original pixels: masking them to ""
                  // means the renderer neither inpaints nor paints them.
                  // Units the app could not translate are already empty strings (see lib/bridge/memo.ts).
                  const visibleTranslations = translations;
                  const timing = {
                    total: duration,
                    detect: lastDetectMs,
                    ocr: resp?.timing?.ocr,
                    translate: resp?.timing?.translate,
                  };
                  const backend = resp?.backend;

                  if (!opts?.transient) {
                    // Fire-and-forget: success debug log, page cache, and series
                    // context updates. None of these need to block the popup.
                    const successEntryPromise = logDebugEntry({
                      id: crypto.randomUUID(),
                      timestamp: Date.now(),
                      success: true,
                      mode: curMode,
                      version: debugCtx.version,
                      device: debugCtx.device,
                      backend,
                                            sourceLang: srcLang,
                      targetLang: tgtLang,
                      // Prefer the gate's resolved pack: `debugCtx.langGroup` is
                      // the pre-OCR `resolveLangGroup` guess, so under
                      // Auto-Detect it says "latin" even when the gate picked
                      // chinese (LMT-030).
                      langGroup: debugCtx.langGroup,
                      // Was `langGroup` a silent assumption rather than a
                      // resolved pack? The gate's own source is authoritative;
                      // otherwise fall back to what the config resolver says.
                      langGroupFallback: resolveLangGroup(srcLang).fellBack,
                      bboxCount: bboxes.length,
                      sourceTexts,
                      translations,
                      untranslated: diagnostics?.untranslated,
                      ...runDiagnosticFields(diagnostics),
                    timing,
                    ocrMinConfidence: debugCtx.ocrMinConfidence,
                    detectionMinConfidence: debugCtx.detectionMinConfidence,
                    temperature: debugCtx.temperature,
                    serverSchema: debugCtx.serverSchema,
                    geminiModel:
                      curMode === "gemini" ? debugCtx.geminiModel : undefined,
                    models: {
                      detection: debugCtx.detectionModel,
                      // The pack actually loaded: `debugCtx.ocrModel` is the
                      // pre-OCR guess, which under Auto-Detect always says latin
                      // (LMT-030).
                      ocr: debugCtx.ocrModel,
                      llm: curMode === "webgpu" ? debugCtx.llmModel : undefined,
                      server: curMode === "api" ? debugCtx.serverModel : undefined,
                    },
                  })
                    .then((entryId) => {
                      debugEntryIdBySrc.set(src, entryId);
                    })
                    .catch((err) => console.warn("LMT: debug-log write failed:", err));

                  // only a fully translated page may write cache or
                  // context. A padded/echoed page keeps its debug entry (that
                  // is the whole point of the log) but must not poison the
                  // next prompt or resurrect echoed lines from cache.
                  if (shouldWritePageCache(resp)) {
                    const cacheKey = await translationKey();
                    storage
                      .setItem<PageCache>(`local:${cacheKey}`, {
                        bboxes,
                        // Persist the paintable set so a cache hit cannot
                        // resurrect an echoed source line.
                        translations: visibleTranslations,
                        sourceTexts,
                      })
                      .catch((err) => console.warn("LMT: page-cache persist failed:", err));

                    updateSeriesContext(
                      seriesName,
                      chapterId,
                      resolvedPage,
                      // Never feed an echoed source line into the next prompt.
                      visibleTranslations,
                      context,
                      { resetHistory: !isContinuous, diagnostics },
                    ).catch((err) => console.warn("LMT: series-context update failed:", err));
                  } else {
                    console.warn(
                      `LMT: ${diagnostics?.untranslated?.length ?? 0} untranslated box(es) and ${resp.failedSegments?.length ?? 0} missing segment(s) on ${
                        seriesName ? `"${seriesName}" ` : ""
                      }page ${resolvedPage}; cache/context not saved.`,
                    );
                  }
                  }

                  return { translations: visibleTranslations, sourceTexts, context, gateSkip: undefined, gate: undefined, diagnostics, ...(resp.failedSegments ? { failedSegments: resp.failedSegments } : {}) };
                },

                // Re-render translations on top of the (cached) inpainted base.
                // Used by the edit panel: Apply → repaint with edited text + persist cache.
                renderTranslations: async (
                  translations: Translations,
                  bboxes: Bbox[],
                ) => {
                  // Only regions we actually paint get inpainted: a gate-skipped
                  // or empty region keeps its original text untouched (erasing
                  // without painting was a latent defect for failed OCR too).
                  timeline.mark("render-start");
                  const paintable = bboxes.filter((_, i) => translations[i]);
                  const boxesKey = JSON.stringify(
                    paintable.map((b) => [
                      Math.round(b.x1),
                      Math.round(b.y1),
                      Math.round(b.x2),
                      Math.round(b.y2),
                    ]),
                  );
                  let cached = inpaintedSrcCache.get(src);
                  let inpaintMethod:
                    | "fast"
                    | "quality"
                    | "fallback"
                    | undefined;
                  let inpaintMs: number | undefined;
                  if (!cached || cached.boxesKey !== boxesKey) {
                    const tInpaint = performance.now();
                    const res = await inpaintImage(src, paintable);
                    inpaintMs = performance.now() - tInpaint;
                    timeline.add("inpaint-ms", inpaintMs);
                    cached = { url: res.url, boxesKey };
                    inpaintedSrcCache.set(src, cached);
                    inpaintMethod = res.method;

                    if (res.regions) {
                      // Bind by the record's own index, not by array position:
                      // `index` is the contract the ladder guarantees against
                      // the bbox array it was handed (`paintable`).
                      res.regions.forEach((r) => {
                        const target = paintable[r.index];
                        if (r.method === "declined" && target) {
                          target.inpaintDeclined = true;
                        }
                      });
                    }

                    const inpaintStats = res.regions
                      ? {
                          fill: res.regions.filter(
                            (r) => r.method === "fill",
                          ).length,
                          denoise: res.regions.filter(
                            (r) => r.method === "denoise",
                          ).length,
                          lama: res.regions.filter(
                            (r) => r.method === "lama",
                          ).length,
                          telea: res.regions.filter(
                            (r) => r.method === "telea",
                          ).length,
                          rectTelea: res.regions.filter(
                            (r) => r.method === "rect-telea",
                          ).length,
                          declined: res.regions.filter(
                            (r) => r.method === "declined",
                          ).length,
                          skipped: res.regions.filter(
                            (r) => r.method === "skipped",
                          ).length,
                        }
                      : undefined;

                    // Attach inpainting details to the translate debug entry (same src).
                    const debugId = debugEntryIdBySrc.get(src);
                    if (debugId) {
                      // A size skip carries an explanatory note in lamaError; it is
                      // not a model failure, so it must not mask (or fake) one.
                      const inpaintLamaError = res.regions
                        ?.filter((r) => r.lamaStage !== "skipped-size")
                        .map((r) => r.lamaError)
                        .find((e): e is string => !!e);
                      // Only the Quality path stamps lamaStage, so a Fast run logs none.
                      const lamaStages = res.regions?.some((r) => r.lamaStage)
                        ? {
                            painted: res.regions.filter(
                              (r) => r.lamaStage === "painted",
                            ).length,
                            skippedSize: res.regions.filter(
                              (r) => r.lamaStage === "skipped-size",
                            ).length,
                            failed: res.regions.filter(
                              (r) => r.lamaStage === "failed",
                            ).length,
                            notAttempted: res.regions.filter(
                              (r) => r.lamaStage === "not-attempted",
                            ).length,
                          }
                        : undefined;
                      await updateDebugEntry(debugId, {
                        inpaintMethod,
                        inpaintStats,
                        inpaintError: res.error,
                        inpaintLamaError,
                        lamaStages,
                        timing: { inpaint: inpaintMs },
                      });
                    }
                  }

                  const tDraw = performance.now();
                  const translatedSrc = await drawTranslations(
                    cached.url,
                    bboxes,
                    translations,
                  );
                  timeline.add("draw-ms", performance.now() - tDraw);
                  timeline.add("renders", 1);
                  translatedSrcMap.set(srcKey(translatedSrc), originalSrc);

                  // Persist edited translations and bboxes so cache re-open shows them
                  const tPersist = performance.now();
                  const cache = await storage.getItem<PageCache>(
                    `local:${await translationKey()}`,
                  );
                  if (cache) {
                    await storage.setItem<PageCache>(
                      `local:${await translationKey()}`,
                      {
                        ...cache,
                        translations,
                        bboxes,
                        cleanedSrc: cached?.url,
                      },
                    );
                  }
                  timeline.add("persist-ms", performance.now() - tPersist);
                  timeline.mark("render-end");

                  return translatedSrc;
                },

                getCleanedSrc: async (currentBboxes?: Bbox[]) => {
                  let cached = inpaintedSrcCache.get(src);
                  if (cached?.url) return cached.url;
                  const boxes = currentBboxes ?? [];
                  const res = await inpaintImage(src, boxes);
                  cached = { url: res.url, boxesKey: "" };
                  inpaintedSrcCache.set(src, cached);
                  return res.url;
                },

                applyInpaintPatches: async (
                  baseCleanedSrc: string,
                  addedPatches: Bbox[],
                  removedPatches: Bbox[],
                ) => {
                  const bitmap = await fetchAsImageBitmap(baseCleanedSrc);
                  const canvas = document.createElement("canvas");
                  canvas.width = bitmap.width;
                  canvas.height = bitmap.height;
                  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
                  ctx.drawImage(bitmap, 0, 0);
                  bitmap.close();

                  // 1. Restore raw pixels for removed areas
                  if (removedPatches.length > 0) {
                    const rawBitmap = await fetchAsImageBitmap(src);
                    for (const p of removedPatches) {
                      const x = Math.max(0, Math.round(p.x1));
                      const y = Math.max(0, Math.round(p.y1));
                      const w = Math.min(canvas.width - x, Math.round(p.x2 - p.x1));
                      const h = Math.min(canvas.height - y, Math.round(p.y2 - p.y1));
                      if (w > 0 && h > 0) {
                        ctx.drawImage(rawBitmap, x, y, w, h, x, y, w, h);
                      }
                    }
                    rawBitmap.close();
                  }

                  let currentDataUrl = canvas.toDataURL("image/png");

                  // 2. Inpaint added areas
                  if (addedPatches.length > 0) {
                    try {
                      const res = await inpaintImage(currentDataUrl, addedPatches);
                      currentDataUrl = res.url;
                    } catch (err) {
                      console.warn("LMT: Patch inpaint via offscreen failed, using local fallback", err);
                      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                      for (const p of addedPatches) inpaintBbox(imgData, p);
                      ctx.putImageData(imgData, 0, 0);
                      currentDataUrl = canvas.toDataURL("image/png");
                    }
                  }

                  // Update cache
                  inpaintedSrcCache.set(src, { url: currentDataUrl, boxesKey: "" });
                  return currentDataUrl;
                },

                exportCanvasToJpeg,

                onBackToRefine: () => {
                  inpaintedSrcCache.delete(src);
                },

                onPaint: (kind: "partial" | "final") => {
                  timeline.mark("first-paint");
                  if (kind === "partial") return;
                  timeline.mark("final-paint");
                  if (hasFailures) {
                    // Shown with what there is; the status line already names the missing segments.
                    finishTask("partial", bridgeMemo.failedSegments[0]?.message);
                  } else {
                    emitStatus(task, { type: "done" });
                    finishTask("done");
                  }
                },

                subscribePartial: (listener: (snapshot: ReturnType<typeof toPartial>) => void) =>
                  bridgeMemo.subscribe((snapshot) => listener(toPartial(snapshot))),

                // The missing segments came back after a retry: the overlay drew the whole picture; now it is complete.
                onSettled: async (settledBoxes: Bbox[], settledTranslations: Translations, settledSources: string[]) => {
                  hasFailures = false;
                  await commitCompletePage(settledBoxes, settledTranslations, settledSources);
                  Registry.markDone(originalSrc, pendingCacheKey, imgElement);
                  emitStatus(task, { type: "done" });
                },

                onClose: () => overlays.get(imgElement)?.ui?.remove(),
              },
            }),

          onRemove: (app) => {
            taskAbort.abort();
            liveRuns.delete(imgElement);
            finishTask("closed");
            document.dispatchEvent(new CustomEvent("lmt:task-status-event", { detail: { remove: true, taskId: task.id } }));
            if (app) unmount(app);

            overlays.delete(imgElement);
            inpaintedSrcCache.delete(src); // Clear inpainted cache when overlay closes
            for (const [key, value] of translatedSrcMap) {
              if (value === originalSrc) translatedSrcMap.delete(key);
            }
            // LMT-only registry: idle so the menu command/queue can retrigger after close/error
            // Use pendingCacheKey if known, else just the element
            try {
              Registry.markIdle(originalSrc, pendingCacheKey, imgElement);
            } catch {
              Registry.markIdle(originalSrc, undefined, imgElement);
            }

            document.dispatchEvent(new CustomEvent("lmt:mode-change"));

            styleObserver.disconnect();
            domObserver.disconnect();
            sizeObserver.disconnect();

            const currentImg = wrapper.querySelector("img");
            if (currentImg) wrapper.replaceWith(currentImg);
            else wrapper.remove();
          },
        }).then((ui) => {
          overlays.set(imgElement, { ui, wrapper });
          ui.mount();

          styleObserver.observe(imgElement, {
            attributes: true,
            attributeFilter: ["style"],
          });
          // The observer that re-attaches a re-created picture finds it by address. With the same address on the page
          // twice it could move the other copy into this wrapper, so it stays off for such a picture.
          const sameAddress = Array.from(document.querySelectorAll<HTMLImageElement>("img")).filter((el) => el.src === originalSrc || el.getAttribute("src") === originalSrc);
          if (sameAddress.length <= 1) {
            domObserver.observe(wrapper.parentElement ?? document.body, {
              childList: true,
              subtree: true,
            });
          }
        });
    }

    // ── Status bar: one line per task, at the visible edge of its picture ───────
    createShadowRootUi(ctx, {
      name: "lmt-task-status",
      position: "inline",
      anchor: "body",
      append: "last",
      onMount: (uiContainer) => mount(TaskStatusBar, { target: uiContainer }),
      onRemove: (app) => {
        if (app) unmount(app);
      },
    }).then((ui) => {
      ui.mount();
    });

    // ── Auto-Translate Engine (owns the unified queue) ────────────────────
    // Manual menu commands enqueue through the same limiter: slider cap when auto is ON, absolute 3 when OFF.
    const autoTranslator = new AutoTranslateOrchestrator();
    autoTranslator.init(startTranslationPipeline, {
      onQueued: (img, manual) => {
        // The line starts when the picture joins the queue, so a picture that waits for a free slot says so.
        const task = beginTask(img, manual ? "manual" : (originHint ?? "auto"));
        emitStatus(task, { type: "start", phase: "queued" });
      },
    });
    ctx.onInvalidated(() => autoTranslator.destroy());

    // ── Right-click memory ──────────────────────────────────────────────
    // Where the user pressed the right button decides which picture the menu command means: the browser reports an
    // address only for a plain <img>, not for a transparent flip layer, a canvas, a linked picture or a repeated one.
    const OWN_UI = "lmt-overlay, lmt-sidebar, lmt-task-status";
    const targetEnv: TargetEnv = {
      elementsAt: (x, y) => document.elementsFromPoint(x, y),
      qualifies: meetsPageSize,
      qualifiesBeneath: meetsBeneathSize,
      isOwnUi: (el) => el.closest(OWN_UI) !== null,
      originalOfOverlay: (el) => {
        const host = el.closest("lmt-overlay");
        const wrapper = host?.parentElement;
        return wrapper?.querySelector(":scope > img, :scope > canvas") ?? null;
      },
    };
    const noteRightClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const resolved = resolveContextTarget(target, { x: event.clientX, y: event.clientY }, targetEnv);
      lastContext = { at: performance.now(), x: event.clientX, y: event.clientY, pageUrl: window.location.href, target, resolved };
      // The background shows or hides the menu entry to match. Chrome may build the menu before this arrives.
      browser.runtime.sendMessage({ type: MSG_CONTEXT_TARGET, hasTarget: resolved !== null }).catch(() => {});
    };
    // The window, in the capture phase: readers that stop events on the document or on the picture still get seen.
    // The button press comes before the menu opens, which gives the background a head start.
    window.addEventListener("contextmenu", noteRightClick, true);
    window.addEventListener("mousedown", (event) => event.button === 2 && noteRightClick(event), true);

    const showNotice = (text: string) => {
      const x = lastContext?.x ?? window.innerWidth / 2;
      const y = lastContext?.y ?? window.innerHeight / 2;
      document.dispatchEvent(new CustomEvent("lmt:task-notice", { detail: { x, y, text } }));
    };

    /** Starts a menu-chosen picture. A picture that is already running or done only gets a short note. */
    function translateByHand(el: MangaTargetElement, clickedAt: number | undefined) {
      const src = getElementSrc(el);
      const status = src ? Registry.getStatus(src, el) : "idle";
      if (status === "done") {
        showNotice("这张图已经翻译过了");
        return;
      }
      if (status === "pending") {
        showNotice("这张图正在翻译");
        return;
      }
      if (status === "partial" && src) {
        // A menu click on a strip that is missing segments asks for those again.
        const live = liveRuns.get(el);
        if (live) {
          void live.retry();
          return;
        }
      }
      const task = beginTask(el, "manual", clickedAt);
      task.origin = "manual";
      autoTranslator.enqueueManual(el);
    }

    // The status bar's retry button. A failed run may have left its overlay (with the error note) on the picture; it goes first.
    document.addEventListener("lmt:task-retry", (event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      const found = [...document.querySelectorAll<MangaTargetElement>("img, canvas")].find((el) => taskCtx.get(el)?.id === taskId);
      if (!found) return;
      // Came back in part: ask for the segments that failed, keep everything that is shown.
      const live = liveRuns.get(found);
      const foundSrc = getElementSrc(found);
      if (live && foundSrc && Registry.getStatus(foundSrc, found) === "partial") {
        void live.retry();
        return;
      }
      overlays.get(found)?.ui?.remove();
      translateByHand(found, undefined);
    });

    browser.runtime.onMessage.addListener(async (msg, _, sendResponse) => {
      // Right-click menu commands.
      if (isContextTranslateMessage(msg)) {
        if (msg.type === MSG_CONTEXT_TRANSLATE_PAGE) {
          originHint = "page";
          try {
            const count = await autoTranslator.enqueueAllQualifying();
            if (count === 0) {
              console.warn("RawReader: no loaded images found on this page to translate");
              showNotice("这一页没有找到可翻译的图片");
            }
          } finally {
            originHint = null;
          }
          return;
        }
        const srcUrl = msg.data.srcUrl;
        const picked = pickForCommand(
          lastContext,
          window.location.href,
          (el) => document.body.contains(el),
          srcUrl,
          (el) => srcUrl !== undefined && el.tagName === "IMG" && matchRank(el as HTMLImageElement, srcUrl, window.location.href) !== null,
          (preferred) =>
            srcUrl === undefined
              ? null
              : findImageForSrcUrl(
                  document.querySelectorAll<HTMLImageElement>("img"),
                  srcUrl,
                  window.location.href,
                  preferred?.tagName === "IMG" ? (preferred as HTMLImageElement) : (preferred?.closest("img") ?? null),
                ),
        );
        if (!picked.ok) {
          console.warn(`RawReader: no comic picture found for the right-click (${picked.reason})`);
          showNotice("这里没找到漫画图片");
          return;
        }
        translateByHand(picked.element as MangaTargetElement, msg.data.clickedAt);
        return;
      }
      // Test Regex from popup settings to show live result
      if (msg.type === "TEST_REGEX_RULE") {
        getSiteRule([msg.data.rule]).then((result) =>
          sendResponse({
            context: result,
            raw: { title: document.title, path: window.location.pathname },
          }),
        );

        return true;
      }
    });
  },
});
