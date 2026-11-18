import { describe, expect, it } from "vitest";
import { USER_SETTING_KEYS, defaultUserSettings, parseUserSettings } from "@/lib/user-settings";

describe("parseUserSettings", () => {
  it("returns the defaults for empty storage", () => {
    const settings = parseUserSettings({});
    expect(settings).toEqual(defaultUserSettings());
    expect(settings.autoTranslate).toBe(false);
  });

  it("keeps no connection settings: no port and no pairing code", () => {
    expect(Object.keys(defaultUserSettings())).not.toContain("bridgePort");
    expect(Object.keys(defaultUserSettings())).not.toContain("bridgeCode");
    expect(Object.keys(USER_SETTING_KEYS).join(" ")).not.toMatch(/bridge/i);
  });

  it("keeps valid stored values", () => {
    const settings = parseUserSettings({
      [USER_SETTING_KEYS.autoTranslate]: true,
      [USER_SETTING_KEYS.autoTranslateConcurrency]: 3,
      [USER_SETTING_KEYS.textFont]: "noto",
    });
    expect(settings).toMatchObject({ autoTranslate: true, autoTranslateConcurrency: 3, textFont: "noto" });
  });

  it("falls back per field when a stored value has the wrong type or range", () => {
    const settings = parseUserSettings({
      [USER_SETTING_KEYS.autoTranslate]: "yes",
      [USER_SETTING_KEYS.autoTranslateConcurrency]: 99,
      [USER_SETTING_KEYS.customRules]: "nope",
    });
    expect(settings).toEqual(defaultUserSettings());
  });
});