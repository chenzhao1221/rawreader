// RawReader extension: one line of Chinese status text for the popup, sidebar and options page (pure).
import { describePingReply, type ConnectionStatus } from "../bridge/status";
import type { BridgePingReply } from "../bridge/protocol";
import { getPreset, type BackendChoice, type ProviderId } from "./providers";
import type { BackendKind } from "./select";

/** The background worker's answer to a BACKEND_STATUS message. */
export interface BackendStatusReply {
  backend: BackendKind;
  choice: BackendChoice;
  /** null when the app was not probed (the user chose "direct"). */
  ping: BridgePingReply | null;
  direct: { configured: boolean; provider: ProviderId; model: string };
}

const isStatusReply = (reply: unknown): reply is BackendStatusReply => {
  const r = reply as Partial<BackendStatusReply> | null;
  return typeof r === "object" && r !== null && typeof r.backend === "string" && typeof r.direct === "object" && r.direct !== null;
};

export function describeBackendStatus(reply: unknown): ConnectionStatus {
  if (!isStatusReply(reply)) {
    // `{ error: string }` from a handler that threw, or no answer at all.
    return describePingReply(reply);
  }
  const direct = reply.direct.configured ? `${getPreset(reply.direct.provider).label} · ${reply.direct.model}` : null;
  switch (reply.backend) {
    case "rawreader":
      return describePingReply(reply.ping);
    case "direct":
      return { kind: "ok", text: `使用直连 API：${direct}。` };
    default:
      return {
        kind: "warn",
        text: reply.choice === "direct" ? "直连 API 还没填完，请在插件设置中填写。" : "暂无可用后端：请先打开 RawReader，或在插件设置中填写直连 API。",
      };
  }
}
