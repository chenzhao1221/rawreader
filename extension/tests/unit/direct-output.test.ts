import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@/lib/bridge/client";
import { FALLBACK_MAX_TOKENS, outputLimitsFor, translateDirect, TRUNCATED_NOTICE } from "@/lib/direct/client";
import type { ImageCodec } from "@/lib/direct/image";
import { looksTruncated } from "@/lib/direct/parse";
import type { DirectApiSettings } from "@/lib/direct/providers";
import {
  answerTruncated,
  buildRequest,
  effectiveMaxTokens,
  isMaxTokensError,
  thinkingFieldsFor,
} from "@/lib/direct/request";

const KEY = "sk-output-test-key-5555";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const codec: ImageCodec = {
  measure: async () => ({ width: 800, height: 1200 }),
  encodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 9]),
  cropEncodeJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 9]),
};

const settings = (over: Partial<DirectApiSettings> = {}): DirectApiSettings => ({
  provider: "zhipu",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: KEY,
  model: "glm-4.6v-flash",
  maxTokens: 8192,
  disableThinking: true,
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const answer = (content: string, finish = "stop") => json({ choices: [{ message: { content }, finish_reason: finish }] });
const bodyOf = (fetchImpl: ReturnType<typeof vi.fn<FetchLike>>, call: number) => JSON.parse(String(fetchImpl.mock.calls[call]![1]?.body));

describe("output limit", () => {
  it("sends the saved limit as max_tokens", () => {
    const req = buildRequest(settings({ maxTokens: 6000 }), "p", null);
    expect(req.ok && JSON.parse(req.request.body).max_tokens).toBe(6000);
  });

  it("caps glm-4v-flash at 1024 by model name", () => {
    expect(effectiveMaxTokens("glm-4v-flash", 8192)).toBe(1024);
    expect(effectiveMaxTokens("GLM-4V-Flash", 8192)).toBe(1024);
    expect(effectiveMaxTokens("glm-4.6v-flash", 8192)).toBe(8192);
  });

  it("tries the requested limit, then 4096 and 2048 only when they are smaller", () => {
    expect(FALLBACK_MAX_TOKENS).toEqual([4096, 2048]);
    expect(outputLimitsFor(settings({ maxTokens: 8192 }))).toEqual([8192, 4096, 2048]);
    expect(outputLimitsFor(settings({ maxTokens: 3000 }))).toEqual([3000, 2048]);
    expect(outputLimitsFor(settings({ model: "glm-4v-flash" }))).toEqual([1024]);
    expect(outputLimitsFor(settings({ provider: "gemini", model: "gemini-2.5-flash" }))).toEqual([undefined]);
  });

  it("recognises the refusal of a too-large max_tokens only on HTTP 400", () => {
    expect(isMaxTokensError(400, "max_tokens is too large: 8192. This model supports at most 1024")).toBe(true);
    expect(isMaxTokensError(500, "max_tokens")).toBe(false);
    expect(isMaxTokensError(400, "invalid image")).toBe(false);
  });

  it("steps down to 4096 after a refusal and succeeds there", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      const max = JSON.parse(String(init?.body)).max_tokens;
      if (max === 8192) return json({ error: { message: "max_tokens exceeds the limit" } }, 400);
      return answer('{"items":[{"box":[0,0,1000,500],"translation":"T"}]}');
    });
    const reply = await translateDirect(settings(), { bytes: JPEG, codec, targetLang: "zh", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchImpl, 1).max_tokens).toBe(4096);
    expect(reply).toMatchObject({ result: { units: [{ translation: "T" }] } });
  });

  it("gives up after the 2048 retry and reports the service message", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: { message: "max_tokens too large" } }, 400));
    const reply = await translateDirect(settings(), { bytes: JPEG, codec, targetLang: "zh", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchImpl, 2).max_tokens).toBe(2048);
    expect(reply).toMatchObject({ error: { code: "direct-bad-request" } });
  });

  it("does not step down for other 400 errors", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: { message: "invalid image" } }, 400));
    await translateDirect(settings(), { bytes: JPEG, codec, targetLang: "zh", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("thinking switch", () => {
  it("turns thinking off with the Zhipu field", () => {
    expect(thinkingFieldsFor("zhipu", true)).toEqual({ thinking: { type: "disabled" } });
  });

  it("turns thinking off with the DashScope field", () => {
    expect(thinkingFieldsFor("dashscope", true)).toEqual({ enable_thinking: false });
  });

  it("sends nothing for other services, or when the switch is off", () => {
    expect(thinkingFieldsFor("siliconflow", true)).toEqual({});
    expect(thinkingFieldsFor("volcengine", true)).toEqual({});
    expect(thinkingFieldsFor("custom", true)).toEqual({});
    expect(thinkingFieldsFor("zhipu", false)).toEqual({});
  });

  it("puts the field in the request body", () => {
    const req = buildRequest(settings({ provider: "dashscope", model: "qwen3-vl-flash" }), "p", null);
    expect(req.ok && JSON.parse(req.request.body).enable_thinking).toBe(false);
  });
});

describe("truncated output", () => {
  it("reads finish_reason=length for OpenAI-style answers", () => {
    expect(answerTruncated({ provider: "zhipu" }, { choices: [{ finish_reason: "length" }] })).toBe(true);
    expect(answerTruncated({ provider: "zhipu" }, { choices: [{ finish_reason: "stop" }] })).toBe(false);
  });

  it("reads MAX_TOKENS for Gemini answers", () => {
    expect(answerTruncated({ provider: "gemini" }, { candidates: [{ finishReason: "MAX_TOKENS" }] })).toBe(true);
  });

  it("sees an answer that starts like JSON but does not parse", () => {
    expect(looksTruncated('{"items":[{"box":[1,2,3,4],"translation":"A"},{"box":[1,2')).toBe(true);
    expect(looksTruncated('{"items":[]}')).toBe(false);
    expect(looksTruncated("plain text answer")).toBe(false);
  });

  it("shows a notice with the answer when the output was cut short", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => answer('{"items":[{"box":[0,0,1000,500],"translation":"T"}]}', "length"));
    const reply = await translateDirect(settings(), { bytes: JPEG, codec, targetLang: "zh", fetchImpl });
    expect(reply).toMatchObject({ result: { notice: TRUNCATED_NOTICE } });
    expect(TRUNCATED_NOTICE).toBe("输出被截断，可调大输出上限");
  });

  it("has no notice when the answer is complete", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => answer('{"items":[]}'));
    const reply = await translateDirect(settings(), { bytes: JPEG, codec, targetLang: "zh", fetchImpl });
    expect(reply).toMatchObject({ result: { units: [] } });
    expect("notice" in (reply as { result: object }).result).toBe(false);
  });
});
