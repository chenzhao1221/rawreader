import { describe, expect, it } from "vitest";
import { describePingReply } from "@/lib/bridge/status";

describe("describePingReply", () => {
  it("reports a ready app", () => {
    expect(describePingReply({ ok: true, ready: true, app: "App", version: "1.0", engine: "local" })).toEqual({
      kind: "ok",
      text: "已连上 App 1.0，可以翻译。",
    });
  });

  it("warns with the reason when the app is not ready", () => {
    const status = describePingReply({ ok: true, ready: false, app: "App", version: "1.0", engine: "local", reason: { code: "MODEL_MISSING", message: "x" } });
    expect(status.kind).toBe("warn");
    expect(status.text).toContain("已连上 App 1.0");
  });

  it("maps a bridge error code to Chinese text", () => {
    const status = describePingReply({ ok: false, error: { code: "unauthorized", message: "bad" } });
    expect(status.kind).toBe("error");
    expect(status.text).toMatch(/[\u4e00-\u9fff]/);
    expect(status.text).not.toBe("bad");
  });

  it("passes a plain error string from the background worker through", () => {
    expect(describePingReply({ error: "boom" })).toEqual({ kind: "error", text: "boom" });
  });

  it("copes with a missing or malformed reply", () => {
    expect(describePingReply(undefined).kind).toBe("error");
    expect(describePingReply(null).kind).toBe("error");
    expect(describePingReply({}).kind).toBe("error");
  });
});