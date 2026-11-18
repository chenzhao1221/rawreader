// RawReader extension: user settings kept in extension storage. The app owns every translation setting; these
// are the extension-side ones (appearance, site rules). The connection needs no setting: the extension finds the
// app by probing its fixed port range.
import { DefaultConfig } from "./configs";

export interface UserSettings {
  autoTranslate: boolean;
  autoTranslateConcurrency: number;
  skipBboxRefining: boolean;
  alwaysInpaint: boolean;
  textFont: string;
  customFonts: { name: string; dataUrl: string }[];
  customRules: SiteRule[];
}

/** Storage key for each field. */
export const USER_SETTING_KEYS = {
  autoTranslate: "sync:auto-translate",
  autoTranslateConcurrency: "sync:auto-translate-concurrency",
  skipBboxRefining: "sync:skip-bbox-refining",
  alwaysInpaint: "sync:always-inpaint",
  textFont: "sync:text-font",
  customFonts: "local:custom-fonts",
  customRules: "sync:custom-site-rules",
} as const satisfies Record<keyof UserSettings, `${"local" | "sync"}:${string}`>;

export function defaultUserSettings(): UserSettings {
  return {
    autoTranslate: DefaultConfig.autoTranslate,
    autoTranslateConcurrency: DefaultConfig.autoTranslateConcurrency,
    skipBboxRefining: false,
    alwaysInpaint: DefaultConfig.alwaysInpaint,
    textFont: DefaultConfig.bundleFonts[0]!.id,
    customFonts: [],
    customRules: [],
  };
}

/** Turns raw storage values into settings. Anything of the wrong type falls back to its default. */
export function parseUserSettings(saved: Record<string, unknown>): UserSettings {
  const base = defaultUserSettings();
  const pick = <K extends keyof UserSettings>(key: K, ok: (value: unknown) => boolean): UserSettings[K] => {
    const value = saved[USER_SETTING_KEYS[key]];
    return ok(value) ? (value as UserSettings[K]) : base[key];
  };
  const concurrency = pick("autoTranslateConcurrency", (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 8);
  return {
    autoTranslate: pick("autoTranslate", (v) => typeof v === "boolean"),
    autoTranslateConcurrency: concurrency,
    skipBboxRefining: pick("skipBboxRefining", (v) => typeof v === "boolean"),
    alwaysInpaint: pick("alwaysInpaint", (v) => typeof v === "boolean"),
    textFont: pick("textFont", (v) => typeof v === "string" && v.length > 0),
    customFonts: pick("customFonts", Array.isArray),
    customRules: pick("customRules", Array.isArray),
  };
}

export async function loadUserSettings(): Promise<UserSettings> {
  const keys = Object.values(USER_SETTING_KEYS);
  const items = await storage.getItems([...keys]);
  return parseUserSettings(Object.fromEntries(items.map((item) => [item.key, item.value])));
}

export async function saveUserSettings(settings: UserSettings): Promise<void> {
  const entries = (Object.keys(USER_SETTING_KEYS) as Array<keyof UserSettings>).map((field) => ({
    key: USER_SETTING_KEYS[field],
    value: settings[field],
  }));
  await storage.setItems(entries);
}