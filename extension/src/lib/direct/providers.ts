// RawReader extension: direct API mode. Provider presets and settings validation (pure, no browser APIs).
// Presets only fill the form; the user can change every field.

export type ProviderId = "gemini" | "zhipu" | "siliconflow" | "dashscope" | "volcengine" | "custom";

/** "gemini": native generateContent. "openai": POST <base>/chat/completions with image_url content. */
export type ApiStyle = "gemini" | "openai";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  style: ApiStyle;
  baseUrl: string;
  /** First entry is the default. All are suggestions; the model field accepts any name. */
  models: string[];
  /** Short Chinese hint shown under the form. */
  hint: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    style: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
    hint: "在 Google AI Studio 申请 API Key。国内网络通常需要代理。",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    style: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.6v-flash", "glm-4v-flash", "glm-4.1v-thinking-flash", "glm-4v-plus-0111"],
    hint: "glm-4v-flash 免费，适合先试用；框的位置可能不够准。",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    style: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen2.5-VL-32B-Instruct", "Qwen/Qwen2.5-VL-72B-Instruct", "Pro/Qwen/Qwen2.5-VL-7B-Instruct"],
    hint: "需要选支持图片输入的视觉模型（VL）。",
  },
  {
    id: "dashscope",
    label: "阿里云百炼",
    style: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3-vl-flash", "qwen3-vl-plus"],
    hint: "百炼的视觉模型名，例如 qwen3-vl-flash；需要在百炼控制台开通并获取 API Key。",
  },
  {
    id: "volcengine",
    label: "火山引擎豆包",
    style: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [],
    hint: "模型一栏填写你在火山方舟创建的接入点 ID（ep-开头）或模型 ID；需要选支持图片输入的模型。",
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    style: "openai",
    baseUrl: "",
    models: [],
    hint: "填写服务商的 Base URL（到 /v1 为止）、API Key 和支持图片输入的模型名。",
  },
];

export function getPreset(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!;
}

export function isProviderId(value: unknown): value is ProviderId {
  return PROVIDER_PRESETS.some((p) => p.id === value);
}

export interface DirectApiSettings {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Output length limit sent as max_tokens (OpenAI-compatible styles). */
  maxTokens: number;
  /** Ask services that have a thinking switch to turn it off. */
  disableThinking: boolean;
}

export const DEFAULT_MAX_TOKENS = 8192;
export const MIN_MAX_TOKENS = 256;
export const MAX_MAX_TOKENS = 32768;

export type BackendChoice = "auto" | "rawreader" | "direct";

export function isBackendChoice(value: unknown): value is BackendChoice {
  return value === "auto" || value === "rawreader" || value === "direct";
}

export function defaultDirectSettings(): DirectApiSettings {
  const preset = getPreset("gemini");
  return {
    provider: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.models[0] ?? "",
    maxTokens: DEFAULT_MAX_TOKENS,
    disableThinking: true,
  };
}

/** API style of the saved settings: Gemini only when the provider is Gemini, else OpenAI-compatible. */
export function apiStyleOf(settings: Pick<DirectApiSettings, "provider">): ApiStyle {
  return getPreset(settings.provider).style;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Checks a Base URL and returns it without a trailing slash. HTTPS only; plain HTTP is accepted for loopback
 * addresses (a local server). No credentials, query string or fragment.
 */
export function validateBaseUrl(raw: string): BaseUrlCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "请填写 Base URL。" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "Base URL 格式不正确。" };
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, reason: "Base URL 必须以 https:// 开头（本机地址可以用 http://）。" };
  }
  if (url.username || url.password) return { ok: false, reason: "Base URL 里不能带用户名或密码。" };
  if (url.search || url.hash) return { ok: false, reason: "Base URL 里不能带 ? 或 # 参数。" };
  return { ok: true, url: `${url.origin}${url.pathname}`.replace(/\/+$/, "") };
}

/** Match pattern for the host of a Base URL (`https://host/*`), or null when the URL is invalid. */
export function originPatternFor(baseUrl: string): string | null {
  const checked = validateBaseUrl(baseUrl);
  if (!checked.ok) return null;
  const url = new URL(checked.url);
  return `${url.protocol}//${url.hostname}/*`;
}

/** Host permissions the manifest carries for the presets. Custom hosts are requested at run time. */
export function presetHostPatterns(): string[] {
  const patterns = PROVIDER_PRESETS.map((p) => (p.baseUrl ? originPatternFor(p.baseUrl) : null));
  return [...new Set(patterns.filter((p): p is string => p !== null))];
}

/** True when the manifest already grants the host of this Base URL. */
export function isPresetOrigin(baseUrl: string): boolean {
  const pattern = originPatternFor(baseUrl);
  return pattern !== null && presetHostPatterns().includes(pattern);
}

/** A form is usable when the key and model are set and the Base URL is valid. */
export function isDirectConfigured(settings: DirectApiSettings | null | undefined): boolean {
  if (!settings) return false;
  return settings.apiKey.trim().length > 0 && settings.model.trim().length > 0 && validateBaseUrl(settings.baseUrl).ok;
}

/** Turns a stored value of unknown shape into settings. Wrong types fall back to the defaults. */
export function parseDirectSettings(value: unknown): DirectApiSettings {
  const base = defaultDirectSettings();
  if (typeof value !== "object" || value === null) return { ...base, baseUrl: "", model: "" };
  const v = value as Record<string, unknown>;
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  const maxTokens = v["maxTokens"];
  return {
    provider: isProviderId(v["provider"]) ? v["provider"] : base.provider,
    baseUrl: str(v["baseUrl"]).trim(),
    apiKey: str(v["apiKey"]).trim(),
    model: str(v["model"]).trim(),
    maxTokens:
      typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= MIN_MAX_TOKENS && maxTokens <= MAX_MAX_TOKENS
        ? maxTokens
        : DEFAULT_MAX_TOKENS,
    disableThinking: typeof v["disableThinking"] === "boolean" ? v["disableThinking"] : true,
  };
}
