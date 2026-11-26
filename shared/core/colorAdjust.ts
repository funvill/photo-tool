// Light and colour (brightness, contrast, saturation, warmth) as one pure model. The four sliders become
// one 3 x 3 colour matrix plus an offset (`colorMatrix`). The page draws it with an SVG feColorMatrix
// (in sRGB), and the server applies the same numbers with sharp's `recomb` and `linear`, so the saved
// photo matches the preview. CSS filters such as brightness() are not used: their maths differs from sharp's.
// No DOM, no sharp, no Electron here.

export interface Adjust {
  /** Each from -100 to 100; 0 changes nothing. */
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
}

export const NO_ADJUST: Adjust = Object.freeze({ brightness: 0, contrast: 0, saturation: 0, warmth: 0 });

export const ADJUST_KEYS = ['brightness', 'contrast', 'saturation', 'warmth'] as const;

/** A colour change on 0..1 sRGB values: out = m · in + offset, `m` row-major (r, g, b rows). */
export interface ColorMatrix {
  m: number[];
  offset: number[];
}

/** Rec. 709 luma weights. */
const LUMA = [0.2126, 0.7152, 0.0722];
const MAX = 100;
/** Brightness +100 adds this much (of the full range) to every channel. */
const BRIGHTNESS_RANGE = 0.4;
/** Warmth +100 raises red and lowers blue by this much. */
const WARMTH_RANGE = 0.15;
/** Auto moves each slider at most this far. */
const AUTO_MAX = 60;
/** What Auto aims for, in 0..255 levels: the overall mean, and the spread (standard deviation) of luma. */
const AUTO_MEAN = 118;
const AUTO_SPREAD = 55;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** True when the adjustment changes nothing (undefined counts as none). */
export function isNoAdjust(a: Adjust | undefined): boolean {
  return !a || ADJUST_KEYS.every((k) => a[k] === 0);
}

/** Reads an adjustment from stored JSON: missing or not an object is none; a field that is not a number is 0; values are clamped. */
export function parseAdjust(raw: unknown): Adjust {
  if (!raw || typeof raw !== 'object') return NO_ADJUST;
  const r = raw as Record<string, unknown>;
  const out = { ...NO_ADJUST };
  for (const k of ADJUST_KEYS) out[k] = isNum(r[k]) ? clamp(r[k], -MAX, MAX) : 0;
  return isNoAdjust(out) ? NO_ADJUST : out;
}

/**
 * The colour matrix for an adjustment. In this order, on sRGB values 0..1: brightness (an offset of
 * brightness / 100 × 0.4), contrast (a scale about 0.5 by 1 + contrast / 100, never below 0), saturation
 * (a lerp from the Rec. 709 luma matrix by 1 + saturation / 100), warmth (red × 1 + w × 0.15, blue ×
 * 1 − w × 0.15, w = warmth / 100).
 */
export function colorMatrix(a: Adjust): ColorMatrix {
  const b = (a.brightness / MAX) * BRIGHTNESS_RANGE;
  const c = Math.max(0, 1 + a.contrast / MAX);
  const s = 1 + a.saturation / MAX;
  const w = a.warmth / MAX;
  const warm = [1 + w * WARMTH_RANGE, 1, 1 - w * WARMTH_RANGE];
  const m: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      // Saturation: (1 - s) · luma row + s · identity, then contrast's scale, then warmth's row scale.
      const sat = (1 - s) * LUMA[col] + (r === col ? s : 0);
      m.push(warm[r] * sat * c);
    }
  }
  // Brightness and contrast give the same offset k on every channel; saturation keeps a grey grey; warmth scales it.
  const k = c * b + 0.5 * (1 - c);
  const tidy = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return { m: m.map(tidy), offset: warm.map((x) => tidy(x * k)) };
}

/** A 0..255 colour through the matrix, rounded and clamped, as the page's filter and the saved file both draw it. */
export function applyMatrix(rgb: readonly [number, number, number] | readonly number[], cm: ColorMatrix): [number, number, number] {
  const v = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  const out = [0, 1, 2].map((r) => cm.m[r * 3] * v[0] + cm.m[r * 3 + 1] * v[1] + cm.m[r * 3 + 2] * v[2] + cm.offset[r]);
  return out.map((x) => clamp(Math.round(x * 255), 0, 255)) as [number, number, number];
}

/** The `values` of an SVG feColorMatrix (type "matrix"): 4 rows of 5, alpha left alone. */
export function svgMatrixValues(cm: ColorMatrix): string {
  const n = (v: number) => String(Math.round(v * 1e6) / 1e6);
  const { m, offset: o } = cm;
  return [m[0], m[1], m[2], 0, o[0], m[3], m[4], m[5], 0, o[1], m[6], m[7], m[8], 0, o[2], 0, 0, 0, 1, 0].map(n).join(' ');
}

/** sharp's `stats()` channels (0..255): each channel's mean and standard deviation. */
export interface ColorStats {
  mean: [number, number, number];
  stdev: [number, number, number];
}

/**
 * Auto: the four sliders from the photo's own statistics. Brightness moves the overall (luma) mean toward
 * 118, contrast moves the luma spread toward 55, warmth evens out red and blue (grey world); saturation
 * stays. Each is a whole number, at most ±60, so Auto stays gentle and can be adjusted after.
 */
export function autoAdjust(stats: ColorStats): Adjust {
  const [r, g, b] = stats.mean.map((v) => (isNum(v) ? v : 0));
  const sd = stats.stdev.map((v) => (isNum(v) ? Math.max(0, v) : 0));
  const meanL = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  const spread = LUMA[0] * sd[0] + LUMA[1] * sd[1] + LUMA[2] * sd[2];
  const limit = (v: number) => {
    const x = Math.round(clamp(v, -AUTO_MAX, AUTO_MAX));
    return x === 0 ? 0 : x; // no "-0"
  };
  // Brightness: one step is BRIGHTNESS_RANGE × 255 / 100 levels.
  const brightness = limit((AUTO_MEAN - meanL) / ((BRIGHTNESS_RANGE * 255) / MAX));
  // Contrast: scale the spread to the target (a flat photo, spread near 0, gets the most Auto gives).
  const contrast = limit((AUTO_SPREAD / Math.max(spread, 1) - 1) * MAX);
  // Warmth: red × (1 + 0.15 w) = blue × (1 − 0.15 w).
  const warmth = r + b < 1 ? 0 : limit(((b - r) / (WARMTH_RANGE * (r + b))) * MAX);
  return { brightness, contrast, saturation: 0, warmth };
}
