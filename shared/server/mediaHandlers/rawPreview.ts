import { tiffHeader, TiffView, writeTiff, type Ifd, type TiffField, type TiffIfdSpec } from './tiff';

// Finding the JPEG previews a camera stores inside its RAW files. Pure: a Buffer in, offsets out. No
// sharp and no file access here, so the parsing can be tested byte by byte against hostile input.
//
// Where the previews are, by container (the container is told by the file's magic bytes, never by
// its name):
// - TIFF-like (DNG, CR2, NEF, ARW, PEF, SRW, ORF, RW2, and most others): every IFD of the chain, of
//   SubIFDs and of the Exif IFD is looked at for a JPEG: JPEGInterchangeFormat/Length, a single strip
//   (or contiguous strips), and Panasonic's JpgFromRaw (tag 0x2E).
// - CR3 (ISO base media): the THMB box, the PRVW box, and the first track's first sample (in mdat).
// - RAF (Fujifilm): the JPEG the header points to.
// - Any container, these included: the file is also searched for JPEG start markers, a bounded number
//   of times. That finds maker-note previews (Olympus, Pentax) and the JPEGs inside formats with no
//   parser here (CRW, X3F, IIQ and the like).
//
// Each candidate is checked to be a JPEG this program can decode: it must start with FF D8, and its
// markers are walked (a bounded number of steps, inside the file) to a baseline, extended or
// progressive 8-bit frame header (SOF0/1/2), which gives its size. The sensor data of many RAWs is a
// lossless JPEG (SOF3), often the biggest "JPEG" in the file; it is never a candidate. The biggest
// picture comes first.

/** How many IFDs are followed in one file, and how deep SubIFDs and Exif IFDs may nest. */
const MAX_IFDS = 64;
const MAX_IFD_DEPTH = 3;
/** How many JPEG start markers the search looks at, and how many marker segments it walks in one. */
const MAX_CARVE_HITS = 256;
const MAX_MARKER_STEPS = 1024;
/** How many ISO boxes are looked at in one box. */
const MAX_BOXES = 4096;
/** A preview with more pixels than this is not one (and sharp would refuse it). */
export const RAW_PREVIEW_MAX_PIXELS = 200_000_000;

export type RawContainer = 'tiff' | 'cr3' | 'raf' | 'other';

export interface JpegCandidate {
  /** Where the JPEG starts in the file, and how many bytes it may take (to the file's end when unknown). */
  offset: number;
  length: number;
  width: number;
  height: number;
  /** The frame marker: 0xC0, 0xC1 or 0xC2. */
  sof: number;
  /** It has an APP1 "Exif" segment. */
  exif: boolean;
  /** Found by the container's structure, or by searching for start markers. */
  from: 'structure' | 'search';
}

export interface RawPreviews {
  container: RawContainer;
  /** Decodable JPEGs, biggest picture first. */
  candidates: JpegCandidate[];
  /** The RAW's own EXIF orientation (1..8), from IFD0 (CMT1 in a CR3); null when it says none. */
  orientation: number | null;
}

const SOI3 = Buffer.from([0xff, 0xd8, 0xff]);

/** The container, by the file's first bytes. */
export function rawContainer(buf: Buffer): RawContainer {
  if (buf.length >= 16 && buf.toString('latin1', 0, 16) === 'FUJIFILMCCD-RAW ') return 'raf';
  if (buf.length >= 12 && buf.toString('latin1', 4, 12) === 'ftypcrx ') return 'cr3';
  if (tiffHeader(buf)) return 'tiff';
  return 'other';
}

/**
 * The JPEG at `offset` (taking at most `length` bytes), if it is one this program decodes: its frame
 * size and kind. Null for anything else, a lossless or 12-bit JPEG included.
 */
export function jpegAt(buf: Buffer, offset: number, length: number, from: JpegCandidate['from'] = 'structure'): JpegCandidate | null {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 4) return null;
  const end = Math.min(buf.length, offset + length);
  if (offset + 4 > end || buf[offset] !== 0xff || buf[offset + 1] !== 0xd8) return null;
  let p = offset + 2;
  let exif = false;
  for (let steps = 0; steps < MAX_MARKER_STEPS && p + 4 <= end; steps++) {
    if (buf[p] !== 0xff) return null;
    const marker = buf[p + 1];
    // Fill bytes, and markers with no length.
    if (marker === 0xff) { p++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { p += 2; continue; }
    // The picture data or the end before any frame header: not a picture.
    if (marker === 0xda || marker === 0xd9) return null;
    const segLen = buf.readUInt16BE(p + 2);
    if (segLen < 2 || p + 2 + segLen > end) return null;
    if (marker === 0xe1 && segLen >= 8 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') exif = true;
    // SOF markers are C0..CF, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segLen < 8) return null;
      const precision = buf[p + 4];
      const height = buf.readUInt16BE(p + 5);
      const width = buf.readUInt16BE(p + 7);
      if (marker > 0xc2 || precision !== 8 || !width || !height || width * height > RAW_PREVIEW_MAX_PIXELS) return null;
      return { offset, length: end - offset, width, height, sof: marker, exif, from };
    }
    p += 2 + segLen;
  }
  return null;
}

/** The decodable JPEGs found by searching the file for start markers (a bounded number of them). */
export function searchJpegs(buf: Buffer, from = 0, to = buf.length): JpegCandidate[] {
  const out: JpegCandidate[] = [];
  let at = Math.max(0, from);
  const end = Math.min(buf.length, to);
  for (let hits = 0; hits < MAX_CARVE_HITS; hits++) {
    const i = buf.indexOf(SOI3, at);
    if (i < 0 || i >= end) break;
    const found = jpegAt(buf, i, end - i, 'search');
    if (found) out.push(found);
    at = i + 2;
  }
  return out;
}

// ---- TIFF-like containers ------------------------------------------------------------------------

const TAG = {
  orientation: 0x0112, stripOffsets: 0x0111, stripByteCounts: 0x0117, subIfds: 0x014a, exifIfd: 0x8769, gpsIfd: 0x8825,
  jpegOffset: 0x0201, jpegLength: 0x0202, panasonicJpeg: 0x002e,
} as const;

/** Every IFD reachable from IFD0: the chain, SubIFDs and the Exif IFD, each once, a bounded number. */
function walkIfds(view: TiffView, ifd0: number): Ifd[] {
  const out: Ifd[] = [];
  const seen = new Set<number>();
  const queue: [number, number][] = [[ifd0, 0]];
  while (queue.length && out.length < MAX_IFDS) {
    const [offset, depth] = queue.shift()!;
    if (!offset || seen.has(offset)) continue;
    seen.add(offset);
    const ifd = view.readIfd(offset);
    if (!ifd) continue;
    out.push(ifd);
    if (ifd.next) queue.push([ifd.next, depth]);
    if (depth < MAX_IFD_DEPTH) {
      for (const tag of [TAG.subIfds, TAG.exifIfd]) for (const o of view.ints(ifd.entries.get(tag), MAX_IFDS)) queue.push([o, depth + 1]);
    }
  }
  return out;
}

/** The JPEGs an IFD points to. */
function ifdJpegs(view: TiffView, ifd: Ifd): JpegCandidate[] {
  const out: (JpegCandidate | null)[] = [];
  const e = ifd.entries;
  const jOff = view.int(e.get(TAG.jpegOffset));
  const jLen = view.int(e.get(TAG.jpegLength));
  if (jOff !== null && jLen !== null) out.push(jpegAt(view.buf, view.base + jOff, jLen));
  // Strips: one, or several that follow each other with no gap (then they are one JPEG).
  const offsets = view.ints(e.get(TAG.stripOffsets), 4096);
  const counts = view.ints(e.get(TAG.stripByteCounts), 4096);
  if (offsets.length && offsets.length === counts.length && offsets.every((o, i) => i === 0 || o === offsets[i - 1] + counts[i - 1])) {
    out.push(jpegAt(view.buf, view.base + offsets[0], counts.reduce((a, b) => a + b, 0)));
  }
  const pana = e.get(TAG.panasonicJpeg);
  if (pana && pana.size > 4) out.push(jpegAt(view.buf, pana.at, pana.size));
  return out.filter((c): c is JpegCandidate => !!c);
}

function tiffPreviews(buf: Buffer): { candidates: JpegCandidate[]; orientation: number | null } {
  const h = tiffHeader(buf)!;
  const view = new TiffView(buf, 0, h.le);
  const ifds = walkIfds(view, h.ifd0);
  const ifd0 = ifds.find((i) => i.offset === h.ifd0);
  return { candidates: ifds.flatMap((i) => ifdJpegs(view, i)), orientation: orientationOf(view, ifd0) };
}

function orientationOf(view: TiffView, ifd: Ifd | undefined): number | null {
  const o = ifd ? view.int(ifd.entries.get(TAG.orientation)) : null;
  return o !== null && o >= 1 && o <= 8 ? o : null;
}

// ---- CR3 (ISO base media) ------------------------------------------------------------------------

interface Box {
  type: string;
  /** The box's own start, its content's start (after the header and a uuid's 16 bytes) and its end. */
  start: number;
  body: number;
  end: number;
  uuid?: string;
}

/** The boxes between `from` and `to`, a bounded number; a box that runs past `to` ends the list. */
function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  const end = Math.min(to, buf.length);
  while (p + 8 <= end && out.length < MAX_BOXES) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = buf.readUInt32BE(p + 8) * 2 ** 32 + buf.readUInt32BE(p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    const box: Box = { type, start: p, body: p + header, end: p + size };
    if (type === 'uuid') {
      if (box.body + 16 > box.end) break;
      box.uuid = buf.toString('hex', box.body, box.body + 16);
      box.body += 16;
    }
    out.push(box);
    p += size;
  }
  return out;
}

const CANON_UUID = '85c0b687820f11e08111f4ce462b6a48';
const PREVIEW_UUID = 'eaf42b5e1c984b88b9fbb7dc406e4d16';

const child = (buf: Buffer, box: Box | undefined, type: string) => (box ? boxes(buf, box.body, box.end).find((b) => b.type === type) : undefined);

/** A JPEG that starts within the first bytes of a box's content and runs to the box's end (THMB, PRVW). */
function jpegInBox(buf: Buffer, box: Box | undefined): JpegCandidate | null {
  if (!box) return null;
  const i = buf.indexOf(SOI3, box.body);
  if (i < 0 || i > box.body + 64 || i >= box.end) return null;
  return jpegAt(buf, i, box.end - i);
}

interface Cr3Parts {
  candidates: JpegCandidate[];
  /** CMT1 (IFD0), CMT2 (Exif) and CMT4 (GPS): each a whole TIFF structure. */
  cmt: Map<string, Box>;
}

function cr3Parts(buf: Buffer): Cr3Parts {
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  const candidates: (JpegCandidate | null)[] = [];
  const cmt = new Map<string, Box>();
  const inMoov = moov ? boxes(buf, moov.body, moov.end) : [];
  const canon = inMoov.find((b) => b.type === 'uuid' && b.uuid === CANON_UUID);
  if (canon) {
    for (const b of boxes(buf, canon.body, canon.end)) {
      if (/^CMT[1-4]$/.test(b.type)) cmt.set(b.type, b);
      if (b.type === 'THMB') candidates.push(jpegInBox(buf, b));
    }
  }
  // The first track holds the full-size JPEG: its first sample, by the sample table.
  const trak = inMoov.find((b) => b.type === 'trak');
  const stbl = child(buf, child(buf, child(buf, trak, 'mdia'), 'minf'), 'stbl');
  const stsz = child(buf, stbl, 'stsz');
  const co64 = child(buf, stbl, 'co64');
  const stco = child(buf, stbl, 'stco');
  if (stsz && stsz.body + 12 <= stsz.end && (co64 || stco)) {
    const uniform = buf.readUInt32BE(stsz.body + 4);
    const count = buf.readUInt32BE(stsz.body + 8);
    const size = uniform || (count > 0 && stsz.body + 16 <= stsz.end ? buf.readUInt32BE(stsz.body + 12) : 0);
    let offset: number | null = null;
    if (co64 && co64.body + 16 <= co64.end && buf.readUInt32BE(co64.body + 4) > 0) offset = buf.readUInt32BE(co64.body + 8) * 2 ** 32 + buf.readUInt32BE(co64.body + 12);
    else if (stco && stco.body + 12 <= stco.end && buf.readUInt32BE(stco.body + 4) > 0) offset = buf.readUInt32BE(stco.body + 8);
    if (offset !== null && size) candidates.push(jpegAt(buf, offset, size));
  }
  const preview = top.find((b) => b.type === 'uuid' && b.uuid === PREVIEW_UUID);
  candidates.push(jpegInBox(buf, child(buf, preview, 'PRVW')));
  return { candidates: candidates.filter((c): c is JpegCandidate => !!c), cmt };
}

/** A CMT box's TIFF structure and its first IFD. */
function cmtIfd(buf: Buffer, box: Box | undefined): { view: TiffView; ifd: Ifd } | null {
  if (!box) return null;
  const h = tiffHeader(buf, box.body);
  if (!h) return null;
  const view = new TiffView(buf, box.body, h.le);
  const ifd = view.readIfd(h.ifd0);
  return ifd ? { view, ifd } : null;
}

// ---- RAF (Fujifilm) ------------------------------------------------------------------------------

function rafPreview(buf: Buffer): JpegCandidate | null {
  if (buf.length < 92) return null;
  return jpegAt(buf, buf.readUInt32BE(84), buf.readUInt32BE(88));
}

// ---- Putting it together -------------------------------------------------------------------------

/** Biggest picture first; at the same size, one the structure names, then the longer one. */
const byPicture = (a: JpegCandidate, b: JpegCandidate) =>
  b.width * b.height - a.width * a.height || (a.from === b.from ? 0 : a.from === 'structure' ? -1 : 1) || b.length - a.length;

/** Every decodable JPEG preview in a RAW file, biggest first, and the RAW's own orientation. */
export function findRawPreviews(buf: Buffer): RawPreviews {
  const container = rawContainer(buf);
  let structured: JpegCandidate[] = [];
  let orientation: number | null = null;
  if (container === 'tiff') {
    ({ candidates: structured, orientation } = tiffPreviews(buf));
  } else if (container === 'cr3') {
    const parts = cr3Parts(buf);
    structured = parts.candidates;
    const c1 = cmtIfd(buf, parts.cmt.get('CMT1'));
    orientation = c1 ? orientationOf(c1.view, c1.ifd) : null;
  } else if (container === 'raf') {
    const c = rafPreview(buf);
    if (c) structured = [c];
  }
  // One entry per offset: the structure's (it knows the length) over the search's.
  const byOffset = new Map<number, JpegCandidate>();
  for (const c of [...structured, ...searchJpegs(buf)]) if (!byOffset.has(c.offset)) byOffset.set(c.offset, c);
  return { container, candidates: [...byOffset.values()].sort(byPicture), orientation };
}

/**
 * The EXIF of a RAW whose container exifr can't read, as bytes exifr can: for a CR3, one TIFF
 * structure made from its CMT1 (IFD0), CMT2 (Exif) and CMT4 (GPS) boxes; for a RAF and the formats
 * with no parser here, the biggest embedded JPEG that carries EXIF. Null for TIFF-like files (exifr
 * reads those itself) and when there is none.
 */
export function rawExifBlock(buf: Buffer): Buffer | null {
  const container = rawContainer(buf);
  if (container === 'tiff') return null;
  if (container === 'cr3') return cr3Exif(buf);
  const withExif = findRawPreviews(buf).candidates.find((c) => c.exif);
  return withExif ? buf.subarray(withExif.offset, withExif.offset + withExif.length) : null;
}

/** The pointer tags of IFD0, which point into the box they came from and so are not copied. */
const POINTERS: ReadonlySet<number> = new Set([TAG.exifIfd, TAG.gpsIfd, TAG.subIfds]);

function cr3Exif(buf: Buffer): Buffer | null {
  const { cmt } = cr3Parts(buf);
  const ifd0 = cmtIfd(buf, cmt.get('CMT1'));
  const exif = cmtIfd(buf, cmt.get('CMT2'));
  const gps = cmtIfd(buf, cmt.get('CMT4'));
  const base = ifd0 ?? exif ?? gps;
  if (!base) return null;
  // Values are copied as they are, so every part must have the same byte order.
  const same = (p: typeof ifd0) => (p && p.view.le === base.view.le ? p : null);
  const fieldsOf = (p: { view: TiffView; ifd: Ifd } | null, skip: ReadonlySet<number> = new Set()): TiffField[] =>
    p ? [...p.ifd.entries.values()].filter((e) => !skip.has(e.tag)).map((e) => ({ tag: e.tag, raw: { type: e.type, count: e.count, bytes: p.view.bytes(e) } })) : [];
  const fields = fieldsOf(same(ifd0), POINTERS);
  const exifPart = same(exif);
  const gpsPart = same(gps);
  if (exifPart) fields.push({ tag: TAG.exifIfd, ifd: { fields: fieldsOf(exifPart, POINTERS) } });
  if (gpsPart) fields.push({ tag: TAG.gpsIfd, ifd: { fields: fieldsOf(gpsPart) } });
  if (!fields.length) return null;
  const spec: TiffIfdSpec = { fields };
  return writeTiff(spec, { le: base.view.le });
}

