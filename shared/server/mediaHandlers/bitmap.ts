import { readFile, stat } from 'node:fs/promises';
import sharp, { type Sharp } from 'sharp';
import { derivedPng } from './derived';
import type { MediaHandler } from './index';

// BMP and ICO. sharp's bundled libvips has no loader for either, so this small decoder of our own
// turns them into pixels, and the derived cache keeps them as a PNG. Every offset and size read from
// the file is checked against the file before it is used, and the picture's size is capped.
//
// BMP: the Windows (40 to 124 byte) and OS/2 1.x (12 byte) headers; 1, 2, 4 and 8 bits per pixel with
// a palette; 16, 24 and 32 bits per pixel, plain or with bit masks; RLE4 and RLE8. Embedded JPEG or
// PNG (compression 4 and 5) and the OS/2 2.x header are refused.
// ICO (and CUR): the biggest picture in the file. A PNG one is handed to sharp, which reads PNG
// safely; a BMP one is decoded here, with its transparency mask.

/** RGBA pixels, row by row from the top. */
export interface Bitmap {
  width: number;
  height: number;
  data: Buffer;
}

/** Files bigger than this are refused, not read. */
export const BITMAP_MAX_BYTES = 256 * 1024 * 1024;
/** Pictures with more pixels than this are refused. */
export const BITMAP_MAX_PIXELS = 50_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class BitmapError extends Error {}
const bad = (what: string) => new BitmapError(what);

/** One colour channel picked out of a pixel by its bit mask, scaled to 0..255. */
function channel(mask: number): (v: number) => number {
  if (!mask) return () => 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const max = mask >>> shift;
  return (v) => Math.round((((v & mask) >>> shift) * 255) / max);
}

/**
 * Decodes a DIB (a BMP without its 14-byte file header) starting at `at` in `buf`. `pixels` is where
 * the pixel rows start (a BMP file says; in an icon they follow the palette). In an icon the header's
 * height covers the picture and its 1-bit transparency mask below it.
 */
function decodeDib(buf: Buffer, at: number, pixels: number | null, icon: boolean): Bitmap {
  const need = (end: number) => {
    if (end > buf.length || end < 0) throw bad('The file is cut short.');
  };
  need(at + 4);
  const headerSize = buf.readUInt32LE(at);
  let width: number;
  let rawHeight: number;
  let bpp: number;
  let compression = 0;
  let colorsUsed = 0;
  let paletteEntry = 4;
  if (headerSize === 12) {
    need(at + 12);
    width = buf.readUInt16LE(at + 4);
    rawHeight = buf.readInt16LE(at + 6);
    bpp = buf.readUInt16LE(at + 10);
    paletteEntry = 3;
  } else if ([40, 52, 56, 108, 124].includes(headerSize)) {
    need(at + headerSize);
    width = buf.readInt32LE(at + 4);
    rawHeight = buf.readInt32LE(at + 8);
    bpp = buf.readUInt16LE(at + 14);
    compression = buf.readUInt32LE(at + 16);
    colorsUsed = buf.readUInt32LE(at + 32);
  } else {
    throw bad('This kind of BMP is not supported.');
  }
  const topDown = rawHeight < 0;
  let height = Math.abs(rawHeight);
  if (icon) {
    if (topDown) throw bad('This icon is not valid.');
    height = Math.floor(height / 2);
  }
  if (width <= 0 || height <= 0) throw bad('The picture has no size.');
  if (width * height > BITMAP_MAX_PIXELS) throw bad('The picture is too large to open.');

  // Bit masks for 16 and 32 bits per pixel: given (BITFIELDS, ALPHABITFIELDS) or the defaults.
  let masks = bpp === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0xff0000, 0x00ff00, 0x0000ff, 0xff000000];
  let maskBytes = 0;
  if (compression === 3 || compression === 6) {
    if (bpp !== 16 && bpp !== 32) throw bad('This BMP is not valid.');
    const count = compression === 6 || headerSize >= 56 ? 4 : 3;
    const maskAt = at + 40;
    need(maskAt + count * 4);
    masks = [buf.readUInt32LE(maskAt), buf.readUInt32LE(maskAt + 4), buf.readUInt32LE(maskAt + 8), count === 4 ? buf.readUInt32LE(maskAt + 12) : 0];
    // With the 40-byte header the masks follow it; bigger headers hold them.
    if (headerSize === 40) maskBytes = count * 4;
  } else if (compression === 1) {
    if (bpp !== 8 || topDown) throw bad('This BMP is not valid.');
  } else if (compression === 2) {
    if (bpp !== 4 || topDown) throw bad('This BMP is not valid.');
  } else if (compression !== 0) {
    throw bad('This kind of BMP is not supported.');
  }
  if (![1, 2, 4, 8, 16, 24, 32].includes(bpp)) throw bad('This kind of BMP is not supported.');

  // The palette, as [r, g, b] (stored blue first).
  const palette: [number, number, number][] = [];
  const paletteAt = at + headerSize + maskBytes;
  if (bpp <= 8) {
    const count = colorsUsed || 1 << bpp;
    if (count > 256) throw bad('This BMP is not valid.');
    need(paletteAt + count * paletteEntry);
    for (let i = 0; i < count; i++) {
      const p = paletteAt + i * paletteEntry;
      palette.push([buf[p + 2], buf[p + 1], buf[p]]);
    }
  }
  const start = pixels ?? paletteAt + palette.length * paletteEntry;
  need(start);

  const data = Buffer.alloc(width * height * 4);
  const put = (x: number, row: number, r: number, g: number, b: number, a = 255) => {
    const o = (row * width + x) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  };
  const putIndex = (x: number, row: number, i: number) => {
    const c = palette[i] ?? [0, 0, 0];
    put(x, row, c[0], c[1], c[2]);
  };
  // Rows are stored from the bottom unless the height was negative.
  const rowOf = (y: number) => (topDown ? y : height - 1 - y);

  let usesAlpha = false;
  if (compression === 1 || compression === 2) {
    // RLE8 / RLE4. Pixels a "skip" passes over are left see-through.
    let x = 0;
    let y = 0;
    let p = start;
    const set = (i: number) => {
      if (x < width && y < height) putIndex(x, rowOf(y), i);
      x++;
    };
    while (p + 1 < buf.length && y < height) {
      const n = buf[p++];
      const v = buf[p++];
      if (n > 0) {
        for (let i = 0; i < n; i++) set(compression === 1 ? v : i % 2 === 0 ? v >> 4 : v & 15);
      } else if (v === 0) {
        x = 0;
        y++;
      } else if (v === 1) {
        break;
      } else if (v === 2) {
        need(p + 2);
        x += buf[p++];
        y += buf[p++];
      } else {
        const bytes = compression === 1 ? v : Math.ceil(v / 2);
        need(p + bytes);
        for (let i = 0; i < v; i++) set(compression === 1 ? buf[p + i] : i % 2 === 0 ? buf[p + (i >> 1)] >> 4 : buf[p + (i >> 1)] & 15);
        p += bytes + (bytes & 1);
      }
    }
  } else {
    const stride = Math.floor((bpp * width + 31) / 32) * 4;
    need(start + stride * height);
    const [rOf, gOf, bOf, aOf] = masks.map(channel);
    const hasAlphaMask = masks[3] !== 0;
    for (let y = 0; y < height; y++) {
      const rowAt = start + y * stride;
      const row = rowOf(y);
      for (let x = 0; x < width; x++) {
        if (bpp <= 8) {
          const bit = x * bpp;
          const byte = buf[rowAt + (bit >> 3)];
          putIndex(x, row, (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1));
        } else if (bpp === 24) {
          const p = rowAt + x * 3;
          put(x, row, buf[p + 2], buf[p + 1], buf[p]);
        } else {
          const v = bpp === 16 ? buf.readUInt16LE(rowAt + x * 2) : buf.readUInt32LE(rowAt + x * 4);
          const a = hasAlphaMask ? aOf(v) : 255;
          if (a !== 0) usesAlpha = usesAlpha || hasAlphaMask;
          put(x, row, rOf(v), gOf(v), bOf(v), a);
        }
      }
    }
    // An alpha byte that is 0 everywhere is unused (most 32-bit BMPs), not a see-through picture.
    if ((bpp === 16 || bpp === 32) && masks[3] !== 0 && !usesAlpha) {
      for (let o = 3; o < data.length; o += 4) data[o] = 255;
    }
    // An icon's 1-bit mask below the picture: a set bit is see-through. A 32-bit icon with a real
    // alpha channel uses that instead; a mask cut off is ignored.
    if (icon && !(bpp === 32 && usesAlpha)) {
      const maskStride = Math.floor((width + 31) / 32) * 4;
      const maskAt = start + stride * height;
      if (maskAt + maskStride * height <= buf.length) {
        for (let y = 0; y < height; y++) {
          const row = height - 1 - y;
          for (let x = 0; x < width; x++) {
            if ((buf[maskAt + y * maskStride + (x >> 3)] >> (7 - (x & 7))) & 1) data[(row * width + x) * 4 + 3] = 0;
          }
        }
      }
    }
  }
  return { width, height, data };
}

/** A BMP file's pixels. */
export function decodeBmp(buf: Buffer): Bitmap {
  if (buf.length < 18 || buf[0] !== 0x42 || buf[1] !== 0x4d) throw bad('This file is not a BMP.');
  const pixels = buf.readUInt32LE(10);
  if (pixels >= buf.length) throw bad('The file is cut short.');
  return decodeDib(buf, 14, pixels, false);
}

/** An icon file's biggest picture: PNG bytes (for sharp), or the pixels of a BMP one. */
export function decodeIco(buf: Buffer): Bitmap | { png: Buffer } {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || ![1, 2].includes(buf.readUInt16LE(2))) throw bad('This file is not an icon.');
  const count = buf.readUInt16LE(4);
  if (count === 0) throw bad('This icon has no pictures.');
  if (6 + count * 16 > buf.length) throw bad('The file is cut short.');
  let best: { area: number; bpp: number; offset: number; size: number } | null = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const area = (buf[e] || 256) * (buf[e + 1] || 256);
    const bpp = buf.readUInt16LE(e + 6);
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    if (size < 8 || offset + size > buf.length) continue;
    if (!best || area > best.area || (area === best.area && bpp > best.bpp)) best = { area, bpp, offset, size };
  }
  if (!best) throw bad('The file is cut short.');
  const image = buf.subarray(best.offset, best.offset + best.size);
  if (image.subarray(0, 8).equals(PNG_SIGNATURE)) return { png: image };
  return decodeDib(image, 0, null, true);
}

async function readCapped(file: string): Promise<Buffer> {
  if ((await stat(file)).size > BITMAP_MAX_BYTES) throw bad('This file is too large to open.');
  return readFile(file);
}

const toSharp = (b: Bitmap | { png: Buffer }): Sharp =>
  'png' in b ? sharp(b.png, { failOn: 'none', limitInputPixels: BITMAP_MAX_PIXELS }) : sharp(b.data, { raw: { width: b.width, height: b.height, channels: 4 } });

function bitmapHandler(id: string, decode: (buf: Buffer) => Bitmap | { png: Buffer }): MediaHandler {
  const image = async (file: string) => toSharp(decode(await readCapped(file)));
  return {
    id,
    preview: (file, ctx) => derivedPng(file, ctx, image),
    image,
  };
}

export const bmpHandler = bitmapHandler('bmp', decodeBmp);
export const icoHandler = bitmapHandler('ico', decodeIco);
