import { describe, expect, it } from "vitest";
import { buildPrompt } from "@/lib/direct/prompt";
import { buildRequest, extractAnswerText, extractErrorText } from "@/lib/direct/request";
import type { DirectApiSettings } from "@/lib/direct/providers";

const KEY = "test-key-0123456789";
const image = { mime: "image/jpeg", base64: "QUJD" };

const gemini: DirectApiSettings = {
  provider: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
  apiKey: KEY,
  model: "gemini-2.5-flash",
};
const zhipu: DirectApiSettings = {
  provider: "zhipu",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: KEY,
  model: "glm-4v-flash",
};

function built(settings: DirectApiSettings, img: typeof image | null = image) {
  const result = buildRequest(settings, "PROMPT", img);
  if (!result.ok) throw new Error(result.reason);
  return result.request;
}

describe("buildRequest: Gemini", () => {
  it("posts generateContent with the image inline and the key in a header", () => {
    const req = built(gemini);
    expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(req.url).not.toContain(KEY);
    expect(req.headers["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(req.body);
    expect(body.contents[0].parts[0]).toEqual({ text: "PROMPT" });
    expect(body.contents[0].parts[1]).toEqual({ inline_data: { mime_type: "image/jpeg", data: "QUJD" } });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(req.body).not.toContain(KEY);
  });

  it("omits the image and the JSON mode for a text-only test", () => {
    const body = JSON.parse(built(gemini, null).body);
    expect(body.contents[0].parts).toHaveLength(1);
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });
});

describe("buildRequest: OpenAI compatible", () => {
  it("posts chat/completions with one user message holding text and a data URL image", () => {
    const req = built(zhipu);
    expect(req.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(req.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(req.body);
    expect(body.model).toBe("glm-4v-flash");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "PROMPT" });
    expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } });
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBeUndefined();
    expect(req.body).not.toContain(KEY);
  });

  it("uses the custom base URL as given", () => {
    const req = built({ provider: "custom", baseUrl: "http://127.0.0.1:1234/v1/", apiKey: KEY, model: "m" });
    expect(req.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
  });
});

describe("buildRequest: invalid settings", () => {
  it("refuses a missing key, model or bad base URL without producing a request", () => {
    expect(buildRequest({ ...zhipu, apiKey: "" }, "p", image).ok).toBe(false);
    expect(buildRequest({ ...zhipu, model: " " }, "p", image).ok).toBe(false);
    expect(buildRequest({ ...zhipu, baseUrl: "http://example.com/v1" }, "p", image).ok).toBe(false);
  });
});

describe("extractAnswerText", () => {
  it("reads Gemini candidates and skips thought parts", () => {
    const body = { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: '{"items"' }, { text: ":[]}" }] } }] };
    expect(extractAnswerText(gemini, body)).toBe('{"items":[]}');
  });

  it("reads an OpenAI string answer and an array of text parts", () => {
    expect(extractAnswerText(zhipu, { choices: [{ message: { content: "hello" } }] })).toBe("hello");
    expect(extractAnswerText(zhipu, { choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] })).toBe("ab");
  });

  it("returns an empty string for anything unexpected", () => {
    expect(extractAnswerText(zhipu, null)).toBe("");
    expect(extractAnswerText(zhipu, { choices: [] })).toBe("");
    expect(extractAnswerText(gemini, { candidates: [{}] })).toBe("");
    expect(extractAnswerText(gemini, "text")).toBe("");
  });
});

describe("extractErrorText", () => {
  it("finds the message in the common error shapes", () => {
    expect(extractErrorText({ error: { message: "bad key" } })).toBe("bad key");
    expect(extractErrorText({ error: "plain" })).toBe("plain");
    expect(extractErrorText({ message: "m" })).toBe("m");
    expect(extractErrorText(undefined)).toBe("");
  });
});

describe("buildPrompt", () => {
  it("names the target language, the size and the JSON format", () => {
    const p = buildPrompt({ targetLang: "Chinese (Simplified)", width: 800.4, height: 1200 });
    expect(p).toContain("Chinese (Simplified)");
    expect(p).toContain("800x1200");
    expect(p).toContain('"items"');
    expect(p).toContain("0 to 1000");
  });

  it("adds series background only when it is given", () => {
    expect(buildPrompt({ targetLang: "x", width: 1, height: 1 })).not.toContain("Background");
    const p = buildPrompt({ targetLang: "x", width: 1, height: 1, context: { seriesName: "Foo", summary: "S", dictionary: "a = b" } });
    expect(p).toContain("Series: Foo");
    expect(p).toContain("Story so far: S");
    expect(p).toContain("a = b");
  });

  it("lists user regions on the 0-1000 scale and asks for the same count", () => {
    const p = buildPrompt({ targetLang: "x", width: 100, height: 100, regions: [{ x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 }, { x1: 0, y1: 0, x2: 1, y2: 1 }] });
    expect(p).toContain("1. [100,200,500,600]");
    expect(p).toContain("2. [0,0,1000,1000]");
    expect(p).toContain("exactly 2 items");
  });
});
