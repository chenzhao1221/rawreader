// Portions ported from libre-manga-translator wxt.config.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: name from the app identity, no WebGPU / WASM / cross-origin isolation, no dev Chromium flags.
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import identity from "../app-identity.json";
import pkg from "./package.json";

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss() as any],
    build: {
      target: "esnext",
      minify: import.meta.env.PROD ? "terser" : "esbuild",
    },
  }),

  manifest: {
    name: identity.productName,
    version_name: pkg.version,
    description: `${identity.productName} browser extension: sends comic images to the ${identity.productName} app on this computer and draws the translation.`,
    permissions: ["activeTab", "offscreen", "storage", "unlimitedStorage", "declarativeNetRequest"],
    // `<all_urls>` also covers http://127.0.0.1/* (the app bridge) and the image hosts.
    host_permissions: ["<all_urls>"],
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
