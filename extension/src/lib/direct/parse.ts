// RawReader extension: direct API mode. Turns the model's answer into boxes and translations (pure).
// Models differ in how closely they follow the JSON format, so this parser is tolerant and never throws:
//   1. valid JSON (also inside a markdown fence or after some chatter)
//   2. complete objects salvaged from a cut-off or malformed answer
//   3. the whole answer as one translation in a banner box at the top of the image ("degraded")
import type { NormBox } from "./prompt";

export interface ParsedUnit {
  box: NormBox;
  source: string;
  translation: string;
}

export interface ParseResult {
  units: ParsedUnit[];
  /** True when the answer was not usable as designed (no JSON, or boxes missing) and a fallback layout was used. */
  degraded: boolean;
}

export interface ParseOptions {
  /** Size of the image that was sent, to read pixel coordinates from models that ignore the 0-1000 scale. */
  width: number;
  height: number;
  /** Regions the request asked for. The result then has exactly one unit per region. */
  regions?: NormBox[] | undefined;
}

/** Where the whole answer goes when nothing else can be placed. */
export const FALLBACK_BOX: NormBox = { x1: 0.05, y1: 0.02, x2: 0.95, y2: 0.3 };

const TRANSLATION_KEYS = ["translation", "translated", "translated_text", "translatedText", "target", "tgt"];
const SOURCE_KEYS = ["source", "original", "text", "ocr", "src"];
const BOX_KEYS = ["box", "bbox", "bounding_box", "boundingBox", "rect"];
const LIST_KEYS = ["items", "bubbles", "results", "texts", "regions", "data", "translations"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value.trim();
  }
  return undefined;
}

/** Removes a markdown code fence around the answer. */
function stripFence(text: string): string {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim().replace(/^```(?:json|JSON)?\s*/, "");
}

/** Parses JSON from the answer, allowing text before and after it. Returns undefined when nothing parses. */
export function extractJson(raw: string): unknown {
  const text = stripFence(raw);
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the bracket search.
  }
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const closer = text[start] === "{" ? "}" : "]";
    const end = text.lastIndexOf(closer);
    if (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Try the next candidate.
      }
    }
  }
  return undefined;
}

/**
 * Every complete `{...}` object inside a text, skipping braces in strings. For cut-off answers: the wrapper
 * object never closes, but the items inside it did.
 */
export function salvageObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") starts.push(i);
    else if (ch === "}" && starts.length > 0) {
      const start = starts.pop()!;
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        if (isRecord(value)) out.push(value);
      } catch {
        // A malformed object is skipped.
      }
    }
  }
  // A closed wrapper holds the list itself; it is not an item.
  return out.filter((o) => !LIST_KEYS.some((k) => Array.isArray(o[k])));
}

function itemsFrom(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return undefined;
  for (const key of LIST_KEYS) {
    const list = value[key];
    if (Array.isArray(list)) return list.filter(isRecord);
  }
  const anyList = Object.values(value).find((v) => Array.isArray(v) && v.some(isRecord));
  if (Array.isArray(anyList)) return anyList.filter(isRecord);
  // A single item at the top level.
  if (firstString(value, TRANSLATION_KEYS) !== undefined) return [value];
  return undefined;
}

type RawBox = [number, number, number, number];

function readBox(item: Record<string, unknown>): RawBox | null {
  const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  let arr: unknown[] | undefined;
  let yFirst = false;
  for (const key of BOX_KEYS) {
    if (Array.isArray(item[key])) {
      arr = item[key] as unknown[];
      break;
    }
    const nested = item[key];
    if (isRecord(nested)) {
      arr = [nested["x1"], nested["y1"], nested["x2"], nested["y2"]];
      break;
    }
  }
  if (!arr && Array.isArray(item["box_2d"])) {
    // Gemini's native grounding format is [ymin, xmin, ymax, xmax].
    arr = item["box_2d"] as unknown[];
    yFirst = true;
  }
  if (!arr && "x1" in item) arr = [item["x1"], item["y1"], item["x2"], item["y2"]];
  if (!arr || arr.length < 4) return null;
  const nums = arr.slice(0, 4).map(num);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [a, b, c, d] = nums as [number, number, number, number];
  return yFirst ? [b, a, d, c] : [a, b, c, d];
}

/** Picks the coordinate scale of the whole answer so all boxes are read the same way. */
function scaleFor(boxes: RawBox[], opts: ParseOptions): { x: number; y: number } {
  const max = Math.max(0, ...boxes.flat());
  if (max <= 1.0001) return { x: 1, y: 1 }; // already fractions
  if (max <= 1000.5) return { x: 1000, y: 1000 }; // the scale the prompt asks for
  return { x: Math.max(1, opts.width), y: Math.max(1, opts.height) }; // pixels of the sent image
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function toNormBox(raw: RawBox, scale: { x: number; y: number }): NormBox | null {
  const xs = [clamp01(raw[0] / scale.x), clamp01(raw[2] / scale.x)].sort((a, b) => a - b) as [number, number];
  const ys = [clamp01(raw[1] / scale.y), clamp01(raw[3] / scale.y)].sort((a, b) => a - b) as [number, number];
  if (xs[1] - xs[0] < 0.005 || ys[1] - ys[0] < 0.005) return null;
  return { x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1] };
}

/** Equal rows in the top part of the image for items that came without a usable box. */
export function stackedBoxes(count: number): NormBox[] {
  const top = 0.02;
  const height = 0.5;
  const row = height / Math.max(1, count);
  return Array.from({ length: count }, (_, i) => ({
    x1: 0.05,
    y1: top + i * row,
    x2: 0.95,
    y2: top + (i + 1) * row - 0.005,
  }));
}

/** The text of an answer that is not JSON: fences and a leading label removed. */
function plainText(raw: string): string {
  return stripFence(raw)
    .replace(/^\s*(?:translation|translated text|译文)\s*[:：]\s*/i, "")
    .trim();
}

export function parseModelOutput(raw: string, opts: ParseOptions): ParseResult {
  const regions = opts.regions && opts.regions.length > 0 ? opts.regions : undefined;

  let items = itemsFrom(extractJson(raw));
  if (!items) {
    const salvaged = salvageObjects(stripFence(raw)).filter((o) => firstString(o, TRANSLATION_KEYS) !== undefined);
    if (salvaged.length > 0) items = salvaged;
  }

  if (!items) {
    // Not JSON at all: show the whole answer as one translation.
    const text = plainText(raw);
    if (!text) return { units: [], degraded: false };
    if (regions) {
      return { units: regions.map((box, i) => ({ box, source: "", translation: i === 0 ? text : "" })), degraded: true };
    }
    return { units: [{ box: FALLBACK_BOX, source: "", translation: text }], degraded: true };
  }

  const entries = items
    .map((item) => ({
      source: firstString(item, SOURCE_KEYS) ?? "",
      translation: firstString(item, TRANSLATION_KEYS) ?? "",
      rawBox: readBox(item),
    }))
    .filter((e) => e.translation.length > 0 || regions !== undefined);

  if (regions) {
    // The user's regions decide the boxes; the model's answer only supplies the text, by position.
    return {
      units: regions.map((box, i) => ({ box, source: entries[i]?.source ?? "", translation: entries[i]?.translation ?? "" })),
      degraded: false,
    };
  }

  const rawBoxes = entries.map((e) => e.rawBox).filter((b): b is RawBox => b !== null);
  const scale = scaleFor(rawBoxes, opts);
  const placed = entries.map((e) => ({ ...e, box: e.rawBox ? toNormBox(e.rawBox, scale) : null }));
  const missing = placed.filter((e) => e.box === null).length;
  const fallbackBoxes = stackedBoxes(missing);
  let next = 0;
  const units = placed.map((e) => ({ box: e.box ?? fallbackBoxes[next++]!, source: e.source, translation: e.translation }));
  return { units, degraded: missing > 0 };
}
