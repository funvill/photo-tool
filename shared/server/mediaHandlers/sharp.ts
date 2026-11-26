import sharp from 'sharp';
import { formatById } from '../../core/mediaFormats';
import type { MediaHandler } from './index';
import { looksLikeText, readHead } from './sniff';

// Formats sharp's bundled libvips decodes itself: the original is the working file, never copied.
// sharp picks its decoder by content, not by name, so the file's first bytes are checked first: an
// SVG (or any text) under a photo's name is refused here, before sharp could read it by its path.

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
    if (looksLikeText(await readHead(file))) throw new Error(`This file holds text, not a ${label} picture (it may be an SVG drawing under another name).`);
    return file;
  };
  return {
    id,
    preview: checked,
    image: async (file) => sharp(await checked(file), { failOn: 'none' }).rotate(),
    ...(opts.exifFromSharp ? { exifBlock: sharpExifBlock } : {}),
  };
}
