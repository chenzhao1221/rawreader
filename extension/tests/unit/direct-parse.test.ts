import { describe, expect, it } from "vitest";
import { FALLBACK_BOX, extractJson, parseModelOutput, salvageObjects, stackedBoxes } from "@/lib/direct/parse";

const size = { width: 800, height: 1200 };

const item = (box: number[], translation: string, source = "src") => ({ box, source, translation });

describe("parseModelOutput: well-formed answers", () => {
  it("reads items on the 0-1000 scale into fractions", () => {
    const raw = JSON.stringify({ items: [item([100, 200, 500, 400], "你好"), item([600, 50, 900, 150], "再见")] });
    const result = parseModelOutput(raw, size);
    expect(result.degraded).toBe(false);
    expect(result.units).toHaveLength(2);
    expect(result.units[0]).toEqual({ box: { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.4 }, source: "src", translation: "你好" });
    expect(result.units[1]!.box.x1).toBeCloseTo(0.6);
  });

  it("accepts a bare array, a markdown fence and chatter around the JSON", () => {
    const arr = JSON.stringify([item([0, 0, 500, 500], "A")]);
    expect(parseModelOutput(arr, size).units[0]!.translation).toBe("A");
    expect(parseModelOutput("```json\n" + arr + "\n```", size).units[0]!.translation).toBe("A");
    expect(parseModelOutput("Here you go:\n" + JSON.stringify({ items: JSON.parse(arr) }) + "\nHope it helps", size).units[0]!.translation).toBe("A");
  });

  it("accepts other key names and Gemini's y-first box_2d", () => {
    const raw = JSON.stringify({
      bubbles: [
        { bbox: [100, 100, 300, 300], original: "o", translated: "T1" },
        { box_2d: [500, 100, 700, 300], text: "o2", translation: "T2" },
      ],
    });
    const { units } = parseModelOutput(raw, size);
    expect(units[0]!.box).toEqual({ x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 });
    expect(units[1]!.box).toEqual({ x1: 0.1, y1: 0.5, x2: 0.3, y2: 0.7 });
    expect(units[1]!.source).toBe("o2");
  });

  it("reads pixel coordinates of the sent image when values exceed 1000", () => {
    const raw = JSON.stringify({ items: [item([80, 120, 400, 1100], "T")] });
    const { units } = parseModelOutput(raw, size);
    expect(units[0]!.box.x1).toBeCloseTo(0.1);
    expect(units[0]!.box.y1).toBeCloseTo(0.1);
    expect(units[0]!.box.x2).toBeCloseTo(0.5);
    expect(units[0]!.box.y2).toBeCloseTo(1100 / 1200);
    // Pixel values that stay below 1000 cannot be told from the 0-1000 scale; the prompt asks for 0-1000.
    expect(parseModelOutput(JSON.stringify({ items: [item([80, 120, 400, 600], "T")] }), size).units[0]!.box.x1).toBeCloseTo(0.08);
  });

  it("keeps fractions that are already between 0 and 1", () => {
    const raw = JSON.stringify({ items: [item([0.1, 0.2, 0.5, 0.4], "T")] });
    expect(parseModelOutput(raw, size).units[0]!.box).toEqual({ x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.4 });
  });

  it("swaps reversed corners, clamps to the image and reads numeric strings", () => {
    const raw = JSON.stringify({ items: [{ box: ["500", "400", "100", "-20"], translation: "T" }] });
    const box = parseModelOutput(raw, size).units[0]!.box;
    expect(box).toEqual({ x1: 0.1, y1: 0, x2: 0.5, y2: 0.4 });
  });

  it("returns no units for an empty list or empty translations", () => {
    expect(parseModelOutput('{"items":[]}', size)).toEqual({ units: [], degraded: false });
    expect(parseModelOutput(JSON.stringify({ items: [item([0, 0, 500, 500], "")] }), size).units).toEqual([]);
  });
});

describe("parseModelOutput: graceful degradation", () => {
  it("shows a plain-text answer as one translation in the banner box", () => {
    const result = parseModelOutput("Translation: 这是整段译文", size);
    expect(result.degraded).toBe(true);
    expect(result.units).toEqual([{ box: FALLBACK_BOX, source: "", translation: "这是整段译文" }]);
  });

  it("strips a fence around a non-JSON answer", () => {
    expect(parseModelOutput("```\n只有文字\n```", size).units[0]!.translation).toBe("只有文字");
  });

  it("places items without a usable box in stacked rows and flags the result", () => {
    const raw = JSON.stringify({ items: [item([100, 100, 400, 300], "A"), { translation: "B" }, { box: [1, 2], translation: "C" }] });
    const result = parseModelOutput(raw, size);
    expect(result.degraded).toBe(true);
    expect(result.units.map((u) => u.translation)).toEqual(["A", "B", "C"]);
    expect(result.units[0]!.box).toEqual({ x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.3 });
    const [b, c] = stackedBoxes(2);
    expect(result.units[1]!.box).toEqual(b);
    expect(result.units[2]!.box).toEqual(c);
  });

  it("drops a box with no area and stacks it", () => {
    const raw = JSON.stringify({ items: [item([100, 100, 100, 100], "A")] });
    const result = parseModelOutput(raw, size);
    expect(result.degraded).toBe(true);
    expect(result.units[0]!.box).toEqual(stackedBoxes(1)[0]);
  });

  it("recovers the complete items from a cut-off answer", () => {
    const full = '{"items":[{"box":[10,10,300,200],"source":"a","translation":"一"},{"box":[400,10,700,200],"source":"b","translation":"二"},{"box":[10,300,300,';
    const result = parseModelOutput(full, size);
    expect(result.units.map((u) => u.translation)).toEqual(["一", "二"]);
    expect(result.degraded).toBe(false);
  });

  it("returns nothing for an empty answer", () => {
    expect(parseModelOutput("   ", size)).toEqual({ units: [], degraded: false });
  });
});

describe("parseModelOutput: user regions", () => {
  const regions = [
    { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.2 },
    { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.8 },
  ];

  it("keeps the regions as boxes and takes the text by position", () => {
    const raw = JSON.stringify({ items: [item([0, 0, 10, 10], "一"), item([0, 0, 10, 10], "二")] });
    const result = parseModelOutput(raw, { ...size, regions });
    expect(result.units.map((u) => u.box)).toEqual(regions);
    expect(result.units.map((u) => u.translation)).toEqual(["一", "二"]);
  });

  it("pads missing answers with empty text so the count stays equal", () => {
    const raw = JSON.stringify({ items: [item([0, 0, 10, 10], "一")] });
    const result = parseModelOutput(raw, { ...size, regions });
    expect(result.units).toHaveLength(2);
    expect(result.units[1]!.translation).toBe("");
  });

  it("puts a plain-text answer on the first region", () => {
    const result = parseModelOutput("整段译文", { ...size, regions });
    expect(result.degraded).toBe(true);
    expect(result.units.map((u) => u.translation)).toEqual(["整段译文", ""]);
  });
});

describe("JSON helpers", () => {
  it("extractJson returns undefined when nothing parses", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("salvageObjects skips braces inside strings and the list wrapper", () => {
    const text = '{"items":[{"translation":"a } b"},{"translation":"c"},{"translation":"cut';
    expect(salvageObjects(text).map((o) => o["translation"])).toEqual(["a } b", "c"]);
  });
});
