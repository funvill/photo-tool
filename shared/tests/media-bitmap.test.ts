// The small BMP and ICO decoder (shared/server/mediaHandlers/bitmap.ts), on files built here byte by
// byte: each kind of BMP it reads, icons with a BMP or PNG picture, and files that lie about themselves.
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { BITMAP_MAX_PIXELS, BitmapError, decodeBmp, decodeIco, type Bitmap } from '../server/mediaHandlers/bitmap';

/** A BMP file: 14-byte file header + `dib` (header, masks, palette) + `pixels`. */
function bmp(dib: Buffer, pixels: Buffer): Buffer {
  const file = Buffer.alloc(14);
  file.write('BM', 0, 'latin1');
  file.writeUInt32LE(14 + dib.length + pixels.length, 2);
  file.writeUInt32LE(14 + dib.length, 10);
  return Buffer.concat([file, dib, pixels]);
}

/** A 40-byte BITMAPINFOHEADER. */
function info(width: number, height: number, bpp: number, compression = 0, colorsUsed = 0): Buffer {
  const h = Buffer.alloc(40);
  h.writeUInt32LE(40, 0);
  h.writeInt32LE(width, 4);
  h.writeInt32LE(height, 8);
  h.writeUInt16LE(1, 12);
  h.writeUInt16LE(bpp, 14);
  h.writeUInt32LE(compression, 16);
  h.writeUInt32LE(colorsUsed, 32);
  return h;
}

const u32 = (...v: number[]) => Buffer.concat(v.map((n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }));
/** Palette entries, given as [r, g, b] (stored blue first, with a pad byte). */
const palette = (...c: [number, number, number][]) => Buffer.from(c.flatMap(([r, g, b]) => [b, g, r, 0]));
const px = (b: Bitmap, x: number, y: number) => [...b.data.subarray((y * b.width + x) * 4, (y * b.width + x) * 4 + 4)];

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];

describe('BMP', () => {
  it('reads 24 bits per pixel, bottom row first, with rows padded to 4 bytes', () => {
    // 2 × 2: top row red, blue; bottom row blue, red. 6 bytes per row, padded to 8.
    const bottom = Buffer.from([255, 0, 0, 0, 0, 255, 0, 0]); // blue (BGR 255,0,0), red (BGR 0,0,255)
    const top = Buffer.from([0, 0, 255, 255, 0, 0, 0, 0]); // red, blue
    const b = decodeBmp(bmp(info(2, 2, 24), Buffer.concat([bottom, top])));
    expect([b.width, b.height]).toEqual([2, 2]);
    expect(px(b, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(b, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(b, 0, 1)).toEqual([0, 0, 255, 255]);
    expect(px(b, 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it('reads a top-down BMP (negative height)', () => {
    const top = Buffer.from([0, 0, 255, 0]); // one red pixel, padded
    const bottom = Buffer.from([255, 0, 0, 0]); // one blue pixel
    const b = decodeBmp(bmp(info(1, -2, 24), Buffer.concat([top, bottom])));
    expect(px(b, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(b, 0, 1)).toEqual([0, 0, 255, 255]);
  });

  it('reads 1, 4 and 8 bits per pixel through the palette', () => {
    // 1 bit: 3 pixels in one row: 1, 0, 1 → blue, red, blue.
    const one = decodeBmp(bmp(Buffer.concat([info(3, 1, 1), palette(RED, BLUE)]), Buffer.from([0b10100000, 0, 0, 0])));
    expect([px(one, 0, 0), px(one, 1, 0), px(one, 2, 0)]).toEqual([[0, 0, 255, 255], [255, 0, 0, 255], [0, 0, 255, 255]]);
    // 4 bits, two colours used: indices 1, 0.
    const four = decodeBmp(bmp(Buffer.concat([info(2, 1, 4, 0, 2), palette(RED, BLUE)]), Buffer.from([0x10, 0, 0, 0])));
    expect([px(four, 0, 0), px(four, 1, 0)]).toEqual([[0, 0, 255, 255], [255, 0, 0, 255]]);
    // 8 bits: an index past the palette is black, not a crash.
    const eight = decodeBmp(bmp(Buffer.concat([info(2, 1, 8, 0, 2), palette(RED, BLUE)]), Buffer.from([1, 200, 0, 0])));
    expect([px(eight, 0, 0), px(eight, 1, 0)]).toEqual([[0, 0, 255, 255], [0, 0, 0, 255]]);
  });

  it('reads RLE8 and RLE4', () => {
    // RLE8, 4 × 2: bottom row: 4 × index 1; end of line; top row: absolute run 0,1,0 then 1 × 0; end.
    const rle8 = Buffer.from([4, 1, 0, 0, 0, 3, 0, 1, 0, 0, 1, 0, 0, 1]);
    const a = decodeBmp(bmp(Buffer.concat([info(4, 2, 8, 1, 2), palette(RED, BLUE)]), rle8));
    expect([0, 1, 2, 3].map((x) => px(a, x, 1))).toEqual([BLUE, BLUE, BLUE, BLUE].map((c) => [...c, 255]));
    expect([0, 1, 2, 3].map((x) => px(a, x, 0))).toEqual([RED, BLUE, RED, RED].map((c) => [...c, 255]));
    // RLE4, 3 × 1: a run of 3 alternating 1, 0, 1; end of picture.
    const b = decodeBmp(bmp(Buffer.concat([info(3, 1, 4, 2, 2), palette(RED, BLUE)]), Buffer.from([3, 0x10, 0, 1])));
    expect([0, 1, 2].map((x) => px(b, x, 0))).toEqual([BLUE, RED, BLUE].map((c) => [...c, 255]));
    // A delta skips pixels: they stay see-through.
    const c = decodeBmp(bmp(Buffer.concat([info(3, 1, 8, 1, 2), palette(RED, BLUE)]), Buffer.from([0, 2, 2, 0, 1, 1, 0, 1])));
    expect([px(c, 0, 0)[3], px(c, 1, 0)[3], px(c, 2, 0)]).toEqual([0, 0, [0, 0, 255, 255]]);
  });

  it('reads 16 bits (5-5-5) and 32 bits with bit masks, and their alpha', () => {
    // 16 bits, default 5-5-5: pure red is 0x7c00.
    const r16 = decodeBmp(bmp(info(1, 1, 16), Buffer.from([0x00, 0x7c, 0, 0])));
    expect(px(r16, 0, 0)).toEqual([255, 0, 0, 255]);
    // 16 bits with 5-6-5 masks: pure green is 0x07e0.
    const g16 = decodeBmp(bmp(Buffer.concat([info(1, 1, 16, 3), u32(0xf800, 0x07e0, 0x001f)]), Buffer.from([0xe0, 0x07, 0, 0])));
    expect(px(g16, 0, 0)).toEqual([0, 255, 0, 255]);
    // 32 bits, plain BGRA: half see-through blue.
    const half = decodeBmp(bmp(info(1, 1, 32), Buffer.from([255, 0, 0, 128])));
    expect(px(half, 0, 0)).toEqual([0, 0, 255, 128]);
    // 32 bits whose alpha byte is 0 everywhere: unused, so opaque.
    const unused = decodeBmp(bmp(info(2, 1, 32), Buffer.from([255, 0, 0, 0, 0, 0, 255, 0])));
    expect([px(unused, 0, 0), px(unused, 1, 0)]).toEqual([[0, 0, 255, 255], [255, 0, 0, 255]]);
    // A 108-byte (V4) header holding RGBA masks.
    const v4 = Buffer.alloc(108);
    info(1, 1, 32, 3).copy(v4);
    v4.writeUInt32LE(108, 0);
    u32(0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000).copy(v4, 40);
    const rgba = decodeBmp(bmp(v4, Buffer.from([10, 20, 30, 255])));
    expect(px(rgba, 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it('reads the OS/2 12-byte header with a 3-byte palette', () => {
    const core = Buffer.alloc(12);
    core.writeUInt32LE(12, 0);
    core.writeUInt16LE(1, 4);
    core.writeInt16LE(1, 6);
    core.writeUInt16LE(1, 8);
    core.writeUInt16LE(1, 10);
    const b = decodeBmp(bmp(Buffer.concat([core, Buffer.from([0, 0, 255, 255, 0, 0])]), Buffer.from([0x80, 0, 0, 0])));
    expect(px(b, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('refuses files that lie about themselves', () => {
    const good = bmp(info(2, 2, 24), Buffer.alloc(16));
    expect(() => decodeBmp(Buffer.from('not a bmp at all, really not'))).toThrow(/not a BMP/);
    expect(() => decodeBmp(good.subarray(0, good.length - 1))).toThrow(/cut short/);
    expect(() => decodeBmp(bmp(info(0, 2, 24), Buffer.alloc(16)))).toThrow(/no size/);
    expect(() => decodeBmp(bmp(info(100_000, 100_000, 24), Buffer.alloc(16)))).toThrow(/too large/);
    expect(BITMAP_MAX_PIXELS).toBeLessThan(100_000 * 100_000);
    expect(() => decodeBmp(bmp(info(2, 2, 24, 4), Buffer.alloc(16)))).toThrow(/not supported/); // embedded JPEG
    expect(() => decodeBmp(bmp(info(2, 2, 7), Buffer.alloc(16)))).toThrow(/not supported/);
    expect(() => decodeBmp(bmp(info(2, -2, 8, 1), Buffer.alloc(16)))).toThrow(/not valid/); // top-down RLE
    expect(() => decodeBmp(bmp(Buffer.concat([info(2, 1, 8, 0, 300)]), Buffer.alloc(8)))).toThrow(/not valid/);
    // A palette that runs past the end of the file.
    expect(() => decodeBmp(bmp(info(2, 1, 8, 0, 200), Buffer.alloc(4)))).toThrow(/cut short/);
    // A pixel offset past the end of the file.
    const far = bmp(info(1, 1, 24), Buffer.alloc(4));
    far.writeUInt32LE(far.length + 10, 10);
    expect(() => decodeBmp(far)).toThrow(/cut short/);
  });
});

/** An icon file holding these pictures (each `[declared side, bytes]`). */
function ico(...pictures: [number, number, Buffer][]): Buffer {
  const header = Buffer.alloc(6 + pictures.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pictures.length, 4);
  let offset = header.length;
  pictures.forEach(([side, bpp, data], i) => {
    const e = 6 + i * 16;
    header[e] = side % 256;
    header[e + 1] = side % 256;
    header.writeUInt16LE(bpp, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pictures.map(([, , d]) => d)]);
}

describe('ICO', () => {
  it('takes the biggest picture, and hands a PNG one over as it is', async () => {
    const png = await sharp({ create: { width: 48, height: 48, channels: 4, background: '#00ff0080' } }).png().toBuffer();
    // A 2 × 2 24-bit BMP picture (height doubled for the mask), all red, no mask bits set.
    const dib = Buffer.concat([info(2, 4, 24), Buffer.from([0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0]), Buffer.alloc(8)]);
    const out = decodeIco(ico([2, 24, dib], [48, 32, png]));
    expect('png' in out && out.png.equals(png)).toBe(true);
  });

  it('decodes a BMP picture with its 1-bit transparency mask', () => {
    // 2 × 2, 24-bit, all red; the mask (bottom row first) makes the bottom-left pixel see-through.
    const pixels = Buffer.from([0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
    const mask = Buffer.from([0b10000000, 0, 0, 0, 0, 0, 0, 0]);
    const out = decodeIco(ico([2, 24, Buffer.concat([info(2, 4, 24), pixels, mask])])) as Bitmap;
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(px(out, 0, 1)).toEqual([255, 0, 0, 0]);
    expect(px(out, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('uses a 32-bit picture\'s own alpha over its mask', () => {
    const pixels = Buffer.from([0, 0, 255, 255, 0, 0, 255, 64]); // 2 × 1: opaque red, faint red
    const mask = Buffer.from([0b11000000, 0, 0, 0]);
    const out = decodeIco(ico([2, 32, Buffer.concat([info(2, 2, 32), pixels, mask])])) as Bitmap;
    expect([px(out, 0, 0)[3], px(out, 1, 0)[3]]).toEqual([255, 64]);
  });

  it('refuses icons that lie about themselves', () => {
    expect(() => decodeIco(Buffer.from([0, 0, 1, 0, 0, 0]))).toThrow(/no pictures/);
    expect(() => decodeIco(Buffer.from([0, 0, 9, 0, 1, 0]))).toThrow(/not an icon/);
    expect(() => decodeIco(Buffer.from([0, 0, 1, 0, 5, 0, 1, 2]))).toThrow(/cut short/);
    // An entry pointing past the end of the file.
    const bad = ico([2, 24, Buffer.alloc(20)]);
    bad.writeUInt32LE(10_000, 6 + 12);
    expect(() => decodeIco(bad)).toThrow(/cut short/);
  });
});

describe('hostile and unusual BMP and ICO files', () => {
  it('refuses a tiny RLE file that claims a huge picture, before making room for it', () => {
    // 60 bytes claiming 7000 × 7000: an end-of-picture straight away.
    const tiny = bmp(Buffer.concat([info(7000, 7000, 8, 1, 2), palette(RED, BLUE)]), Buffer.from([0, 1]));
    expect(tiny.length).toBeLessThan(80);
    const alloc = vi.spyOn(Buffer, 'alloc');
    try {
      expect(() => decodeBmp(tiny)).toThrow(BitmapError);
      expect(alloc.mock.calls.filter(([n]) => (n as number) > 1_000_000)).toEqual([]);
    } finally {
      alloc.mockRestore();
    }
  });

  it('refuses an uncompressed file too short for its pixels, before making room for them', () => {
    const short = bmp(info(7000, 7000, 24), Buffer.alloc(16));
    const alloc = vi.spyOn(Buffer, 'alloc');
    try {
      expect(() => decodeBmp(short)).toThrow(/cut short/);
      expect(alloc.mock.calls.filter(([n]) => (n as number) > 1_000_000)).toEqual([]);
    } finally {
      alloc.mockRestore();
    }
  });

  it('reads 2 bits per pixel, and top-down 8 and 32 bits per pixel', () => {
    const two = decodeBmp(bmp(Buffer.concat([info(3, 1, 2, 0, 4), palette(RED, BLUE, [0, 255, 0], [9, 9, 9])]), Buffer.from([0b01101100, 0, 0, 0])));
    expect([0, 1, 2].map((x) => px(two, x, 0))).toEqual([[0, 0, 255, 255], [0, 255, 0, 255], [9, 9, 9, 255]]);
    const eight = decodeBmp(bmp(Buffer.concat([info(1, -2, 8, 0, 2), palette(RED, BLUE)]), Buffer.from([0, 0, 0, 0, 1, 0, 0, 0])));
    expect([px(eight, 0, 0), px(eight, 0, 1)]).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
    const thirtyTwo = decodeBmp(bmp(info(1, -2, 32), Buffer.from([0, 0, 255, 255, 255, 0, 0, 255])));
    expect([px(thirtyTwo, 0, 0), px(thirtyTwo, 0, 1)]).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
  });

  it('reads an RLE4 absolute run of odd length, word padded, and refuses one cut short', () => {
    // 3 pixels absolute (2 bytes, padded to 4), then end of picture.
    const ok = decodeBmp(bmp(Buffer.concat([info(3, 1, 4, 2, 2), palette(RED, BLUE)]), Buffer.from([0, 3, 0x10, 0x10, 0, 1])));
    expect([0, 1, 2].map((x) => px(ok, x, 0))).toEqual([BLUE, RED, BLUE].map((c) => [...c, 255]));
    expect(() => decodeBmp(bmp(Buffer.concat([info(8, 1, 8, 1, 2), palette(RED, BLUE)]), Buffer.from([0, 8, 1, 1])))).toThrow(/cut short/);
  });

  it('stops at a delta that jumps past the last row', () => {
    const b = decodeBmp(bmp(Buffer.concat([info(2, 2, 8, 1, 2), palette(RED, BLUE)]), Buffer.from([0, 2, 0, 200, 2, 1, 0, 1])));
    expect([b.width, b.height]).toEqual([2, 2]);
    expect(px(b, 0, 0)[3]).toBe(0);
  });

  it('reads ALPHABITFIELDS, and 40-byte BITFIELDS with masks using bit 31', () => {
    const alpha = decodeBmp(bmp(Buffer.concat([info(1, 1, 32, 6), u32(0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000)]), Buffer.from([30, 20, 10, 128])));
    expect(px(alpha, 0, 0)).toEqual([10, 20, 30, 128]);
    // Red in the top byte (bit 31 set): read unsigned.
    const top = decodeBmp(bmp(Buffer.concat([info(1, 1, 32, 3), u32(0xff000000, 0x00ff0000, 0x0000ff00)]), Buffer.from([0, 0, 0, 255])));
    expect(px(top, 0, 0)).toEqual([255, 0, 0, 255]);
    // A zero mask gives 0 for that channel.
    const zero = decodeBmp(bmp(Buffer.concat([info(1, 1, 16, 3), u32(0, 0x07e0, 0x001f)]), Buffer.from([0xff, 0xff, 0, 0])));
    expect(px(zero, 0, 0)).toEqual([0, 255, 255, 255]);
  });

  it('refuses a negative width and the most negative height', () => {
    expect(() => decodeBmp(bmp(info(-2, 2, 24), Buffer.alloc(16)))).toThrow(BitmapError);
    expect(() => decodeBmp(bmp(info(2, -2147483648, 24), Buffer.alloc(16)))).toThrow(BitmapError);
  });

  it('reads the OS/2 header at 24 bits per pixel', () => {
    const core = Buffer.alloc(12);
    core.writeUInt32LE(12, 0);
    core.writeUInt16LE(1, 4);
    core.writeInt16LE(1, 6);
    core.writeUInt16LE(1, 8);
    core.writeUInt16LE(24, 10);
    expect(px(decodeBmp(bmp(core, Buffer.from([255, 0, 0, 0]))), 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('reads a 4-bit palette icon with its mask, and masks a 32-bit icon whose alpha is all 0', () => {
    // 2 × 1, 4 bits: indices 1, 0; the mask makes the second pixel see-through.
    const four = decodeIco(ico([2, 4, Buffer.concat([info(2, 2, 4, 0, 2), palette(RED, BLUE), Buffer.from([0x10, 0, 0, 0]), Buffer.from([0b01000000, 0, 0, 0])])])) as Bitmap;
    expect([px(four, 0, 0), px(four, 1, 0)]).toEqual([[0, 0, 255, 255], [255, 0, 0, 0]]);
    const zeroAlpha = decodeIco(ico([2, 32, Buffer.concat([info(2, 2, 32), Buffer.from([0, 0, 255, 0, 0, 0, 255, 0]), Buffer.from([0b10000000, 0, 0, 0])])])) as Bitmap;
    expect([px(zeroAlpha, 0, 0)[3], px(zeroAlpha, 1, 0)[3]]).toEqual([0, 255]);
  });

  it('refuses an icon picture with more pixels than the cap', () => {
    expect(() => decodeIco(ico([0, 32, Buffer.concat([info(100_000, 200_000, 32), Buffer.alloc(64)])]))).toThrow(/too large/);
  });

  it('survives random damage: a picture of the size it says, or a BitmapError', async () => {
    const seeds = [
      bmp(Buffer.concat([info(5, 3, 8, 0, 2), palette(RED, BLUE)]), Buffer.alloc(24, 1)),
      bmp(Buffer.concat([info(4, 2, 8, 1, 2), palette(RED, BLUE)]), Buffer.from([4, 1, 0, 0, 0, 3, 0, 1, 0, 0, 1, 0, 0, 1])),
      bmp(Buffer.concat([info(3, 2, 16, 3), u32(0xf800, 0x07e0, 0x001f)]), Buffer.alloc(16, 7)),
      bmp(info(3, 3, 24), Buffer.alloc(36, 200)),
      ico([2, 32, Buffer.concat([info(2, 4, 32), Buffer.alloc(16, 9), Buffer.alloc(8)])]),
    ];
    let state = 12345;
    const rnd = () => ((state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 20_000; i++) {
      const seed = seeds[i % seeds.length];
      const b = Buffer.from(seed);
      const hits = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < hits; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const cut = rnd() < 0.2 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
      try {
        const out = i % seeds.length === 4 ? decodeIco(cut) : decodeBmp(cut);
        if ('data' in out) expect(out.data.length).toBe(out.width * out.height * 4);
      } catch (e) {
        expect(e, `case ${i}`).toBeInstanceOf(BitmapError);
      }
    }
  });
});
