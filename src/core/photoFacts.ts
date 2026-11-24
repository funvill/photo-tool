// Facts about a photo that the gallery shows next to the picture.

/** Camera settings read from EXIF. A field is left out when the file does not say. */
export interface PhotoExif {
  lens?: string;
  /** mm */
  focalLength?: number;
  /** mm, as a 35 mm film camera would need */
  focalLength35?: number;
  /** f-number */
  aperture?: number;
  /** seconds */
  exposureTime?: number;
  iso?: number;
  /** EV; may be 0 or negative */
  exposureBias?: number;
  flash?: boolean;
}

const oneDecimal = (n: number) => n.toFixed(1).replace(/\.0$/, '');

/** 0.004 → "1/250 s", 2 → "2 s", 1.3 → "1.3 s". */
export function formatShutter(s: number): string {
  return s < 1 ? `1/${Math.round(1 / s)} s` : `${oneDecimal(s)} s`;
}

/** 2.8 → "f/2.8", 8 → "f/8". */
export function formatAperture(n: number): string {
  return `f/${oneDecimal(n)}`;
}

/** "35 mm", or with the 35 mm equivalent when it differs by 1 mm or more. */
export function formatFocal(mm: number, mm35?: number): string {
  const base = `${oneDecimal(mm)} mm`;
  return mm35 !== undefined && Math.abs(mm35 - mm) >= 1 ? `${base} (${oneDecimal(mm35)} mm in 35 mm terms)` : base;
}

/** "+0.7 EV", "−1 EV" (a real minus sign), "0 EV". */
export function formatBias(ev: number): string {
  const n = Math.round(ev * 10) / 10;
  if (n === 0) return '0 EV';
  return `${n > 0 ? '+' : '\u2212'}${oneDecimal(Math.abs(n))} EV`;
}

/** "12.2 MP". */
export function megapixels(w: number, h: number): string {
  return `${((w * h) / 1e6).toFixed(1)} MP`;
}

const RATIOS: [string, number][] = [['1:1', 1], ['5:4', 5 / 4], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['2:1', 2]];

/** The usual name of the shape (long side first, whichever way up), else "1.62:1". */
export function aspectRatio(w: number, h: number): string {
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (short <= 0) return '';
  const r = long / short;
  for (const [name, v] of RATIOS) if (Math.abs(r - v) / v <= 0.02) return name;
  return `${r.toFixed(2)}:1`;
}
