import sharp from 'sharp';
import { TIFF, TIFF_MAGICS, writeTiff, type TiffField, type TiffIfdSpec } from './tiff';

// Synthetic camera RAW files: the containers real cameras write (TIFF IFDs, CR3 boxes, the RAF header),
// holding a JPEG preview where each maker puts it, and sensor data that is only filler. They are made
// for the tests, the fixtures (scripts/make-fixtures.ts) and the desktop self-test; no real camera file
// is downloaded or checked in. They follow the published layouts, but they were not made by a camera:
// a real camera's file can differ in ways these do not show.
//
// Most of them also carry a lossless-JPEG "sensor data" decoy bigger than the preview, as DNG and CR2
// files really do: the preview finder must never take it for the picture.

export type RawSampleLayout = 'dng' | 'cr2' | 'nef' | 'arw' | 'orf' | 'pef' | 'rw2' | 'tiff' | 'cr3' | 'raf' | 'crw' | 'x3f' | 'iiq';

/** The layout each RAW format's sample is made with: its own where there is one, else the closest. */
export const RAW_SAMPLE_LAYOUT: Record<string, RawSampleLayout> = {
  dng: 'dng', cr2: 'cr2', cr3: 'cr3', crw: 'crw', nef: 'nef', nrw: 'nef', arw: 'arw', srf: 'arw', sr2: 'arw', raf: 'raf',
  orf: 'orf', rw2: 'rw2', rwl: 'rw2', pef: 'pef', srw: 'tiff', '3fr': 'tiff', iiq: 'iiq', erf: 'tiff', mef: 'tiff',
  mos: 'tiff', kdc: 'tiff', dcr: 'tiff', x3f: 'x3f',
};

export interface RawSampleSpec {
  /** The big preview (the picture that should be shown), and a small thumbnail. Both JPEG. */
  preview: Buffer;
  thumb: Buffer;
  make?: string;
  model?: string;
  /** IFD0's orientation (CMT1's in a CR3). RAF and the opaque layouts have none of their own. */
  orientation?: number;
  /** EXIF "YYYY:MM:DD HH:MM:SS". */
  date?: string;
  gps?: { lat: number; lon: number };
  /** Leave out the lossless-JPEG decoy. */
  noDecoy?: boolean;
}

/** Filler bytes standing in for sensor data: never 0xFF, so they can't hold a JPEG marker by chance. */
export function filler(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    b[i] = s % 255;
  }
  return b;
}

/**
 * "Sensor data" that starts like a lossless JPEG (SOF3, 14-bit) of 12000 × 8000 pixels: bigger than any
 * preview, and not something a JPEG decoder for photos can show.
 */
export function losslessJpegDecoy(): Buffer {
  const sof3 = Buffer.from([0xff, 0xd8, 0xff, 0xc3, 0x00, 0x0b, 0x0e, 0x1f, 0x40, 0x2e, 0xe0, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([sof3, sos, filler(4096, 7), Buffer.from([0xff, 0xd9])]);
}

/** Degrees as the three RATIONALs GPS uses. */
const dms = (deg: number) => {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = Math.round(((a - d) * 60 - m) * 60 * 100);
  return [d, 1, m, 1, s, 100];
};

function exifFields(s: RawSampleSpec): TiffField[] {
  const f: TiffField[] = [
    { tag: 0x829a, type: TIFF.RATIONAL, values: [1, 250] },
    { tag: 0x829d, type: TIFF.RATIONAL, values: [28, 10] },
    { tag: 0x8827, type: TIFF.SHORT, values: [200] },
  ];
  if (s.date) f.push({ tag: 0x9003, ascii: s.date });
  return f;
}

function gpsFields(s: RawSampleSpec): TiffField[] {
  if (!s.gps) return [];
  return [
    { tag: 0x0001, ascii: s.gps.lat < 0 ? 'S' : 'N' },
    { tag: 0x0002, type: TIFF.RATIONAL, values: dms(s.gps.lat) },
    { tag: 0x0003, ascii: s.gps.lon < 0 ? 'W' : 'E' },
    { tag: 0x0004, type: TIFF.RATIONAL, values: dms(s.gps.lon) },
  ];
}

/** Make, model, orientation and date, as IFD0 has them. */
function ifd0Fields(s: RawSampleSpec): TiffField[] {
  const f: TiffField[] = [];
  if (s.make) f.push({ tag: 0x010f, ascii: s.make });
  if (s.model) f.push({ tag: 0x0110, ascii: s.model });
  if (s.orientation) f.push({ tag: 0x0112, type: TIFF.SHORT, values: [s.orientation] });
  if (s.date) f.push({ tag: 0x0132, ascii: s.date });
  return f;
}

/** IFD0's own fields plus the Exif and GPS IFDs. */
function withExif(s: RawSampleSpec, more: TiffField[], exifMore: TiffField[] = []): TiffField[] {
  const f = [...ifd0Fields(s), ...more, { tag: 0x8769, ifd: { fields: [...exifFields(s), ...exifMore] } } as TiffField];
  const gps = gpsFields(s);
  if (gps.length) f.push({ tag: 0x8825, ifd: { fields: gps } });
  return f;
}

const L = (tag: number, v: number): TiffField => ({ tag, type: TIFF.LONG, values: [v] });
const S = (tag: number, v: number): TiffField => ({ tag, type: TIFF.SHORT, values: [v] });
const strip = (data: Buffer): TiffField[] => [{ tag: 0x0111, offsetOf: data }, L(0x0117, data.length)];
const jpegIf = (data: Buffer): TiffField[] => [{ tag: 0x0201, offsetOf: data }, L(0x0202, data.length)];
const decoyOf = (s: RawSampleSpec) => (s.noDecoy ? filler(4096, 3) : losslessJpegDecoy());

function dng(s: RawSampleSpec): Buffer {
  const raw: TiffIfdSpec = { fields: [L(0x00fe, 0), L(0x0100, 12000), L(0x0101, 8000), S(0x0103, 7), S(0x0106, 32803), ...strip(decoyOf(s))] };
  const preview: TiffIfdSpec = { fields: [L(0x00fe, 1), S(0x0103, 7), S(0x0106, 6), ...strip(s.preview)] };
  return writeTiff({
    fields: withExif(s, [
      L(0x00fe, 1), S(0x0103, 7), S(0x0106, 6), ...strip(s.thumb),
      { tag: 0xc612, type: TIFF.BYTE, values: [1, 4, 0, 0] },
      { tag: 0xc614, ascii: `${s.make ?? ''} ${s.model ?? ''}`.trim() || 'Synthetic' },
      { tag: 0x014a, ifds: [raw, preview] },
    ]),
  });
}

function cr2(s: RawSampleSpec): Buffer {
  const extra = Buffer.alloc(8);
  extra.write('CR', 0, 'latin1');
  extra[2] = 2;
  const ifd3: TiffIfdSpec = { fields: [S(0x0103, 6), ...strip(decoyOf(s))] };
  const ifd2: TiffIfdSpec = { fields: [L(0x0100, 8), L(0x0101, 8), S(0x0103, 1), ...strip(filler(192, 5))], next: ifd3 };
  const ifd1: TiffIfdSpec = { fields: [S(0x0103, 6), ...jpegIf(s.thumb)], next: ifd2 };
  return writeTiff({ fields: withExif(s, [S(0x0103, 6), ...strip(s.preview)]), next: ifd1 }, { extraHeader: extra });
}

function nef(s: RawSampleSpec): Buffer {
  const previewIfd: TiffIfdSpec = { fields: [L(0x00fe, 1), S(0x0103, 6), ...jpegIf(s.preview)] };
  const rawIfd: TiffIfdSpec = { fields: [L(0x00fe, 0), S(0x0103, 34713), ...strip(filler(8192, 9))] };
  return writeTiff({ fields: withExif(s, [L(0x00fe, 1), S(0x0103, 1), ...strip(filler(288, 11)), { tag: 0x014a, ifds: [previewIfd, rawIfd] }]) }, { le: false });
}

function arw(s: RawSampleSpec): Buffer {
  const rawIfd: TiffIfdSpec = { fields: [L(0x00fe, 0), S(0x0103, 32767), ...strip(filler(8192, 13))] };
  return writeTiff({ fields: withExif(s, [S(0x0103, 6), ...jpegIf(s.preview), { tag: 0x014a, ifds: [rawIfd] }]), next: { fields: [S(0x0103, 6), ...jpegIf(s.thumb)] } });
}

/** A maker note holding the preview where only a maker's own parser would find it (Olympus, Pentax). */
const makerNote = (head: string, s: RawSampleSpec) => Buffer.concat([Buffer.from(head, 'latin1'), filler(64, 17), s.preview, filler(32, 19)]);

function orf(s: RawSampleSpec): Buffer {
  return writeTiff(
    { fields: withExif(s, [S(0x0103, 1), ...strip(filler(8192, 23))], [{ tag: 0x927c, bytes: makerNote('OLYMPUS\0II\x03\0', s) }]), next: { fields: [S(0x0103, 6), ...jpegIf(s.thumb)] } },
    { magic: TIFF_MAGICS.olympusRO },
  );
}

function pef(s: RawSampleSpec): Buffer {
  return writeTiff({ fields: withExif(s, [S(0x0103, 65535), ...strip(filler(8192, 29)), ...jpegIf(s.thumb)], [{ tag: 0x927c, bytes: makerNote('AOC\0MM', s) }]) }, { le: false });
}

function rw2(s: RawSampleSpec): Buffer {
  // Panasonic's header is 24 bytes; IFD0 holds the preview as "JpgFromRaw" (tag 0x2E).
  return writeTiff({ fields: withExif(s, [{ tag: 0x002e, bytes: s.preview }, ...strip(filler(8192, 31))]) }, { magic: TIFF_MAGICS.panasonic, extraHeader: Buffer.alloc(16) });
}

function genericTiff(s: RawSampleSpec): Buffer {
  const rawIfd: TiffIfdSpec = { fields: [L(0x00fe, 0), S(0x0103, 7), ...strip(decoyOf(s))] };
  return writeTiff({ fields: withExif(s, [S(0x0103, 6), ...jpegIf(s.preview), { tag: 0x014a, ifds: [rawIfd] }]) });
}

// ---- CR3 ----

const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
};
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
const uuidBox = (uuid: string, ...parts: Buffer[]) => box('uuid', Buffer.from(uuid, 'hex'), ...parts);

/** The pixel size in a JPEG's frame header (for the THMB and PRVW boxes, which state it). */
function jpegSize(jpeg: Buffer): [number, number] {
  for (let p = 2; p + 9 < jpeg.length; ) {
    const m = jpeg[p + 1];
    if (m >= 0xc0 && m <= 0xc2) return [jpeg.readUInt16BE(p + 7), jpeg.readUInt16BE(p + 5)];
    p += 2 + jpeg.readUInt16BE(p + 2);
  }
  return [0, 0];
}

function cr3(s: RawSampleSpec): Buffer {
  const [tw, th] = jpegSize(s.thumb);
  const ftyp = box('ftyp', Buffer.from('crx ', 'latin1'), u32(1), Buffer.from('crx isom', 'latin1'));
  const cmt1 = writeTiff({ fields: ifd0Fields(s) });
  const cmt2 = writeTiff({ fields: exifFields(s) });
  const gps = gpsFields(s);
  const canon = (offset: number) => uuidBox('85c0b687820f11e08111f4ce462b6a48',
    box('CNCV', Buffer.from('CanonCR3_001/00.09.00/00.00.00', 'latin1')),
    box('CMT1', cmt1), box('CMT2', cmt2), box('CMT3', writeTiff({ fields: [S(0x0001, 0)] })),
    ...(gps.length ? [box('CMT4', writeTiff({ fields: gps }))] : []),
    box('THMB', u32(0), u16(tw), u16(th), u32(s.thumb.length), u32(0), s.thumb),
    box('free', u32(offset)),
  );
  const trak = (offset: number) => box('trak',
    box('tkhd', Buffer.alloc(84)),
    box('mdia', box('minf', box('stbl',
      box('stsd', Buffer.alloc(8)),
      box('stsz', u32(0), u32(0), u32(1), u32(s.preview.length)),
      box('co64', u32(0), u32(1), u32(Math.floor(offset / 2 ** 32)), u32(offset >>> 0)),
    ))),
  );
  const moov = (offset: number) => box('moov', box('mvhd', Buffer.alloc(100)), canon(offset), trak(offset));
  const prvw = uuidBox('eaf42b5e1c984b88b9fbb7dc406e4d16', Buffer.alloc(8), box('PRVW', u32(0), u16(1), u16(tw), u16(th), u16(1), u32(s.thumb.length), s.thumb));
  // The sample's offset is where mdat's content starts, which depends only on the sizes before it.
  const before = ftyp.length + moov(0).length + prvw.length + 8;
  const mdat = box('mdat', s.preview, filler(8192, 37));
  return Buffer.concat([ftyp, moov(before), prvw, mdat]);
}

// ---- RAF ----

function raf(s: RawSampleSpec): Buffer {
  const head = Buffer.alloc(160);
  head.write('FUJIFILMCCD-RAW 0201FF389501', 0, 'latin1');
  head.write((s.model ?? 'X-T5').slice(0, 31), 28, 'latin1');
  head.write('0100', 60, 'latin1');
  const cfa = filler(8192, 41);
  head.writeUInt32BE(160, 84);
  head.writeUInt32BE(s.preview.length, 88);
  head.writeUInt32BE(160 + s.preview.length, 92);
  head.writeUInt32BE(0, 96);
  head.writeUInt32BE(160 + s.preview.length, 100);
  head.writeUInt32BE(cfa.length, 104);
  return Buffer.concat([head, s.preview, cfa]);
}

// ---- Formats with no parser here: found only by searching for the JPEG ----

const OPAQUE_MAGIC: Record<'crw' | 'x3f' | 'iiq', Buffer> = {
  crw: Buffer.concat([Buffer.from('II', 'latin1'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('HEAPCCDR', 'latin1')]),
  x3f: Buffer.from('FOVb\x00\x00\x04\x00', 'latin1'),
  iiq: Buffer.from('IIII\x01\x00\x00\x00', 'latin1'),
};

function opaque(kind: 'crw' | 'x3f' | 'iiq', s: RawSampleSpec): Buffer {
  return Buffer.concat([OPAQUE_MAGIC[kind], filler(256, 43), s.thumb, filler(512, 47), s.preview, filler(4096, 53)]);
}

/** A synthetic RAW file of this layout. */
export function rawSample(layout: RawSampleLayout, spec: RawSampleSpec): Buffer {
  switch (layout) {
    case 'dng': return dng(spec);
    case 'cr2': return cr2(spec);
    case 'nef': return nef(spec);
    case 'arw': return arw(spec);
    case 'orf': return orf(spec);
    case 'pef': return pef(spec);
    case 'rw2': return rw2(spec);
    case 'tiff': return genericTiff(spec);
    case 'cr3': return cr3(spec);
    case 'raf': return raf(spec);
    case 'crw': case 'x3f': case 'iiq': return opaque(layout, spec);
  }
}

/** The layouts whose file carries no EXIF outside its JPEG: the preview must hold it. */
export const EXIF_IN_PREVIEW: ReadonlySet<RawSampleLayout> = new Set(['raf', 'crw', 'x3f', 'iiq']);

export interface RawSampleOptions {
  /** The picture (any format sharp reads from a buffer), turned into the preview and the thumbnail. */
  picture: Buffer;
  /** The preview's long side (the thumbnail is 160 px). */
  previewSide?: number;
  make?: string;
  model?: string;
  orientation?: number;
  date?: string;
  gps?: { lat: number; lon: number };
  /** An orientation the preview JPEG itself claims (to show the RAW's own wins). */
  previewOrientation?: number;
  noDecoy?: boolean;
}

/** A synthetic RAW of a format (by its id in mediaFormats.ts), its JPEGs made from `picture`. */
export async function makeRawSample(formatId: string, o: RawSampleOptions): Promise<Buffer> {
  const layout = RAW_SAMPLE_LAYOUT[formatId];
  if (!layout) throw new Error(`No RAW sample layout for ${formatId}`);
  const side = o.previewSide ?? 1200;
  let preview = sharp(o.picture).resize(side, side, { fit: 'inside' }).jpeg({ quality: 88 });
  // Containers with no EXIF of their own carry it in the preview, as real ones do.
  if (EXIF_IN_PREVIEW.has(layout)) {
    const exif: Record<string, Record<string, string>> = { IFD0: { ...(o.make ? { Make: o.make } : {}), ...(o.model ? { Model: o.model } : {}) } };
    if (o.date) exif.IFD2 = { DateTimeOriginal: o.date };
    if (o.gps) {
      const part = (d: number) => { const v = dms(d); return `${v[0]}/${v[1]} ${v[2]}/${v[3]} ${v[4]}/${v[5]}`; };
      exif.IFD3 = { GPSLatitudeRef: o.gps.lat < 0 ? 'S' : 'N', GPSLatitude: part(o.gps.lat), GPSLongitudeRef: o.gps.lon < 0 ? 'W' : 'E', GPSLongitude: part(o.gps.lon) };
    }
    preview = preview.withExif(exif);
  }
  const orientation = EXIF_IN_PREVIEW.has(layout) ? o.orientation : o.previewOrientation;
  if (orientation) preview = preview.withMetadata({ orientation });
  const thumb = await sharp(o.picture).resize(160, 160, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
  return rawSample(layout, {
    preview: await preview.toBuffer(), thumb, make: o.make, model: o.model, date: o.date, gps: o.gps, noDecoy: o.noDecoy,
    orientation: EXIF_IN_PREVIEW.has(layout) ? undefined : o.orientation,
  });
}
