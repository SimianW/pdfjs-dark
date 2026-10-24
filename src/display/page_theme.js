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
  // Paper/text endpoints are approximately #1b1b1f / #e3e3e3. Colored
  // strokes need a lightness floor to stay legible on the dark paper.
  L = Math.max(0.226 + 0.691 * (1 - L), 0.68 * Math.min(chroma / 0.08, 1));
  if (chroma < 0.002) {
    labB -= 0.008 * (1 - (L - 0.226) / 0.691);
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

export {
  darkenColor,
  darkenRGB,
  isDocumentImage,
  rgbToOKLab,
  transformDocumentImage,
};
