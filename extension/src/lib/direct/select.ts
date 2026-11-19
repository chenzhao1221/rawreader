// RawReader extension: which backend answers a translation request (pure).
import type { BackendChoice } from "./providers";

export type BackendKind = "rawreader" | "direct" | "none";

export interface BridgeProbeSummary {
  /** The app answered `GET /ping`. */
  reachable: boolean;
  /** The app says its recognition and translation services are ready. */
  ready: boolean;
}

export interface SelectInput {
  choice: BackendChoice;
  /** null when the bridge was not probed (choice is "direct"). */
  bridge: BridgeProbeSummary | null;
  directConfigured: boolean;
}

/**
 * "auto" (the default): RawReader when it is running and ready, else the configured direct API, else nothing.
 * When the app is running but not ready and no direct API is configured, RawReader is still chosen so its own
 * reason (models missing, key missing) reaches the user.
 * "rawreader" and "direct" never fall back to the other one.
 */
export function selectBackend(input: SelectInput): BackendKind {
  const { choice, bridge, directConfigured } = input;
  if (choice === "rawreader") return "rawreader";
  if (choice === "direct") return directConfigured ? "direct" : "none";
  if (bridge?.reachable && bridge.ready) return "rawreader";
  if (directConfigured) return "direct";
  if (bridge?.reachable) return "rawreader";
  return "none";
}
