import sharp from 'sharp';
import type { MediaHandler } from './index';

// Formats sharp's bundled libvips decodes itself: the original is the working file, never copied.

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
  return {
    id,
    preview: async (file) => file,
    image: async (file) => sharp(file, { failOn: 'none' }).rotate(),
    ...(opts.exifFromSharp ? { exifBlock: sharpExifBlock } : {}),
  };
}
