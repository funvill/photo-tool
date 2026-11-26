import { open } from 'node:fs/promises';

// A look at a file's first bytes, in our own code, before sharp sees it. sharp (libvips) picks its
// decoder by content, not by name, and would read an SVG under a photo's name by its path, where an
// SVG can draw the files beside it. sharp's SVG file loader is also blocked (svg.ts), but that rests
// on sharp's internals; this does not.
//
// The check is positive: a file goes to sharp only if it starts with the magic bytes of a raster
// format sharp reads (rasterFormat). Searching the first N bytes for markup can't work: libvips
// finds an `<svg` further in than any fixed window (600 spaces first was enough to get past 512
// bytes). No accepted magic can start an XML document either: XML begins with `<`, after an
// optional byte order mark and white space, and none of these start with any of those bytes.

/** How much of a file is looked at. */
const HEAD_BYTES = 512;

/** The first bytes of a file (fewer when it is shorter). */
export async function readHead(file: string, bytes = HEAD_BYTES): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** gzip's magic number: a compressed file (an .svgz under another name). */
export const isGzip = (head: Buffer) => head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

/** A UTF-16 byte order mark: text, which no picture format starts with. */
const isUtf16 = (head: Buffer) => head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));

const WHITE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** Where the content starts: after a UTF-8 byte order mark and ASCII white space. */
function contentStart(head: Buffer): number {
  let i = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (i < head.length && WHITE.has(head[i])) i++;
  return i;
}

/** The file starts with markup (`<`, after an optional BOM and white space): XML, an SVG. */
export const startsWithMarkup = (head: Buffer) => head[contentStart(head)] === 0x3c;

/**
 * True when the first bytes look like text or a compressed file: markup, UTF-16, gzip, or nothing
 * but a BOM and white space (markup may come after the bytes looked at). Only used to word the
 * refusal: whether a file is read at all is rasterFormat's call.
 */
export const looksLikeText = (head: Buffer) => isGzip(head) || isUtf16(head) || startsWithMarkup(head) || (head.length > 0 && contentStart(head) === head.length);

const ascii = (head: Buffer, at: number, s: string) => head.length >= at + s.length && head.toString('latin1', at, at + s.length) === s;

/** The ISO base media brands libheif (sharp's HEIF/AVIF loader) reads: AVIF, HEIC and HEIF. */
const HEIF_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2']);

/** The format sharp reads from a file's magic bytes, by sharp's own format names. */
export type RasterFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff' | 'heif';

/**
 * Which raster format a file's first bytes are, or null if none sharp reads. Matches what libvips
 * itself checks: JPEG is FF D8 (libvips looks no further); PNG its 8-byte signature; GIF87a/89a;
 * RIFF....WEBP; TIFF and BigTIFF in both byte orders; and an ISO `ftyp` box with a HEIF/AVIF brand.
 */
export function rasterFormat(head: Buffer): RasterFormat | null {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return 'gif';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'webp';
  if (head.length >= 4 && ((head[0] === 0x49 && head[1] === 0x49 && (head[2] === 0x2a || head[2] === 0x2b) && head[3] === 0x00)
    || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && (head[3] === 0x2a || head[3] === 0x2b)))) return 'tiff';
  if (ascii(head, 4, 'ftyp') && head.length >= 12) {
    // The box's size comes first; the major brand, then (after a version) the compatible brands.
    const size = head.readUInt32BE(0);
    if (size < 16) return null;
    const brands = [head.toString('latin1', 8, 12)];
    for (let at = 16; at + 4 <= Math.min(size, head.length); at += 4) brands.push(head.toString('latin1', at, at + 4));
    return brands.some((b) => HEIF_BRANDS.has(b)) ? 'heif' : null;
  }
  return null;
}
