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
  darkenColor,
  darkenRGB,
  isDocumentImage,
  rgbToOKLab,
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

  it("preserves saturated OKLCH hues while making colored strokes legible", function () {
    for (const color of [
      [255, 0, 0],
      [0, 0, 255],
      [0, 160, 0],
      [220, 0, 180],
      [255, 170, 0],
    ]) {
      const [, a, b] = rgbToOKLab(...color);
      const [L, da, db] = rgbToOKLab(...darkenRGB(...color));
      const delta = Math.atan2(
        Math.sin(Math.atan2(b, a) - Math.atan2(db, da)),
        Math.cos(Math.atan2(b, a) - Math.atan2(db, da))
      );
      expect(Math.abs(delta)).toBeLessThan(0.035);
      expect(L).toBeGreaterThan(0.67);
      expect(Math.hypot(da, db)).toBeGreaterThan(0.07);
    }
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
    const Factory = isNodeJS ? NodeCanvasFactory : DOMCanvasFactory;
    const factory = new Factory({});
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
