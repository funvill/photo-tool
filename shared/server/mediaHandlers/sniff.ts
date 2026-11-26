import { open } from 'node:fs/promises';

// A look at a file's first bytes, in our own code, before sharp sees it. The decoders sharp picks by
// content would otherwise read an SVG (or XML, or a gzipped SVG) whatever the file's name says, and
// read by its path an SVG can draw the files beside it. sharp's SVG file loader is also blocked
// (svg.ts), but that rests on sharp's internals; this does not.

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

/** Where the content starts: after a UTF-8 byte order mark and ASCII white space. */
function contentStart(head: Buffer): number {
  let i = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  return i;
}

/** The file starts with markup (`<`, after an optional BOM and white space): XML, an SVG. */
export const startsWithMarkup = (head: Buffer) => head[contentStart(head)] === 0x3c;

/**
 * True when a file that should be a picture is text or compressed instead: markup (an SVG or XML),
 * UTF-16 text, or gzip. No format read through sharp from the original starts like that.
 */
export const looksLikeText = (head: Buffer) => isGzip(head) || isUtf16(head) || startsWithMarkup(head);
