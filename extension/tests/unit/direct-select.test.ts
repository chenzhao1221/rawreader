import { describe, expect, it } from "vitest";
import { describeBridgeError } from "@/lib/bridge/client";
import { NO_BACKEND_CODE, codeForStatus, describeDirectError, scrubMessage } from "@/lib/direct/errors";
import { selectBackend, type SelectInput } from "@/lib/direct/select";
import { describeBackendStatus } from "@/lib/direct/status";

const up = { reachable: true, ready: true };
const upNotReady = { reachable: true, ready: false };
const down = { reachable: false, ready: false };

describe("selectBackend", () => {
  const cases: Array<[string, SelectInput, string]> = [
    ["auto: RawReader ready wins over a configured API", { choice: "auto", bridge: up, directConfigured: true }, "rawreader"],
    ["auto: RawReader ready, no API", { choice: "auto", bridge: up, directConfigured: false }, "rawreader"],
    ["auto: app closed, API configured", { choice: "auto", bridge: down, directConfigured: true }, "direct"],
    ["auto: app running but not ready, API configured", { choice: "auto", bridge: upNotReady, directConfigured: true }, "direct"],
    ["auto: app running but not ready, no API (show the app's reason)", { choice: "auto", bridge: upNotReady, directConfigured: false }, "rawreader"],
    ["auto: nothing available", { choice: "auto", bridge: down, directConfigured: false }, "none"],
    ["rawreader only: never falls back, app closed", { choice: "rawreader", bridge: down, directConfigured: true }, "rawreader"],
    ["direct only: configured", { choice: "direct", bridge: null, directConfigured: true }, "direct"],
    ["direct only: not configured", { choice: "direct", bridge: null, directConfigured: false }, "none"],
    ["direct only: ignores a running app", { choice: "direct", bridge: up, directConfigured: true }, "direct"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(selectBackend(input)).toBe(expected);
  });
});

describe("direct errors", () => {
  it("maps HTTP statuses to stable codes", () => {
    expect(codeForStatus(401)).toBe("direct-auth");
    expect(codeForStatus(403)).toBe("direct-auth");
    expect(codeForStatus(404)).toBe("direct-not-found");
    expect(codeForStatus(413)).toBe("direct-image-too-large");
    expect(codeForStatus(429)).toBe("direct-rate-limit");
    expect(codeForStatus(503)).toBe("direct-server");
    expect(codeForStatus(400)).toBe("direct-bad-request");
  });

  it("describes direct codes in Chinese and leaves other codes alone", () => {
    expect(describeDirectError({ code: "direct-auth", message: "HTTP 401" })).toContain("API 密钥");
    expect(describeDirectError({ code: NO_BACKEND_CODE, message: "" })).toContain("插件设置");
    expect(describeDirectError({ code: "unreachable", message: "" })).toBeNull();
  });

  it("describeBridgeError delegates direct codes and keeps the RawReader texts", () => {
    expect(describeBridgeError({ code: NO_BACKEND_CODE, message: "" })).toContain("RawReader");
    expect(describeBridgeError({ code: "direct-rate-limit", message: "" })).toContain("稍后");
    expect(describeBridgeError({ code: "unreachable", message: "" })).toBe("请先打开 RawReader。");
  });

  it("removes the key, key parameters and bearer tokens from messages", () => {
    const key = "sk-secret-123456";
    const text = scrubMessage(`bad key ${key} at https://x.test/v1?key=${key}&a=1 with Authorization: Bearer abcdefgh12345`, key);
    expect(text).not.toContain(key);
    expect(text).not.toContain("abcdefgh12345");
    expect(text).toContain("key=***");
  });

  it("shortens long messages", () => {
    expect(scrubMessage("x".repeat(500), "").length).toBeLessThanOrEqual(203);
  });
});

describe("describeBackendStatus", () => {
  const direct = { configured: true, provider: "zhipu" as const, model: "glm-4v-flash" };

  it("names the provider and model when the direct API is in use", () => {
    const s = describeBackendStatus({ backend: "direct", choice: "auto", ping: null, direct });
    expect(s.kind).toBe("ok");
    expect(s.text).toContain("glm-4v-flash");
  });

  it("shows the app's own status when RawReader is in use", () => {
    const s = describeBackendStatus({
      backend: "rawreader",
      choice: "auto",
      ping: { ok: true, ready: true, app: "RawReader", version: "1.0.0", engine: "local" },
      direct: { ...direct, configured: false },
    });
    expect(s.kind).toBe("ok");
    expect(s.text).toContain("RawReader");
  });

  it("guides the user when nothing is available", () => {
    const s = describeBackendStatus({ backend: "none", choice: "auto", ping: { ok: false, error: { code: "unreachable", message: "" } }, direct: { ...direct, configured: false } });
    expect(s.kind).toBe("warn");
    expect(s.text).toContain("插件设置");
  });

  it("falls back to the ping wording for an error reply", () => {
    expect(describeBackendStatus({ error: "boom" })).toEqual({ kind: "error", text: "boom" });
    expect(describeBackendStatus(undefined).kind).toBe("error");
  });
});
