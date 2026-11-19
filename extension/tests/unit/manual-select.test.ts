import { describe, expect, it } from "vitest";
import { offersManualSelect, type DetectionOutcome } from "@/lib/manual-select";

describe("offersManualSelect", () => {
  // Outcome type x switch state (on: only-when-no-text, off: legacy behaviour).
  const cases: Array<{ outcome: DetectionOutcome; onlyWhenNoText: boolean; expected: boolean }> = [
    { outcome: "no-text", onlyWhenNoText: true, expected: true },
    { outcome: "no-text", onlyWhenNoText: false, expected: true },
    { outcome: "error", onlyWhenNoText: true, expected: false },
    { outcome: "error", onlyWhenNoText: false, expected: true },
  ];

  it.each(cases)("outcome $outcome with switch on=$onlyWhenNoText offers manual selection: $expected", ({ outcome, onlyWhenNoText, expected }) => {
    expect(offersManualSelect(outcome, onlyWhenNoText)).toBe(expected);
  });
});
