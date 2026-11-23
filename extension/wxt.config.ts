// Portions ported from libre-manga-translator wxt.config.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: name from the app identity, no WebGPU / WASM / cross-origin isolation, no dev Chromium flags.
import { defineConfig } from "wxt";
import { execSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import identity from "../app-identity.json";
import extensionKey from "./extension-key.json";
import pkg from "./package.json";
import { presetHostPatterns } from "./src/lib/direct/providers";

/** Build label written into the timing records: RAWREADER_BUILD_LABEL, else the short git hash of HEAD. */
function buildLabel(): string {
  const fromEnv = process.env.RAWREADER_BUILD_LABEL?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  // RAWREADER_OUT_DIR builds somewhere else (the measurements build each step into _local without touching the
  // folder Chrome has loaded). The default stays .output.
  outDir: process.env.RAWREADER_OUT_DIR?.trim() || ".output",

  vite: () => ({
    plugins: [tailwindcss() as any],
    define: { __BUILD_ID__: JSON.stringify(buildLabel()) },
    build: {
      target: "esnext",
      minify: import.meta.env.PROD ? "terser" : "esbuild",
    },
  }),

  manifest: {
    // Pins the extension ID. The app only accepts requests from this ID (BRIDGE_EXTENSION_ID in src/shared/bridge.ts).
    key: extensionKey.key,
    name: identity.productName,
    version_name: pkg.version,
    description: `${identity.productName} browser extension: sends comic images to the ${identity.productName} app on this computer (or to a vision API you configure) and draws the translation.`,
    permissions: ["activeTab", "offscreen", "storage", "unlimitedStorage", "declarativeNetRequest", "contextMenus"],
    // `<all_urls>` covers the image hosts, http://127.0.0.1/* (the app bridge) and the direct API hosts.
    // The preset API hosts are also listed on their own so they stay granted if `<all_urls>` is ever narrowed.
    host_permissions: ["<all_urls>", ...presetHostPatterns()],
    // Direct API mode with a custom Base URL: the options page asks for the one host at run time
    // (https only; plain http only for the local machine, see validateBaseUrl in src/lib/direct/providers.ts).
    optional_host_permissions: ["https://*/*", "http://127.0.0.1/*", "http://localhost/*"],
    web_accessible_resources: [
      {
        resources: ["/offscreen.html", "/content-scripts/*", "/fonts/*", "/icon/*"],
        matches: ["<all_urls>"],
      },
    ],
  },

  srcDir: "src",
  modules: ["@wxt-dev/module-svelte"],
});
