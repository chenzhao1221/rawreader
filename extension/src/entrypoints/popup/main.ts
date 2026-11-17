// Portions ported from libre-manga-translator src/entrypoints/popup/main.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
//
// RawReader changes: no first-run wizard; the options page opens on install (see the background worker).
import { mount } from "svelte";
import "@/assets/app.css";
import App from "./App.svelte";

let hostname = "";
let title = "";
let path = "";

try {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    title = tab.title ?? "";
    if (tab.url) {
      try {
        const url = new URL(tab.url);
        hostname = url.hostname;
        path = url.pathname;
      } catch {
        hostname = "";
        path = "";
      }
    }
  }
} catch {}

const app = mount(App, {
  target: document.getElementById("app")!,
  props: {
    hostname,
    title,
    path,
  },
});

export default app;
