// Portions ported from libre-manga-translator src/lib/components/overlay/toasts.ts @ 1ddddc761ff18e6155a071ad3a3f603a836d7136,
// AGPL-3.0-or-later, (C) 2026 Libre Manga Translator; modified by RawReader.
export type ToastKind = "info" | "success" | "warn" | "error";

export interface OverlayToast {
  id: string;
  kind: ToastKind;
  message: string;
}