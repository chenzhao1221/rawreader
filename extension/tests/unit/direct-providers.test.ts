import { describe, expect, it } from "vitest";
import {
  PROVIDER_PRESETS,
  apiStyleOf,
  defaultDirectSettings,
  getPreset,
  isDirectConfigured,
  isPresetOrigin,
  originPatternFor,
  parseDirectSettings,
  presetHostPatterns,
  validateBaseUrl,
} from "@/lib/direct/providers";

describe("presets", () => {
  it("offers Gemini, Zhipu, SiliconFlow, Bailian, Volcengine and a custom entry with models and base URLs", () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual(["gemini", "zhipu", "siliconflow", "dashscope", "volcengine", "custom"]);
    expect(getPreset("zhipu").models[0]).toBe("glm-4.6v-flash");
    expect(getPreset("gemini").baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(getPreset("siliconflow").baseUrl).toBe("https://api.siliconflow.cn/v1");
    expect(getPreset("dashscope").baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(getPreset("dashscope").models).toEqual(["qwen3-vl-flash", "qwen3-vl-plus"]);
    expect(getPreset("volcengine").baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(getPreset("volcengine").models).toEqual([]);
    expect(getPreset("custom").baseUrl).toBe("");
  });

  it("uses the Gemini API style only for Gemini", () => {
    expect(apiStyleOf({ provider: "gemini" })).toBe("gemini");
    expect(apiStyleOf({ provider: "zhipu" })).toBe("openai");
    expect(apiStyleOf({ provider: "custom" })).toBe("openai");
  });

  it("lists exactly the preset hosts as manifest host permissions", () => {
    expect(presetHostPatterns().sort()).toEqual([
      "https://api.siliconflow.cn/*",
      "https://ark.cn-beijing.volces.com/*",
      "https://dashscope.aliyuncs.com/*",
      "https://generativelanguage.googleapis.com/*",
      "https://open.bigmodel.cn/*",
    ]);
  });

  it("tells preset hosts from custom ones", () => {
    expect(isPresetOrigin("https://open.bigmodel.cn/api/paas/v4")).toBe(true);
    expect(isPresetOrigin("https://example.com/v1")).toBe(false);
    expect(isPresetOrigin("not a url")).toBe(false);
  });
});

describe("validateBaseUrl", () => {
  it("strips trailing slashes and keeps the path", () => {
    expect(validateBaseUrl(" https://api.example.com/v1/// ")).toEqual({ ok: true, url: "https://api.example.com/v1" });
    expect(validateBaseUrl("https://api.example.com")).toEqual({ ok: true, url: "https://api.example.com" });
  });

  it("accepts plain http only for the local machine", () => {
    expect(validateBaseUrl("http://127.0.0.1:1234/v1").ok).toBe(true);
    expect(validateBaseUrl("http://localhost:11434/v1").ok).toBe(true);
    expect(validateBaseUrl("http://api.example.com/v1").ok).toBe(false);
  });

  it.each([
    ["", "empty"],
    ["api.example.com/v1", "no scheme"],
    ["ftp://example.com", "wrong scheme"],
    ["https://user:pw@example.com/v1", "credentials"],
    ["https://example.com/v1?key=abc", "query string"],
    ["https://example.com/v1#x", "fragment"],
  ])("rejects %j (%s)", (raw) => {
    expect(validateBaseUrl(raw).ok).toBe(false);
  });
});

describe("originPatternFor", () => {
  it("gives the host match pattern without path or port", () => {
    expect(originPatternFor("https://api.example.com:8443/v1")).toBe("https://api.example.com/*");
    expect(originPatternFor("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1/*");
    expect(originPatternFor("nope")).toBeNull();
  });
});

describe("isDirectConfigured / parseDirectSettings", () => {
  const ok = { provider: "zhipu" as const, baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "k-123456", model: "glm-4v-flash", maxTokens: 8192, disableThinking: true };

  it("needs key, model and a valid base URL", () => {
    expect(isDirectConfigured(ok)).toBe(true);
    expect(isDirectConfigured({ ...ok, apiKey: "  " })).toBe(false);
    expect(isDirectConfigured({ ...ok, model: "" })).toBe(false);
    expect(isDirectConfigured({ ...ok, baseUrl: "http://example.com" })).toBe(false);
    expect(isDirectConfigured(null)).toBe(false);
  });

  it("falls back to empty fields for bad stored values", () => {
    expect(isDirectConfigured(parseDirectSettings(undefined))).toBe(false);
    expect(parseDirectSettings({ provider: "nope", baseUrl: 5, apiKey: " k ", model: null })).toEqual({
      provider: "gemini",
      baseUrl: "",
      apiKey: "k",
      model: "",
      maxTokens: 8192,
      disableThinking: true,
    });
    expect(parseDirectSettings(ok)).toEqual(ok);
  });

  it("keeps a valid output limit and thinking switch, and drops wrong ones", () => {
    const saved = { ...ok, maxTokens: 4096, disableThinking: false };
    expect(parseDirectSettings(saved)).toMatchObject({ maxTokens: 4096, disableThinking: false });
    expect(parseDirectSettings({ ...ok, maxTokens: 99999 }).maxTokens).toBe(8192);
    expect(parseDirectSettings({ ...ok, maxTokens: 1.5 }).maxTokens).toBe(8192);
    expect(parseDirectSettings({ ...ok, maxTokens: "4096" }).maxTokens).toBe(8192);
    expect(parseDirectSettings({ ...ok, disableThinking: "no" }).disableThinking).toBe(true);
  });

  it("defaults point at the Gemini preset with no key", () => {
    const d = defaultDirectSettings();
    expect(d.provider).toBe("gemini");
    expect(d.apiKey).toBe("");
    expect(d.model).toBe("gemini-2.5-flash");
  });
});
