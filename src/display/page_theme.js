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

import { MathClamp } from "../shared/math_clamp.js";

const colorCache = new Map();
const cssCache = new Map();
const linear = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function rgbToOKLab(r, g, b) {
  r = linear[r];
  g = linear[g];
  b = linear[b];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const PAPER_L = 0.226,
  INK_L = 0.917;
// Knots [inverted lightness, lightness of a saturated color], strictly
// increasing so that shades stay distinct and ordered. Light fills (yellow,
// cyan, pastels) are lifted off the paper so that their hue shows, but kept
// dark enough for inverted ink on them to keep >= 4.5:1. Past the knee, darker
// originals (red, blue, green text and lines) are lifted for legibility.
const CHROMA_CURVE = [
  [PAPER_L, 0.4],
  [0.39, 0.46],
  [0.45, 0.62],
  [INK_L, INK_L],
];

function chromaticLightness(L) {
  let i = 1;
  while (i < CHROMA_CURVE.length - 1 && L > CHROMA_CURVE[i][0]) {
    i++;
  }
  const [x0, y0] = CHROMA_CURVE[i - 1],
    [x1, y1] = CHROMA_CURVE[i];
  return y0 + ((y1 - y0) * (L - x0)) / (x1 - x0);
}

/** Invert perceptual lightness, retaining OKLCH hue, not RGB complements. */
function darkenRGB(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  const cached = colorCache.get(key);
  if (cached) {
    return cached;
  }
  const lab = rgbToOKLab(r, g, b);
  let [L, , labB] = lab;
  const a = lab[1];
  const chroma = Math.hypot(a, labB);
  // Paper/text endpoints are approximately #1b1b1f / #e3e3e3.
  L = PAPER_L + (INK_L - PAPER_L) * (1 - L);
  L += Math.min(chroma / 0.08, 1) * (chromaticLightness(L) - L);
  if (chroma < 0.002) {
    labB -= 0.008 * (1 - (L - PAPER_L) / (INK_L - PAPER_L));
  }
  // Gamut mapping reduces chroma along a constant-hue ray, rather than
  // independently clipping channels (which rotates saturated blues/purples).
  let low = 0,
    high = 1;
  let rgb = labToLinear(L, a, labB);
  if (rgb.some(c => c < 0 || c > 1)) {
    for (let i = 0; i < 10; i++) {
      const mid = (low + high) / 2;
      const candidate = labToLinear(L, a * mid, labB * mid);
      if (candidate.every(c => c >= 0 && c <= 1)) {
        low = mid;
      } else {
        high = mid;
      }
    }
    rgb = labToLinear(L, a * low, labB * low);
  }
  const result = rgb.map(c => {
    c = MathClamp(c, 0, 1);
    return Math.round(
      255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
    );
  });
  // Bounded across documents; no cache entry per pixel of a photograph.
  if (colorCache.size >= 8192) {
    colorCache.clear();
  }
  colorCache.set(key, result);
  return result;
}

function darkenColor(color) {
  if (color === "transparent") {
    return color;
  }
  // Worker-generated vector colors and gradient stops are canonical #rrggbb.
  if (!/^#[\da-f]{6}$/i.test(color)) {
    return color;
  }
  const cached = cssCache.get(color);
  if (cached) {
    return cached;
  }
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = darkenRGB(n >> 16, (n >> 8) & 255, n & 255);
  const result = `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  if (cssCache.size >= 4096) {
    cssCache.clear();
  }
  cssCache.set(color, result);
  return result;
}

// Inverting lightness swaps darkening and lightening blends: multiply over
// white paper tints like screen over dark paper (e.g. text highlights).
const DARK_BLEND_MODES = new Map([
  ["multiply", "screen"],
  ["screen", "multiply"],
  ["darken", "lighten"],
  ["lighten", "darken"],
  ["color-burn", "color-dodge"],
  ["color-dodge", "color-burn"],
]);

function darkBlendMode(mode) {
  return DARK_BLEND_MODES.get(mode) ?? mode;
}

/** Bounded, evenly spaced sample; transparent pixels aren't paper. */
function isDocumentImage({ data, width, height }) {
  const pixels = width * height;
  const step = Math.max(1, Math.floor(pixels / 4096));
  let count = 0,
    paper = 0,
    neutral = 0,
    colorful = 0,
    transparent = 0,
    ink = 0;
  for (let p = 0; p < pixels; p += step) {
    const i = p * 4;
    if (data[i + 3] < 128) {
      transparent++;
      continue;
    }
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    count++;
    if (max - min < 30) {
      neutral++;
      if (min > 205) {
        paper++;
      } else if (max < 65) {
        ink++;
      }
    } else if (max - min > 55) {
      colorful++;
    }
  }
  // A white background plus sparse colored labels/plots is still a document.
  // A gray photograph has many midtones, but little near-white paper.
  return (
    count > 0 &&
    ((paper / count > 0.42 &&
      neutral / count > 0.78 &&
      colorful / count < 0.18) ||
      // Equations/icons can use transparent paper and near-black ink.
      (transparent > count * 0.1 &&
        neutral / count > 0.98 &&
        ink / count > 0.6))
  );
}

let imageLUT, grayLUT;
function transformDocumentImage({ data }) {
  // Trilinear interpolation in a small 17^3 LUT: avoid OKLab cube roots and
  // gamut searches per scan pixel, without quantization bands in gradients.
  if (!imageLUT) {
    grayLUT = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      grayLUT.set(darkenRGB(i, i, i), i * 3);
    }
    imageLUT = new Uint8Array(17 * 17 * 17 * 3);
    for (let r = 0; r <= 16; r++) {
      for (let g = 0; g <= 16; g++) {
        for (let b = 0; b <= 16; b++) {
          imageLUT.set(
            darkenRGB(
              Math.round((r * 255) / 16),
              Math.round((g * 255) / 16),
              Math.round((b * 255) / 16)
            ),
            ((r * 17 + g) * 17 + b) * 3
          );
        }
      }
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) {
      continue;
    }
    if (data[i] === data[i + 1] && data[i] === data[i + 2]) {
      const j = data[i] * 3;
      data[i] = grayLUT[j];
      data[i + 1] = grayLUT[j + 1];
      data[i + 2] = grayLUT[j + 2];
      continue;
    }
    const r = (data[i] * 16) / 255,
      g = (data[i + 1] * 16) / 255,
      b = (data[i + 2] * 16) / 255;
    const ri = Math.min(15, Math.floor(r)),
      gi = Math.min(15, Math.floor(g)),
      bi = Math.min(15, Math.floor(b));
    const rf = r - ri,
      gf = g - gi,
      bf = b - bi;
    const base = ((ri * 17 + gi) * 17 + bi) * 3;
    const w000 = (1 - rf) * (1 - gf) * (1 - bf),
      w001 = (1 - rf) * (1 - gf) * bf,
      w010 = (1 - rf) * gf * (1 - bf),
      w011 = (1 - rf) * gf * bf,
      w100 = rf * (1 - gf) * (1 - bf),
      w101 = rf * (1 - gf) * bf,
      w110 = rf * gf * (1 - bf),
      w111 = rf * gf * bf;
    for (let c = 0; c < 3; c++) {
      const j = base + c;
      data[i + c] = Math.round(
        imageLUT[j] * w000 +
          imageLUT[j + 3] * w001 +
          imageLUT[j + 51] * w010 +
          imageLUT[j + 54] * w011 +
          imageLUT[j + 867] * w100 +
          imageLUT[j + 870] * w101 +
          imageLUT[j + 918] * w110 +
          imageLUT[j + 921] * w111
      );
    }
  }
}

/**
 * Classification and recolored canvases of document images, shared by every
 * render of the same image object: zoom steps, detail views and thumbnails.
 * Keys are the page/common image objects, so entries go away with page
 * cleanup; the canvases are also bounded in total area, least recently used
 * first.
 */
class ThemeImageCache {
  static MAX_PIXELS = 2 ** 25; // 128 MiB of RGBA.

  #kinds = new WeakMap();

  #images = new WeakMap();

  #lru = new Set();

  #pixels = 0;

  // Release canvases once their image is collected, not only on eviction.
  #registry = new FinalizationRegistry(entry => this.#release(entry));

  getKind(key) {
    return this.#kinds.get(key);
  }

  setKind(key, isDocument) {
    this.#kinds.set(key, isDocument);
  }

  get(key) {
    const entry = this.#images.get(key);
    if (!entry) {
      return null;
    }
    this.#lru.delete(entry);
    this.#lru.add(entry);
    return entry.canvasEntry.canvas;
  }

  /** Takes ownership of `canvasEntry` and returns true, if it fits. */
  set(key, canvasEntry, canvasFactory) {
    const { width, height } = canvasEntry.canvas;
    const pixels = width * height;
    if (pixels > ThemeImageCache.MAX_PIXELS / 2) {
      return false;
    }
    for (const entry of this.#lru) {
      if (this.#pixels + pixels <= ThemeImageCache.MAX_PIXELS) {
        break;
      }
      this.#release(entry);
    }
    const entry = { canvasEntry, canvasFactory, pixels, key: new WeakRef(key) };
    this.#images.set(key, entry);
    this.#lru.add(entry);
    this.#pixels += pixels;
    this.#registry.register(key, entry, entry);
    return true;
  }

  #release(entry) {
    if (!this.#lru.delete(entry)) {
      return;
    }
    this.#pixels -= entry.pixels;
    this.#registry.unregister(entry);
    const key = entry.key.deref();
    if (key) {
      this.#images.delete(key);
    }
    entry.canvasFactory.destroy(entry.canvasEntry);
  }

  /** The appearance changed (e.g. a light render): free all canvases. */
  clear() {
    for (const entry of this.#lru) {
      this.#release(entry);
    }
  }
}

const themeImageCache = new ThemeImageCache();

export {
  darkBlendMode,
  darkenColor,
  darkenRGB,
  isDocumentImage,
  rgbToOKLab,
  ThemeImageCache,
  themeImageCache,
  transformDocumentImage,
};
