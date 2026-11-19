// RawReader extension: direct API settings in extension storage.
// The API key lives only in `local:` storage (chrome.storage.local): it is not synced to the browser account,
// not logged, and only read by the background worker and the options page.
import { isBackendChoice, parseDirectSettings, type BackendChoice, type DirectApiSettings } from "./providers";

export const BACKEND_CHOICE_KEY = "local:backend-choice";
export const DIRECT_API_KEY = "local:direct-api";

export interface BackendSettings {
  choice: BackendChoice;
  direct: DirectApiSettings;
}

export async function loadBackendSettings(): Promise<BackendSettings> {
  const items = await storage.getItems([BACKEND_CHOICE_KEY, DIRECT_API_KEY]);
  const byKey = Object.fromEntries(items.map((item) => [item.key, item.value]));
  const choice = byKey[BACKEND_CHOICE_KEY];
  return {
    choice: isBackendChoice(choice) ? choice : "auto",
    direct: parseDirectSettings(byKey[DIRECT_API_KEY]),
  };
}

export async function saveBackendSettings(settings: BackendSettings): Promise<void> {
  await storage.setItems([
    { key: BACKEND_CHOICE_KEY, value: settings.choice },
    { key: DIRECT_API_KEY, value: settings.direct },
  ]);
}
