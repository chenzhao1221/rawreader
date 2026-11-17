import { describeBridgeError } from "./client";
import type { BridgeFailure } from "./protocol";

export interface ConnectionStatus {
  kind: "ok" | "warn" | "error";
  text: string;
}

const isFailure = (value: unknown): value is BridgeFailure =>
  typeof value === "object" && value !== null && typeof (value as BridgeFailure).code === "string";

/**
 * One line of Chinese status text for the answer to a BRIDGE_PING message. The background worker answers with
 * a BridgePingReply, or with `{ error: string }` when the message handler itself threw.
 */
export function describePingReply(reply: unknown): ConnectionStatus {
  if (typeof reply !== "object" || reply === null) return { kind: "error", text: "没有收到回应。" };
  const r = reply as Record<string, unknown>;
  if (r["ok"] === true) {
    const app = String(r["app"] ?? "");
    const version = String(r["version"] ?? "");
    if (r["ready"] === true) return { kind: "ok", text: `已连上 ${app} ${version}，可以翻译。` };
    const why = isFailure(r["reason"]) ? describeBridgeError(r["reason"]) : "服务未就绪。";
    return { kind: "warn", text: `已连上 ${app} ${version}，但还不能翻译：${why}` };
  }
  if (isFailure(r["error"])) return { kind: "error", text: describeBridgeError(r["error"]) };
  if (typeof r["error"] === "string") return { kind: "error", text: r["error"] };
  return { kind: "error", text: "没有收到回应。" };
}