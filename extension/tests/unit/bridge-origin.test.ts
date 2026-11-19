import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_ORIGIN_RULE_ID,
  buildBridgeOriginRule,
  extensionOrigin,
  installBridgeOriginRule,
  type SessionRulesApi,
} from "@/lib/bridge/origin";
import { BRIDGE_PORTS } from "@/lib/bridge/protocol";

const ID = "gpkjhmgphgimhomimgpjbdehibhenlce";

describe("buildBridgeOriginRule", () => {
  const rule = buildBridgeOriginRule(ID);
  const re = new RegExp(rule.condition.regexFilter);

  it("sets the Origin the app pins, from this extension's id", () => {
    expect(rule.action).toEqual({
      type: "modifyHeaders",
      requestHeaders: [{ header: "Origin", operation: "set", value: `chrome-extension://${ID}` }],
    });
    expect(extensionOrigin(ID)).toBe(`chrome-extension://${ID}`);
  });

  it("only applies to requests that this extension itself starts", () => {
    expect(rule.condition.initiatorDomains).toEqual([ID]);
  });

  it("does not collide with the image proxy rule (99999)", () => {
    expect(rule.id).toBe(BRIDGE_ORIGIN_RULE_ID);
    expect(rule.id).not.toBe(99999);
  });

  it("matches /ping and /translate on every bridge port", () => {
    for (const port of BRIDGE_PORTS) {
      expect(re.test(`http://127.0.0.1:${port}/ping`)).toBe(true);
      expect(re.test(`http://127.0.0.1:${port}/translate`)).toBe(true);
    }
  });

  it("does not match other hosts, ports, paths, schemes or lookalikes", () => {
    const others = [
      "http://127.0.0.1:18798/ping",
      "http://127.0.0.1:1879/ping",
      "http://127.0.0.1:18793/other",
      "http://127.0.0.1:18793/ping?x=1",
      "http://127.0.0.1/ping",
      "https://127.0.0.1:18793/ping",
      "http://localhost:18793/ping",
      "http://127.0.0.1.evil.example:18793/ping",
      "http://evil.example/http://127.0.0.1:18793/ping",
      "http://127x0x0x1:18793/ping",
    ];
    for (const url of others) expect(re.test(url), url).toBe(false);
  });

  it("rejects an extension id that is not 32 letters a-p", () => {
    for (const bad of ["", "abc", ID.toUpperCase(), `${ID}x`, `${ID.slice(1)}!`, "a".repeat(31) + "q"]) {
      expect(() => buildBridgeOriginRule(bad), bad).toThrow("Invalid extension id");
    }
  });

  it("rejects an empty or out-of-range port list", () => {
    expect(() => buildBridgeOriginRule(ID, [])).toThrow("Invalid bridge ports");
    expect(() => buildBridgeOriginRule(ID, [80])).toThrow("Invalid bridge ports");
    expect(() => buildBridgeOriginRule(ID, [18793.5])).toThrow("Invalid bridge ports");
  });
});

describe("installBridgeOriginRule", () => {
  it("replaces the rule in the session rules", async () => {
    const dnr: SessionRulesApi = { updateSessionRules: vi.fn(async () => {}) };
    await expect(installBridgeOriginRule(dnr, ID)).resolves.toBe(true);
    expect(dnr.updateSessionRules).toHaveBeenCalledTimes(1);
    expect(dnr.updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [BRIDGE_ORIGIN_RULE_ID],
      addRules: [buildBridgeOriginRule(ID)],
    });
  });

  it("does not throw when the API is missing or rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(installBridgeOriginRule(undefined, ID)).resolves.toBe(false);
    await expect(installBridgeOriginRule({} as SessionRulesApi, ID)).resolves.toBe(false);
    const failing: SessionRulesApi = { updateSessionRules: vi.fn(async () => Promise.reject(new Error("boom"))) };
    await expect(installBridgeOriginRule(failing, ID)).resolves.toBe(false);
    await expect(installBridgeOriginRule(failing, "bad-id")).resolves.toBe(false);
    warn.mockRestore();
  });
});
