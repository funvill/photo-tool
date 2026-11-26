import sharp from 'sharp';
import { formatById } from '../../core/mediaFormats';
import type { MediaHandler } from './index';
import { looksLikeText, rasterFormat, readHead } from './sniff';

// Formats sharp's bundled libvips decodes itself: the original is the working file, never copied.
// sharp picks its decoder by content, not by name, so the file's first bytes are checked first: it
// must start with the magic bytes of a raster format sharp reads (sniff.ts rasterFormat). Anything
// else, an SVG (or any text) under a photo's name included, is refused here, before sharp could
// read it by its path. A picture under another raster format's name (a PNG called .jpg) is read as
// what it really is, as it always was: that is safe, and such files exist.

/** The EXIF block sharp finds in a file, as the TIFF structure exifr reads (without its "Exif\0\0" mark). */
export async function sharpExifBlock(data: Buffer): Promise<Buffer | null> {
  const exif = (await sharp(data, { failOn: 'none' }).metadata()).exif;
  if (!exif?.length) return null;
  return exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? exif.subarray(6) : exif;
}

/**
 * `exifFromSharp`: exifr can't find the EXIF in this format's files (AVIF, where libheif stores it
 * in a way exifr misreads), so it is taken from what sharp reads instead.
 */
export function sharpHandler(id: string, opts: { exifFromSharp?: boolean } = {}): MediaHandler {
  const label = formatById(id)?.label ?? id.toUpperCase();
  const checked = async (file: string) => {
    const head = await readHead(file);
    if (rasterFormat(head)) return file;
    throw new Error(looksLikeText(head)
      ? `This file is not a ${label} picture: it holds text (it may be an SVG drawing under another name).`
      : `This file is not a ${label} picture, nor any picture format this program reads.`);
    return file;
  };
  return {
    id,
    preview: checked,
    image: async (file) => sharp(await checked(file), { failOn: 'none' }).rotate(),
    ...(opts.exifFromSharp ? { exifBlock: sharpExifBlock } : {}),
  };
}
