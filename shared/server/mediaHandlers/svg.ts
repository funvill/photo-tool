import { readFile, stat } from 'node:fs/promises';
import sharp, { type Sharp } from 'sharp';
import { derivedPng } from './derived';
import type { MediaHandler } from './index';

// SVG, treated as untrusted input. It is never put in a page: it is rasterised here by sharp's
// librsvg into a PNG in the derived cache, and everything else reads that PNG.
// - librsvg runs no scripts and fetches nothing from the network.
// - Read from a file path, librsvg would still load images that sit beside the SVG (an `<image
//   href="photo.jpg">`). So the SVG is always handed over as bytes, with no base path, and then
//   every external reference is refused. Only `data:` images inside the file itself are drawn.
// - sharp's SVG file loader is blocked for this whole process (below), so no other code path, and
//   no file whose extension lies (an SVG named .jpg), can load an SVG by its path.
// - The input size and the raster size are capped; librsvg's own XML limits stay on (sharp's
//   `unlimited` is left false).

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

sharp.block({ operation: ['VipsForeignLoadSvgFile', 'VipsForeignLoadSvgSource'] });

/** The SVG at `file` as an upright raster whose long side is between `minSide` and `maxSide`. */
export async function rasteriseSvg(file: string, minSide = SVG_MIN_SIDE, maxSide = SVG_MAX_SIDE): Promise<Sharp> {
  if ((await stat(file)).size > SVG_MAX_BYTES) throw new Error(`This SVG is too large to open (over ${SVG_MAX_BYTES / 1024 / 1024} MB).`);
  const bytes = await readFile(file);
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
  const png = await sharp(bytes, { density, limitInputPixels: limit }).resize(side, side, { fit: 'inside' }).png().toBuffer();
  return sharp(png);
}

export const svgHandler: MediaHandler = {
  id: 'svg',
  preview: (file, ctx) => derivedPng(file, ctx, (f) => rasteriseSvg(f)),
  image: (file) => rasteriseSvg(file, SVG_IMAGE_SIDE, SVG_IMAGE_SIDE),
};
