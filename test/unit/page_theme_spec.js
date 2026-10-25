/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  darkBlendMode,
  darkenColor,
  darkenRGB,
  isDocumentImage,
  rgbToOKLab,
  ThemeImageCache,
  transformDocumentImage,
} from "../../src/display/page_theme.js";
import { CanvasGraphics } from "../../src/display/canvas.js";
import { DOMCanvasFactory } from "../../src/display/canvas_factory.js";
import { getShadingPattern } from "../../src/display/pattern_helper.js";
import { isNodeJS } from "../../src/shared/util.js";
import { NodeCanvasFactory } from "../../src/display/node_utils.js";

function image(pixels) {
  return {
    data: Uint8ClampedArray.from(pixels.flat()),
    width: pixels.length,
    height: 1,
  };
}

function luminance(color) {
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(c => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio. */
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function hexToRGB(color) {
  const n = parseInt(color.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function createFactory() {
  const Factory = isNodeJS ? NodeCanvasFactory : DOMCanvasFactory;
  return new Factory({});
}

describe("page theme", function () {
  it("maps paper and ink to soft dark/light endpoints", function () {
    const white = darkenRGB(255, 255, 255);
    const black = darkenRGB(0, 0, 0);
    white.forEach(c => expect(c).toBeGreaterThanOrEqual(25));
    white.forEach(c => expect(c).toBeLessThanOrEqual(35));
    black.forEach(c => expect(c).toBeGreaterThanOrEqual(225));
    black.forEach(c => expect(c).toBeLessThanOrEqual(230));
    expect(darkenColor("transparent")).toEqual("transparent");
    expect(darkenColor("#000000")).toEqual("#e3e3e3");
  });

  it("preserves saturated OKLCH hues", function () {
    for (const color of [
      [255, 0, 0],
      [0, 0, 255],
      [0, 160, 0],
      [220, 0, 180],
      [255, 170, 0],
      [255, 255, 0],
      [0, 255, 255],
    ]) {
      const [, a, b] = rgbToOKLab(...color);
      const [, da, db] = rgbToOKLab(...darkenRGB(...color));
      const delta = Math.atan2(
        Math.sin(Math.atan2(b, a) - Math.atan2(db, da)),
        Math.cos(Math.atan2(b, a) - Math.atan2(db, da))
      );
      expect(Math.abs(delta)).toBeLessThan(0.035);
    }
  });

  it("keeps colored text and lines legible on the dark paper", function () {
    const paper = darkenColor("#ffffff");
    for (const color of [
      "#ff0000",
      "#c80000",
      "#0000ff",
      "#000080",
      "#00a000",
      "#dc00b4",
      "#0563c1",
      "#7030a0",
    ]) {
      const dark = darkenColor(color);
      expect(contrast(dark, paper)).toBeGreaterThanOrEqual(4.5);
      const [, a, b] = rgbToOKLab(...darkenRGB(...hexToRGB(color)));
      expect(Math.hypot(a, b)).toBeGreaterThan(0.07);
    }
  });

  it("keeps inverted ink legible on light saturated fills", function () {
    const paper = darkenColor("#ffffff"),
      ink = darkenColor("#000000");
    for (const fill of [
      "#ffff00",
      "#ffff99",
      "#00ffff",
      "#ffc800",
      "#ffaa00",
      "#ccffcc",
      "#99ccff",
      "#ff9999",
      "#90ee90",
    ]) {
      const dark = darkenColor(fill);
      expect(contrast(ink, dark)).toBeGreaterThanOrEqual(4.5);
      // The fill must remain visibly distinct from the paper.
      expect(contrast(dark, paper)).toBeGreaterThan(1.8);
    }
    // Yellow text on a black slide stays legible, too.
    expect(contrast(darkenColor("#ffff00"), ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps distinct shades of a hue distinct and in lightness order", function () {
    for (const shades of [
      ["#ff0000", "#e00000", "#c80000", "#800000"],
      ["#0000ff", "#0000c8"],
      ["#ffff00", "#c8c800"],
      ["#00ff00", "#00c800"],
      ["#00ffff", "#00c8c8"],
    ]) {
      const dark = shades.map(darkenColor);
      expect(new Set(dark).size).toEqual(shades.length);
      for (let i = 1; i < dark.length; i++) {
        // Darker originals become lighter, by more than a just noticeable
        // difference (they used to merge, e.g. all three reds into #ff5544).
        expect(luminance(dark[i])).toBeGreaterThan(luminance(dark[i - 1]));
        const [L0, a0, b0] = rgbToOKLab(...hexToRGB(dark[i - 1]));
        const [L1, a1, b1] = rgbToOKLab(...hexToRGB(dark[i]));
        expect(Math.hypot(L1 - L0, a1 - a0, b1 - b0)).toBeGreaterThan(0.02);
      }
    }
    for (const hue of [
      [255, 0, 0],
      [0, 0, 255],
      [0, 255, 0],
      [255, 255, 0],
      [0, 255, 255],
      [255, 0, 255],
      [255, 128, 0],
    ]) {
      let previous = -1;
      for (let k = 255; k >= 20; k -= 5) {
        const rgb = darkenRGB(...hue.map(c => Math.round((c * k) / 255)));
        const y = luminance(
          `#${rgb.map(c => c.toString(16).padStart(2, "0")).join("")}`
        );
        expect(y).toBeGreaterThan(previous);
        previous = y;
      }
    }
  });

  it("turns multiply highlights into screen blends on dark pages only", function () {
    expect(darkBlendMode("multiply")).toEqual("screen");
    expect(darkBlendMode("darken")).toEqual("lighten");
    expect(darkBlendMode("source-over")).toEqual("source-over");
    expect(darkBlendMode("hard-light")).toEqual("hard-light");

    const factory = createFactory();
    const highlight = pageColors => {
      const entry = factory.create(4, 4);
      const { context } = entry;
      const graphics = new CanvasGraphics(
        context,
        null,
        null,
        factory,
        null,
        {},
        null,
        pageColors
      );
      const paper = graphics.themeColor("#ffffff");
      context.fillStyle = paper;
      context.fillRect(0, 0, 4, 4);
      // As in a /BM /Multiply highlight annotation appearance.
      graphics.setGState(0, [["BM", "multiply"]]);
      const mode = context.globalCompositeOperation;
      graphics.setFillRGBColor(0, "#ffff00");
      context.fillRect(0, 0, 4, 4);
      const [r, g, b] = context.getImageData(1, 1, 1, 1).data;
      factory.destroy(entry);
      return {
        mode,
        paper,
        band: `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`,
      };
    };
    const light = highlight(null);
    expect(light.mode).toEqual("multiply");
    expect(light.band).toEqual("#ffff00");

    const dark = highlight({ dark: true });
    expect(dark.mode).toEqual("screen");
    // A multiply band used to be #101100 on #1a1c20 paper, i.e. 1.12:1.
    expect(contrast(dark.band, dark.paper)).toBeGreaterThan(2);
    expect(contrast(darkenColor("#000000"), dark.band)).toBeGreaterThan(4.5);
  });

  it("keeps the document's blend mode for photographs only", function () {
    const factory = createFactory();
    const target = factory.create(1, 1);
    const graphics = new CanvasGraphics(
      target.context,
      null,
      null,
      factory,
      null,
      {},
      null,
      { dark: true }
    );
    graphics.setGState(0, [["BM", "multiply"]]);
    const photo = factory.create(16, 16);
    for (let x = 0; x < 16; x++) {
      photo.context.fillStyle = `hsl(${x * 22} 80% 50%)`;
      photo.context.fillRect(x, 0, 1, 16);
    }
    graphics.themeImage(photo.canvas, null, { width: 16, height: 16 });
    // Not recolored, so it blends as authored.
    expect(target.context.globalCompositeOperation).toEqual("multiply");

    graphics.setGState(0, [["BM", "multiply"]]);
    const scan = factory.create(16, 16);
    scan.context.fillStyle = "#ffffff";
    scan.context.fillRect(0, 0, 16, 16);
    const { canvasEntry } = graphics.themeImage(scan.canvas, null, {
      width: 16,
      height: 16,
    });
    expect(target.context.globalCompositeOperation).toEqual("screen");
    if (canvasEntry) {
      factory.destroy(canvasEntry);
    }
    factory.destroy(scan);
    factory.destroy(photo);
    factory.destroy(target);
  });

  it("produces finite integer sRGB values throughout the gamut", function () {
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          for (const c of darkenRGB(r, g, b)) {
            expect(Number.isInteger(c)).toBeTrue();
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(255);
          }
        }
      }
    }
  });

  it("recognizes scans, line art and colored plots on paper", function () {
    const pixels = Array.from({ length: 100 }, (_, i) =>
      i < 80 ? [245, 242, 240, 255] : [20, 20, 20, 255]
    );
    expect(isDocumentImage(image(pixels))).toBeTrue();
    pixels.fill([0, 0, 255, 255], 90);
    expect(isDocumentImage(image(pixels))).toBeTrue();
    expect(isDocumentImage(image([[255, 255, 255, 255]]))).toBeTrue();
  });

  it("leaves colorful and grayscale photographs and transparent images alone", function () {
    expect(
      isDocumentImage(
        image(Array.from({ length: 256 }, (_, i) => [i, i, i, 255]))
      )
    ).toBeFalse();
    expect(
      isDocumentImage(
        image(Array.from({ length: 256 }, (_, i) => [i, 100, 200, 255]))
      )
    ).toBeFalse();
    expect(isDocumentImage(image([[255, 255, 255, 0]]))).toBeFalse();
  });

  it("recognizes transparent equations but not arbitrary transparent art", function () {
    expect(
      isDocumentImage(
        image([
          [0, 0, 0, 255],
          [255, 255, 255, 0],
        ])
      )
    ).toBeTrue();
    expect(
      isDocumentImage(
        image([
          [255, 0, 0, 255],
          [255, 255, 255, 0],
        ])
      )
    ).toBeFalse();
  });

  it("transforms drawing styles but not stored source colors or mask data", function () {
    const ctx = { canvas: { width: 100, height: 100 } };
    const graphics = new CanvasGraphics(ctx, null, null, null, null, {}, null, {
      dark: true,
    });
    graphics.setFillRGBColor(0, "#000000");
    expect(ctx.fillStyle).toEqual("#e3e3e3");
    expect(graphics.current.fillColor).toEqual("#000000");
    graphics.setStrokeRGBColor(0, "#0000ff");
    expect(ctx.strokeStyle).toEqual(darkenColor("#0000ff"));
    graphics.themeMaskDepth++;
    graphics.setFillRGBColor(0, "#ffffff");
    expect(ctx.fillStyle).toEqual("#ffffff");
    graphics.themeMaskDepth--;
    graphics.pageColors = { background: "Canvas", foreground: "CanvasText" };
    graphics.setFillRGBColor(0, "#000000");
    expect(ctx.fillStyle).toEqual("#000000");
  });

  it("colors image stencils exactly once, using the transformed fill style", function () {
    const factory = createFactory();
    const entry = factory.create(20, 20);
    const { context } = entry;
    const graphics = new CanvasGraphics(
      context,
      null,
      null,
      factory,
      null,
      {},
      null,
      { dark: true }
    );
    graphics.setFillRGBColor(0, "#000000");
    context.scale(20, 20);
    const mask = graphics._createMaskCanvas(0, {
      width: 1,
      height: 1,
      data: new Uint8Array([0]),
      count: 1,
    });
    const pixel = mask.canvas.getContext("2d").getImageData(10, 10, 1, 1).data;
    expect(Array.from(pixel)).toEqual([227, 227, 227, 255]);
    factory.destroy(mask.canvasEntry);
    graphics.paintImageMaskXObjectGroup(0, [
      {
        width: 1,
        height: 1,
        data: new Uint8Array([0]),
        transform: [1, 0, 0, 1, 0, 0],
      },
    ]);
    expect(Array.from(context.getImageData(10, 10, 1, 1).data)).toEqual([
      227, 227, 227, 255,
    ]);
    factory.destroy(entry);
  });

  it("transforms gradient stops and mesh vertices without mutating worker data", function () {
    const stops = [
      [0, "#ffffff"],
      [1, "#0000ff"],
    ];
    const ir = ["RadialAxial", "axial", null, stops, [0, 0], [10, 10], 0, 0];
    const dark = getShadingPattern(ir, true);
    expect(dark._colorStops).toEqual([
      [0, darkenColor("#ffffff")],
      [1, darkenColor("#0000ff")],
    ]);
    expect(getShadingPattern(ir)._colorStops).toBe(stops);
    expect(stops[0][1]).toEqual("#ffffff");
    const vertices = new Uint8Array([0, 0, 255, 255, 255, 255, 255, 255]);
    const meshIR = [
      "Mesh",
      null,
      new Float32Array(),
      vertices,
      0,
      [0, 0, 1, 1],
      null,
      [255, 255, 255],
    ];
    const mesh = getShadingPattern(meshIR, true);
    expect(Array.from(mesh._colData.slice(0, 3))).toEqual(darkenRGB(0, 0, 255));
    expect(vertices[0]).toEqual(0);
    expect(mesh._background).toEqual(darkenRGB(255, 255, 255));
  });

  it("recolors a document image once, across renders", function () {
    const factory = createFactory();
    const source = factory.create(32, 32);
    source.context.fillStyle = "#ffffff";
    source.context.fillRect(0, 0, 32, 32);
    source.context.fillStyle = "#000000";
    source.context.fillRect(0, 0, 32, 4);
    const imgData = { width: 32, height: 32 };
    const render = (transfer = false) => {
      const graphics = new CanvasGraphics(
        factory.create(1, 1).context,
        null,
        null,
        factory,
        null,
        {},
        null,
        { dark: true }
      );
      if (transfer) {
        graphics.current.transferMapsFallback = {};
      }
      return graphics.themeImage(source.canvas, null, imgData);
    };
    const first = render();
    expect(first.img).not.toBe(source.canvas);
    // The cache owns the recolored canvas; callers must not destroy it.
    expect(first.canvasEntry).toBeNull();
    const pixel = first.img.getContext("2d").getImageData(1, 20, 1, 1).data;
    expect(Array.from(pixel.slice(0, 3))).toEqual(darkenRGB(255, 255, 255));
    expect(render().img).toBe(first.img);
    // Transfer functions change the pixels, so they bypass the shared cache.
    const transferred = render(true);
    expect(transferred.img).not.toBe(first.img);
    expect(transferred.canvasEntry).not.toBeNull();
    factory.destroy(transferred.canvasEntry);
    factory.destroy(source);
  });

  it("bounds recolored image memory, evicting least recently used", function () {
    const destroyed = [];
    const factory = { destroy: entry => destroyed.push(entry) };
    const canvas = side => ({ canvas: { width: side, height: side } });
    const cache = new ThemeImageCache();
    const side = Math.floor(Math.sqrt(ThemeImageCache.MAX_PIXELS / 3));
    const [a, b, c] = [{}, {}, {}];
    const [ca, cb, cc] = [canvas(side), canvas(side), canvas(side)];
    expect(cache.set(a, ca, factory)).toBeTrue();
    expect(cache.set(b, cb, factory)).toBeTrue();
    expect(cache.set(c, cc, factory)).toBeTrue();
    expect(cache.get(a)).toBe(ca.canvas);
    expect(destroyed).toEqual([]);
    expect(cache.set({}, canvas(Math.ceil(side * 1.2)), factory)).toBeTrue();
    // b and then c were least recently used, a was read in between.
    expect(destroyed).toEqual([cb, cc]);
    expect(cache.get(b)).toBeNull();
    expect(cache.get(a)).toBe(ca.canvas);
    // A single image larger than half the budget isn't kept at all.
    expect(cache.set({}, canvas(side * 2), factory)).toBeFalse();
    cache.clear();
    expect(cache.get(a)).toBeNull();
    expect(destroyed.length).toEqual(4);
  });

  it("transforms scan pixels, retaining hue and alpha without mutating alpha", function () {
    const scan = image([
      [255, 255, 255, 255],
      [0, 0, 0, 128],
      [0, 0, 255, 255],
      [19, 29, 39, 0],
    ]);
    transformDocumentImage(scan);
    expect(Array.from(scan.data.slice(0, 3))).toEqual(darkenRGB(255, 255, 255));
    expect(Array.from(scan.data.slice(4, 7))).toEqual(darkenRGB(0, 0, 0));
    expect(scan.data[10]).toBeGreaterThan(scan.data[8]);
    expect(scan.data[7]).toEqual(128);
    expect(Array.from(scan.data.slice(12))).toEqual([19, 29, 39, 0]);
  });
});
