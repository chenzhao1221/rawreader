/**
 * Fetches a page image from the extension's service worker. When the page URL is known, a session
 * declarativeNetRequest rule sets the Referer header, so image hosts that check the Referer accept the request.
 *
 * Each in-flight fetch gets its own rule id. A shared id let two parallel fetches overwrite or remove each other's
 * rule, and the request then went out without a Referer and failed with 403.
 */

/** First session rule id used for image fetches. Ids from this range are never used by other rules. */
export const PROXY_RULE_ID_BASE = 90000;
export const PROXY_RULE_ID_COUNT = 1000;

/** Rule ids held by fetches that have not finished yet. */
const inFlightRuleIds = new Set<number>();

/** The part of `chrome.declarativeNetRequest` this module uses. */
export interface SessionRuleApi {
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>;
}

export interface ProxyFetchDeps {
  dnr?: Partial<SessionRuleApi> | undefined;
  fetchImpl?: ((url: string) => Promise<Response>) | undefined;
}

/** A failed image download. The message holds no URL and no query string. */
export class ImageFetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ImageFetchError";
    this.status = status;
  }
}

/** Wraps any failure while the source image is being downloaded, so the caller can report it as such. */
export class ImageDownloadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ImageDownloadError";
  }
}

/** Takes a free rule id from the image range, or null when all of them are in use. */
export function acquireRuleId(): number | null {
  for (let i = 0; i < PROXY_RULE_ID_COUNT; i++) {
    const id = PROXY_RULE_ID_BASE + i;
    if (!inFlightRuleIds.has(id)) {
      inFlightRuleIds.add(id);
      return id;
    }
  }
  return null;
}

/** Session rule that sets the Referer for requests to this image URL (query and fragment left out). */
export function refererRule(id: number, url: string, referer: string) {
  return {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Referer", operation: "set", value: referer }],
    },
    condition: {
      urlFilter: url.replace(/[?#].*$/, ""),
      resourceTypes: ["xmlhttprequest", "other", "image"],
    },
  };
}

/**
 * Downloads one image. Throws ImageFetchError when the server answers with an error status, and rethrows network
 * errors from fetch.
 */
export async function proxyFetch(url: string, referer: string | undefined, deps: ProxyFetchDeps = {}): Promise<ArrayBuffer> {
  const dnr = deps.dnr;
  const doFetch = deps.fetchImpl ?? ((u: string) => fetch(u));
  const ruleId = referer && dnr?.updateSessionRules ? acquireRuleId() : null;
  try {
    if (ruleId !== null && referer && dnr?.updateSessionRules) {
      try {
        await dnr.updateSessionRules({ removeRuleIds: [ruleId], addRules: [refererRule(ruleId, url, referer)] });
      } catch (error) {
        console.warn("RawReader: could not set the Referer rule for an image fetch:", error);
      }
    }
    const res = await doFetch(url);
    if (!res.ok) {
      const status = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
      throw new ImageFetchError(`HTTP ${status}`, res.status);
    }
    return await res.arrayBuffer();
  } finally {
    if (ruleId !== null && dnr?.updateSessionRules) {
      await dnr.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
      inFlightRuleIds.delete(ruleId);
    }
  }
}
