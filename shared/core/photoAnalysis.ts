/** Analysis computed once at import; all values are cheap, local, and deterministic. */
export interface PhotoAnalysis {
  /** Variance of the Laplacian on a 256px greyscale thumbnail. Higher = sharper. */
  sharpness: number;
  /** Mean luminance 0..1. */
  meanLuma: number;
  /** Fraction of pixels crushed to near-black / blown to near-white. */
  clippedShadows: number;
  clippedHighlights: number;
  /** 64-bit difference hash as 16 hex chars. */
  dHash: string;
  /** Edge-energy centre of mass, normalized 0..1 — a cheap stand-in for "where the subject is". */
  saliencyX: number;
  saliencyY: number;
  /** Mean colour (sRGB 0–255). Photos imported before colour analysis get it on next library load. */
  avgColor?: [number, number, number];
  /** 3 × 3 grid of mean colours (27 numbers, row-major RGB): palette plus rough composition. */
  colorGrid?: number[];
  /** Has see-through pixels (a cutout or sticker). Missing = opaque (checked on next library load). */
  transparent?: boolean;
}
