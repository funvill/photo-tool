// A small TIFF structure reader and writer, for camera RAW files (most are TIFF inside) and for the
// synthetic RAW files the tests and the desktop self-test make. Pure: Buffers in, Buffers out.
//
// The reader treats every file as hostile. Every offset and length read from the file is checked
// against the buffer before it is used; an entry that points outside is dropped, an IFD that does not
// fit is not read at all, and nothing here allocates more than the file already is. Callers bound how
// many IFDs they follow (see rawPreview.ts).

/** Bytes per value of each TIFF field type; 0 for a type this reader does not know. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

export const TIFF = {
  BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SBYTE: 6, UNDEFINED: 7, SSHORT: 8, SLONG: 9, SRATIONAL: 10, FLOAT: 11, DOUBLE: 12, IFD: 13,
} as const;

/** The header magic numbers a RAW's TIFF structure may carry: TIFF's 42, Olympus 'RO' and 'RS', Panasonic 0x55. */
export const TIFF_MAGICS = { tiff: 42, olympusRO: 0x4f52, olympusRS: 0x5352, panasonic: 0x55 } as const;
const KNOWN_MAGICS: ReadonlySet<number> = new Set(Object.values(TIFF_MAGICS));

/** IFDs with more entries than this are taken as damage, not read. */
const MAX_ENTRIES = 1000;

export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Where the value's bytes start in the buffer (inside the entry when they fit in 4 bytes). */
  at: number;
  /** How many bytes the value has. */
  size: number;
}

export interface Ifd {
  /** Its offset, relative to the TIFF structure's start. */
  offset: number;
  entries: Map<number, IfdEntry>;
  /** The next IFD's offset (0: none). */
  next: number;
}

/** A TIFF structure in `buf`, starting at `base` (offsets in it are relative to `base`). */
export class TiffView {
  constructor(readonly buf: Buffer, readonly base: number, readonly le: boolean) {}

  private fits(at: number, n: number): boolean {
    return Number.isSafeInteger(at) && at >= 0 && at + n <= this.buf.length;
  }

  u16(at: number): number | null {
    if (!this.fits(at, 2)) return null;
    return this.le ? this.buf.readUInt16LE(at) : this.buf.readUInt16BE(at);
  }

  u32(at: number): number | null {
    if (!this.fits(at, 4)) return null;
    return this.le ? this.buf.readUInt32LE(at) : this.buf.readUInt32BE(at);
  }

  /** The IFD at `offset` (relative to the structure's start), or null when it is not all inside the buffer. */
  readIfd(offset: number): Ifd | null {
    const at = this.base + offset;
    const n = this.u16(at);
    if (n === null || n === 0 || n > MAX_ENTRIES || !this.fits(at, 2 + 12 * n + 4)) return null;
    const entries = new Map<number, IfdEntry>();
    for (let i = 0; i < n; i++) {
      const e = at + 2 + 12 * i;
      const tag = this.u16(e)!;
      const type = this.u16(e + 2)!;
      const count = this.u32(e + 4)!;
      const unit = TYPE_SIZE[type] ?? 0;
      if (!unit) continue;
      const size = unit * count;
      let valueAt = e + 8;
      if (size > 4) valueAt = this.base + this.u32(e + 8)!;
      // A value that is not all inside the file is dropped (count × size can't overflow: both are 32-bit, the product fits a double exactly).
      if (!this.fits(valueAt, size)) continue;
      if (!entries.has(tag)) entries.set(tag, { tag, type, count, at: valueAt, size });
    }
    return { offset, entries, next: this.u32(at + 2 + 12 * n)! };
  }

  /** An integer entry's values (BYTE, SHORT, LONG, IFD and their signed kinds), at most `max` of them. */
  ints(e: IfdEntry | undefined, max = 4096): number[] {
    if (!e) return [];
    const out: number[] = [];
    const n = Math.min(e.count, max);
    for (let i = 0; i < n; i++) {
      switch (e.type) {
        case TIFF.BYTE: case TIFF.UNDEFINED: out.push(this.buf[e.at + i]); break;
        case TIFF.SBYTE: out.push(this.buf.readInt8(e.at + i)); break;
        case TIFF.SHORT: out.push(this.u16(e.at + 2 * i)!); break;
        case TIFF.SSHORT: out.push(this.le ? this.buf.readInt16LE(e.at + 2 * i) : this.buf.readInt16BE(e.at + 2 * i)); break;
        case TIFF.LONG: case TIFF.IFD: out.push(this.u32(e.at + 4 * i)!); break;
        case TIFF.SLONG: out.push(this.le ? this.buf.readInt32LE(e.at + 4 * i) : this.buf.readInt32BE(e.at + 4 * i)); break;
        default: return out;
      }
    }
    return out;
  }

  /** An integer entry's first value, or null. */
  int(e: IfdEntry | undefined): number | null {
    return this.ints(e, 1)[0] ?? null;
  }

  /** An entry's value bytes, as they are in the file (in the structure's byte order). */
  bytes(e: IfdEntry): Buffer {
    return this.buf.subarray(e.at, e.at + e.size);
  }
}

/** The TIFF header at `at`: byte order, magic and the first IFD's offset, or null when there is none there. */
export function tiffHeader(buf: Buffer, at = 0): { le: boolean; magic: number; ifd0: number } | null {
  if (at < 0 || at + 8 > buf.length) return null;
  const order = buf.toString('latin1', at, at + 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const magic = le ? buf.readUInt16LE(at + 2) : buf.readUInt16BE(at + 2);
  if (!KNOWN_MAGICS.has(magic)) return null;
  return { le, magic, ifd0: le ? buf.readUInt32LE(at + 4) : buf.readUInt32BE(at + 4) };
}

// ---- Writing ----------------------------------------------------------------------------------

export type TiffField =
  /** Numbers of an integer type, or RATIONAL/SRATIONAL as numerator, denominator pairs. */
  | { tag: number; type: number; values: number[] }
  | { tag: number; ascii: string }
  /** UNDEFINED bytes, such as a maker note or Panasonic's embedded JPEG. */
  | { tag: number; bytes: Buffer }
  /** A value copied from another TIFF structure with the same byte order, as it was. */
  | { tag: number; raw: { type: number; count: number; bytes: Buffer } }
  /** A LONG holding where `blob` was put in the file (a strip, a JPEG). */
  | { tag: number; offsetOf: Buffer }
  /** A LONG pointing to another IFD (Exif, GPS). */
  | { tag: number; ifd: TiffIfdSpec }
  /** LONGs pointing to other IFDs (SubIFDs). */
  | { tag: number; ifds: TiffIfdSpec[] };

export interface TiffIfdSpec {
  fields: TiffField[];
  /** The IFD the chain continues with. */
  next?: TiffIfdSpec;
}

export interface TiffWriteOptions {
  /** Little endian (II), the default, or big endian (MM). */
  le?: boolean;
  /** The header's magic number: 42, or a maker's own (TIFF_MAGICS). */
  magic?: number;
  /** Bytes put right after the 8-byte header (a CR2's "CR" marker); IFD0 follows them. */
  extraHeader?: Buffer;
}

/** A growable buffer that hands out positions. */
class Out {
  buf = Buffer.alloc(1 << 16);
  len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n + 1024));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  /** Room for `n` bytes at an even position; returns where. */
  reserve(n: number): number {
    if (this.len & 1) this.len++;
    this.ensure(n + 1);
    const at = this.len;
    this.len += n;
    return at;
  }
  put(bytes: Buffer): number {
    const at = this.reserve(bytes.length);
    bytes.copy(this.buf, at);
    return at;
  }
}

/** A TIFF structure holding these IFDs (and every blob they point to). */
export function writeTiff(ifd0: TiffIfdSpec, opts: TiffWriteOptions = {}): Buffer {
  const le = opts.le ?? true;
  const out = new Out();
  const extra = opts.extraHeader ?? Buffer.alloc(0);
  out.reserve(8 + extra.length);
  out.buf.write(le ? 'II' : 'MM', 0, 'latin1');
  const w16 = (v: number, at: number) => (le ? out.buf.writeUInt16LE(v & 0xffff, at) : out.buf.writeUInt16BE(v & 0xffff, at));
  const w32 = (v: number, at: number) => (le ? out.buf.writeUInt32LE(v >>> 0, at) : out.buf.writeUInt32BE(v >>> 0, at));
  w16(opts.magic ?? TIFF_MAGICS.tiff, 2);
  extra.copy(out.buf, 8);

  const encode = (type: number, values: number[]): Buffer => {
    const unit = TYPE_SIZE[type];
    const n = type === TIFF.RATIONAL || type === TIFF.SRATIONAL ? values.length / 2 : values.length;
    const b = Buffer.alloc(unit * n);
    const each = type === TIFF.RATIONAL || type === TIFF.SRATIONAL ? 4 : unit;
    values.forEach((v, i) => {
      const at = i * each;
      if (each === 1) b[at] = v & 0xff;
      else if (each === 2) (le ? b.writeUInt16LE(v & 0xffff, at) : b.writeUInt16BE(v & 0xffff, at));
      else (le ? b.writeUInt32LE(v >>> 0, at) : b.writeUInt32BE(v >>> 0, at));
    });
    return b;
  };

  const writeIfd = (spec: TiffIfdSpec): number => {
    const fields = [...spec.fields].sort((a, b) => a.tag - b.tag);
    const at = out.reserve(2 + 12 * fields.length + 4);
    w16(fields.length, at);
    fields.forEach((f, i) => {
      const e = at + 2 + 12 * i;
      let type: number;
      let count: number;
      let bytes: Buffer;
      if ('values' in f) {
        type = f.type;
        bytes = encode(type, f.values);
        count = type === TIFF.RATIONAL || type === TIFF.SRATIONAL ? f.values.length / 2 : f.values.length;
      } else if ('ascii' in f) {
        type = TIFF.ASCII;
        bytes = Buffer.from(`${f.ascii}\0`, 'latin1');
        count = bytes.length;
      } else if ('bytes' in f) {
        type = TIFF.UNDEFINED;
        bytes = f.bytes;
        count = bytes.length;
      } else if ('raw' in f) {
        ({ type, count, bytes } = f.raw);
      } else if ('offsetOf' in f) {
        type = TIFF.LONG;
        count = 1;
        bytes = encode(TIFF.LONG, [out.put(f.offsetOf)]);
      } else if ('ifd' in f) {
        type = TIFF.LONG;
        count = 1;
        bytes = encode(TIFF.LONG, [writeIfd(f.ifd)]);
      } else {
        type = TIFF.LONG;
        count = f.ifds.length;
        bytes = encode(TIFF.LONG, f.ifds.map(writeIfd));
      }
      w16(f.tag, e);
      w16(type, e + 2);
      w32(count, e + 4);
      if (bytes.length <= 4) bytes.copy(out.buf, e + 8);
      else w32(out.put(bytes), e + 8);
    });
    w32(spec.next ? writeIfd(spec.next) : 0, at + 2 + 12 * fields.length);
    return at;
  };

  w32(writeIfd(ifd0), 4);
  return Buffer.from(out.buf.subarray(0, out.len));
}
