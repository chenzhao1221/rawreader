// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageToBase64, imageToDataUrl } from "@/lib/canvas/export";

function fakeImage(width: number, height: number): HTMLImageElement {
  const img = document.createElement("img");
  Object.defineProperty(img, "naturalWidth", { value: width });
  Object.defineProperty(img, "naturalHeight", { value: height });
  return img;
}

function stubCanvas(toDataURL: (type?: string, quality?: number) => string) {
  const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: "" };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const spy = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(toDataURL);
  return { ctx, spy };
}

afterEach(() => vi.restoreAllMocks());

describe("imageToDataUrl", () => {
  it("draws the image at its natural size and encodes JPEG at the asked quality", () => {
    const { ctx, spy } = stubCanvas(() => "data:image/jpeg;base64,AAAA");
    expect(imageToDataUrl(fakeImage(800, 1200), 0.8)).toBe("data:image/jpeg;base64,AAAA");
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 1200);
    expect(spy).toHaveBeenCalledWith("image/jpeg", 0.8);
  });

  it("throws the browser's reason when the canvas is tainted", () => {
    stubCanvas(() => {
      throw new DOMException("The canvas has been tainted by cross-origin data.", "SecurityError");
    });
    expect(() => imageToDataUrl(fakeImage(10, 10))).toThrow(/tainted/);
  });

  it("throws when the image is not loaded yet", () => {
    expect(() => imageToDataUrl(fakeImage(0, 0))).toThrow(/not loaded/);
  });
});

describe("imageToBase64", () => {
  it("keeps returning null instead of throwing", () => {
    stubCanvas(() => {
      throw new Error("tainted");
    });
    expect(imageToBase64(fakeImage(10, 10))).toBeNull();
    expect(imageToBase64(fakeImage(0, 0))).toBeNull();
  });
});
