// RawReader extension: direct API errors. They use the same `{ code, message }` shape as the bridge failures.
// `message` is English and safe to log (it never holds the API key); `describeDirectError` gives the Chinese text.

export interface DirectFailure {
  code: string;
  message: string;
}

export const NO_BACKEND_CODE = "no-backend";

export function isDirectCode(code: string): boolean {
  return code === NO_BACKEND_CODE || code.startsWith("direct-");
}

/** Maps an HTTP status of the API to a stable code. */
export function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return "direct-auth";
  if (status === 404) return "direct-not-found";
  if (status === 408) return "direct-timeout";
  if (status === 413) return "direct-image-too-large";
  if (status === 429) return "direct-rate-limit";
  if (status >= 500) return "direct-server";
  return "direct-bad-request";
}

/** Removes the API key from a text and shortens it, so error messages can be shown and logged. */
export function scrubMessage(text: string, apiKey: string, maxLength = 200): string {
  let out = text.replace(/\s+/g, " ").trim();
  if (apiKey.length >= 4) out = out.split(apiKey).join("***");
  out = out.replace(/([?&](?:key|api_key|apikey|token)=)[^&\s"']+/gi, "$1***");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***");
  return out.length > maxLength ? `${out.slice(0, maxLength)}...` : out;
}

/** Simplified Chinese text for a direct API failure, or null when the code is not a direct one. */
export function describeDirectError(failure: DirectFailure): string | null {
  const detail = failure.message ? `（${failure.message}）` : "";
  switch (failure.code) {
    case NO_BACKEND_CODE:
      return "还没有可用的翻译后端：请先打开 RawReader 应用，或在插件设置中填写直连 API。";
    case "direct-auth":
      return `API 密钥被拒绝，请检查密钥是否正确或过期。${detail}`;
    case "direct-rate-limit":
      return `请求太频繁或额度用完了，请稍后再试。${detail}`;
    case "direct-not-found":
      return `找不到这个接口或模型，请检查接口地址和模型名。${detail}`;
    case "direct-bad-request":
      return `服务商拒绝了这个请求，请确认模型支持图片输入。${detail}`;
    case "direct-image-too-large":
      return "图片太大，服务商没有接收。";
    case "direct-server":
      return `服务商暂时出错，请稍后再试。${detail}`;
    case "direct-timeout":
      return "服务商没有及时回应，请稍后再试。";
    case "direct-network":
      return "连不上服务商，请检查网络或代理。";
    case "direct-permission":
      return "插件还没有访问这个地址的权限，请在插件设置里点“保存并测试”并允许。";
    case "direct-empty-response":
      return "模型没有返回内容。";
    case "direct-image":
      return `这张图片没法处理：${failure.message}`;
    case "direct-config":
      return `直连 API 设置不完整：${failure.message}`;
    default:
      return null;
  }
}
