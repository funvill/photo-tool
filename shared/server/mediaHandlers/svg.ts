import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { derivedPng } from './derived';
import type { MediaHandler } from './index';
import { isGzip, startsWithMarkup } from './sniff';

// SVG, treated as untrusted input. It is never put in a page: it is rasterised here by sharp's
// librsvg into a PNG in the derived cache, and everything else reads that PNG.
// - librsvg runs no scripts and fetches nothing from the network.
// - Read from a file path, librsvg would still load images that sit beside the SVG (an `<image
//   href="photo.jpg">`). So the SVG is always handed over as bytes, with no base path, and then
//   every external reference is refused. Only `data:` images inside the file itself are drawn.
// - A gzipped SVG is refused before sharp sees it: librsvg would inflate it whatever its name, far
//   past the size cap (a decompression bomb). So is a file that doesn't start with markup.
// - An SVG under another name (.jpg) is refused by the other handlers, which look at a file's first
//   bytes before sharp does (sniff.ts). On top of that, sharp's SVG file loader is blocked for this
//   whole process (below), so no code path can load an SVG by its path. Each server checks the block
//   when it is made (`checkSvgGuardOnce`); a sharp build without it only gets a warning, since the
//   content check does not depend on it. Note for tests: the block also holds for every test file
//   vitest runs in the same process, so a test must read an SVG into a buffer too.
// - The input size and the raster size are capped, and drawing has a time limit; librsvg's own
//   XML limits stay on (sharp's `unlimited` is left false).

/** SVGs bigger than this are refused, not parsed. */
export const SVG_MAX_BYTES = 20 * 1024 * 1024;
/** The working raster's long side: the SVG's own size, scaled up to at least this ... */
export const SVG_MIN_SIDE = 2048;
/** ... and down to at most this. */
export const SVG_MAX_SIDE = 4096;
/** The long side of the small in-memory raster `image()` gives (the editor's shelf previews). */
const SVG_IMAGE_SIDE = 1024;
/** sharp's range for `density`. */
const DENSITY_MIN = 1;
const DENSITY_MAX = 100_000;
/** Drawing one SVG for longer than this, it is given up. */
const SVG_RENDER_SECONDS = 20;

const SVG_LOADERS = ['VipsForeignLoadSvgFile', 'VipsForeignLoadSvgSource'];
let blockApplied = false;
try {
  sharp.block({ operation: SVG_LOADERS });
  blockApplied = true;
} catch (e) {
  // A sharp build without block(): the content check still refuses SVGs under other names.
  console.warn(`Photo tools: could not block sharp's SVG file loader (${e instanceof Error ? e.message : String(e)}). SVGs under other names are still refused by their content.`);
}

/** True when sharp refuses to load an SVG by its path (the block is in effect). */
export async function svgPathRefused(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'svg-guard-'));
  try {
    const file = join(dir, 'probe.svg');
    await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    try {
      await sharp(file).metadata();
      return false;
    } catch {
      return true;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Whether the block is in effect: it warns through `warn` when it is not. The servers carry on either
 * way, since the content check (sniff.ts) refuses an SVG under another name without it.
 */
export async function checkSvgGuard(warn: (message: string) => void = console.warn): Promise<{ blockApplied: boolean; pathRefused: boolean }> {
  const pathRefused = await svgPathRefused().catch(() => false);
  if (!pathRefused) warn('Photo tools: this sharp build loads an SVG by its path. SVGs under other names are still refused by their content, but that second guard is missing.');
  return { blockApplied, pathRefused };
}

let guardChecked: Promise<unknown> | null = null;
/** `checkSvgGuard`, once per process: each server calls it when it is made. */
export function checkSvgGuardOnce(): void {
  guardChecked ??= checkSvgGuard().catch(() => undefined);
}

/** The SVG at `file` as an upright raster whose long side is between `minSide` and `maxSide`. */
export async function rasteriseSvg(file: string, minSide = SVG_MIN_SIDE, maxSide = SVG_MAX_SIDE): Promise<Sharp> {
  if ((await stat(file)).size > SVG_MAX_BYTES) throw new Error(`This SVG is too large to open (over ${SVG_MAX_BYTES / 1024 / 1024} MB).`);
  const bytes = await readFile(file);
  if (isGzip(bytes)) throw new Error('This SVG is compressed (gzip), which is not supported.');
  if (!startsWithMarkup(bytes)) throw new Error('This file is not an SVG.');
  // Its own size at 72 dpi. Reading the size draws nothing, so no pixel limit is needed for it.
  const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  if (meta.format !== 'svg') throw new Error('This file is not an SVG.');
  if (!meta.width || !meta.height) throw new Error('This SVG has no size.');
  const long = Math.max(meta.width, meta.height);
  const side = Math.min(maxSide, Math.max(minSide, long));
  const density = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, (72 * side) / long));
  // Drawn at the density that gives `side` (a little over, from rounding, is allowed); a drawing that
  // would still be bigger (a size beyond what density can scale down) is refused, not drawn.
  const limit = Math.ceil((maxSide + 2) * (maxSide + 2));
  const png = await sharp(bytes, { density, limitInputPixels: limit }).timeout({ seconds: SVG_RENDER_SECONDS }).resize(side, side, { fit: 'inside' }).png().toBuffer();
  return sharp(png);
}

export const svgHandler: MediaHandler = {
  id: 'svg',
  preview: (file, ctx) => derivedPng(file, ctx, (f) => rasteriseSvg(f)),
  image: (file) => rasteriseSvg(file, SVG_IMAGE_SIDE, SVG_IMAGE_SIDE),
};
