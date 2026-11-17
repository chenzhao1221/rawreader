import { describe, expect, it } from "vitest";
import { USER_SETTING_KEYS, defaultUserSettings, parseUserSettings } from "@/lib/user-settings";
import { DEFAULT_BRIDGE_PORT } from "@/lib/bridge/protocol";

describe("parseUserSettings", () => {
  it("returns the defaults for empty storage, with port 18793", () => {
    const settings = parseUserSettings({});
    expect(settings).toEqual(defaultUserSettings());
    expect(settings.bridgePort).toBe(DEFAULT_BRIDGE_PORT);
    expect(settings.bridgePort).toBe(18793);
    expect(settings.bridgeCode).toBe("");
    expect(settings.autoTranslate).toBe(false);
  });

  it("keeps valid stored values", () => {
    const settings = parseUserSettings({
      [USER_SETTING_KEYS.bridgePort]: 20000,
      [USER_SETTING_KEYS.bridgeCode]: "ABCD-1234-EFGH-5678",
      [USER_SETTING_KEYS.autoTranslate]: true,
      [USER_SETTING_KEYS.autoTranslateConcurrency]: 3,
      [USER_SETTING_KEYS.textFont]: "noto",
    });
    expect(settings).toMatchObject({ bridgePort: 20000, bridgeCode: "ABCD-1234-EFGH-5678", autoTranslate: true, autoTranslateConcurrency: 3, textFont: "noto" });
  });

  it("falls back per field when a stored value has the wrong type or range", () => {
    const settings = parseUserSettings({
      [USER_SETTING_KEYS.bridgePort]: 80,
      [USER_SETTING_KEYS.bridgeCode]: 42,
      [USER_SETTING_KEYS.autoTranslate]: "yes",
      [USER_SETTING_KEYS.autoTranslateConcurrency]: 99,
      [USER_SETTING_KEYS.customRules]: "nope",
    });
    expect(settings).toEqual(defaultUserSettings());
  });

  it("never syncs the port or pairing code to other browsers", () => {
    expect(USER_SETTING_KEYS.bridgePort.startsWith("local:")).toBe(true);
    expect(USER_SETTING_KEYS.bridgeCode.startsWith("local:")).toBe(true);
  });
});