// RawReader extension: direct API mode. The instruction sent with the image (pure).
// One request does detection, reading and translation, and asks for JSON so the overlay can place the text.

/** A region in 0..1 fractions of the image width and height. */
export interface NormBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PromptContext {
  seriesName?: string | undefined;
  summary?: string | undefined;
  dictionary?: string | undefined;
}

export interface PromptInput {
  /** Language name as the extension stores it, for example "Chinese (Simplified)". */
  targetLang: string;
  /** Size of the image that is sent, in pixels. */
  width: number;
  height: number;
  context?: PromptContext | undefined;
  /** Regions the user drew or edited. The model then translates exactly these, in this order. */
  regions?: NormBox[] | undefined;
}

const MAX_CONTEXT_CHARS = 1500;

const clip = (text: string | undefined): string => (text ?? "").trim().slice(0, MAX_CONTEXT_CHARS);

/** Fraction to the integer 0-1000 scale the prompt uses. */
export const toThousand = (value: number): number => Math.max(0, Math.min(1000, Math.round(value * 1000)));

export function buildPrompt(input: PromptInput): string {
  const lines: string[] = [
    `You translate comics (manga, manhwa, webtoons). The attached image is one comic image, ${Math.round(input.width)}x${Math.round(input.height)} pixels.`,
    `Target language: ${input.targetLang}.`,
    "",
  ];

  if (input.regions && input.regions.length > 0) {
    lines.push(
      `Read and translate the text inside each of the ${input.regions.length} regions below. Return exactly ${input.regions.length} items, in the same order, and copy each region's box unchanged.`,
      "Regions (box = [x1,y1,x2,y2], integers from 0 to 1000, relative to the image width and height):",
      ...input.regions.map((r, i) => `${i + 1}. [${toThousand(r.x1)},${toThousand(r.y1)},${toThousand(r.x2)},${toThousand(r.y2)}]`),
    );
  } else {
    lines.push(
      "Find every piece of text that belongs to the story: speech bubbles, thought bubbles, captions, narration and readable sound effects. Skip watermarks, site logos, credits and page numbers.",
      "List them in reading order (manga: right to left, top to bottom; webtoon: top to bottom).",
    );
  }

  lines.push(
    "",
    "Answer with one JSON object and nothing else (no markdown fence, no comments):",
    '{"items":[{"box":[x1,y1,x2,y2],"source":"original text","translation":"translated text"}]}',
    "Rules:",
    "- box is the bounding box of the whole bubble or text block: integers from 0 to 1000, relative to the image width and height; x1,y1 is the top-left corner and x2,y2 the bottom-right corner.",
    "- translation is only the translated text. Keep it short enough to fit the bubble. No notes, no explanations, no romanization.",
    "- Do not invent text. If the image has no text, answer {\"items\":[]}.",
  );

  const context = input.context;
  const series = clip(context?.seriesName);
  const summary = clip(context?.summary);
  const dictionary = clip(context?.dictionary);
  if (series || summary || dictionary) {
    lines.push("", "Background (use it for names, tone and consistency; do not translate it):");
    if (series) lines.push(`Series: ${series}`);
    if (summary) lines.push(`Story so far: ${summary}`);
    if (dictionary) lines.push(`Glossary (source = translation):`, dictionary);
  }
  return lines.join("\n");
}

/** A tiny text-only prompt for the "test connection" button (no image, so it costs almost nothing). */
export const TEST_PROMPT = 'Reply with the single word "ok".';
