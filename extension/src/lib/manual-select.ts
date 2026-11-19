// RawReader extension: when the overlay offers manual box selection after a detection result.

/** "no-text": the app answered and found no text boxes. "error": the request failed (HTTP, network, timeout, parse, cut-off). */
export type DetectionOutcome = "no-text" | "error";

/**
 * True when the overlay should offer manual box selection after `outcome`. With `onlyWhenNoText` on, only a
 * successful answer without text boxes offers it; every error just shows the error message.
 */
export function offersManualSelect(outcome: DetectionOutcome, onlyWhenNoText: boolean): boolean {
  return outcome === "no-text" || !onlyWhenNoText;
}
