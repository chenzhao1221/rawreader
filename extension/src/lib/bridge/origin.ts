import { BRIDGE_PORTS } from "./protocol";

/**
 * Why this exists: the app only accepts requests whose `Origin` is `chrome-extension://<id>`. Chrome leaves the
 * `Origin` header off a GET that the extension's service worker sends to a host it has host permission for
 * (the request is CORS-exempt, so the "cross-origin GET" rule of the Fetch spec does not apply). `GET /ping`
 * therefore arrived without an Origin and the app answered `forbidden-origin`. POST requests always carry the
 * Origin, which is why only the probe failed.
 *
 * The fix is a session rule that sets the header. It is as narrow as the app's own guard:
 *  - only the bridge URLs (`http://127.0.0.1:<bridge port>/ping|translate`),
 *  - only requests initiated by this extension (`initiatorDomains`), so a web page or a content script
 *    can never get the extension's Origin stamped on its own requests to the bridge.
 */

/** Id of the session rule. The image proxy uses 99999. */
export const BRIDGE_ORIGIN_RULE_ID = 99998;

export interface BridgeOriginRule {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: { header: "Origin"; operation: "set"; value: string }[];
  };
  condition: {
    regexFilter: string;
    initiatorDomains: string[];
    resourceTypes: ("xmlhttprequest" | "other")[];
  };
}

/** The Origin the app expects from this extension. */
export function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}

/** Builds the rule. Throws on an extension id that is not 32 letters a-p, so nothing odd reaches the regex or the header. */
export function buildBridgeOriginRule(extensionId: string, ports: readonly number[] = BRIDGE_PORTS): BridgeOriginRule {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Invalid extension id");
  if (ports.length === 0 || !ports.every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535)) throw new Error("Invalid bridge ports");
  return {
    id: BRIDGE_ORIGIN_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Origin", operation: "set", value: extensionOrigin(extensionId) }],
    },
    condition: {
      regexFilter: `^http://127\\.0\\.0\\.1:(${ports.join("|")})/(ping|translate)$`,
      initiatorDomains: [extensionId],
      resourceTypes: ["xmlhttprequest", "other"],
    },
  };
}

export interface SessionRulesApi {
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: BridgeOriginRule[] }): Promise<void>;
}

/**
 * Installs (or replaces) the rule. Session rules live until the browser closes, so the background runs this
 * every time it starts. Never throws: on failure the probe still runs and reports what the app answers.
 */
export async function installBridgeOriginRule(
  dnr: SessionRulesApi | undefined,
  extensionId: string,
  ports: readonly number[] = BRIDGE_PORTS,
): Promise<boolean> {
  if (!dnr?.updateSessionRules) return false;
  try {
    await dnr.updateSessionRules({ removeRuleIds: [BRIDGE_ORIGIN_RULE_ID], addRules: [buildBridgeOriginRule(extensionId, ports)] });
    return true;
  } catch (error) {
    console.warn("RawReader: Failed to set the Origin rule for the app bridge:", error);
    return false;
  }
}
