// Brightness histogram of an RGBA pixel buffer (canvas ImageData.data).

export interface Histogram {
  r: number[];
  g: number[];
  b: number[];
  l: number[];
}

/** Counts of pixels per bin for each channel and for luminance (0.2126 R + 0.7152 G + 0.0722 B); alpha is ignored. */
export function histogram(rgba: ArrayLike<number>, bins = 64): Histogram {
  const out: Histogram = { r: new Array(bins).fill(0), g: new Array(bins).fill(0), b: new Array(bins).fill(0), l: new Array(bins).fill(0) };
  const bin = (v: number) => Math.min(bins - 1, Math.floor((v / 256) * bins));
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    out.r[bin(r)]++;
    out.g[bin(g)]++;
    out.b[bin(b)]++;
    out.l[bin(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
  }
  return out;
}
