// Phase 3 of #6: camera RAW files, shown through their embedded JPEG preview. The finder
// (rawPreview.ts) is pure, so it is tried here against every layout, then against damaged and hostile
// files byte by byte; the handler (raw.ts) is tried through workingFile and readMetadata, as the
// scanners use it. Every RAW here is synthetic (rawSamples.ts): no real camera file is used.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_FORMATS } from '../core/mediaFormats';
import { handlerFor } from '../server/mediaHandlers';
import { extractRawPreview, NoPreviewError, noPreviewPicture } from '../server/mediaHandlers/raw';
import { findRawPreviews, jpegAt, rawContainer, rawExifBlock, searchJpegs } from '../server/mediaHandlers/rawPreview';
import { filler, makeRawSample, RAW_SAMPLE_LAYOUT, rawSample, type RawSampleLayout } from '../server/mediaHandlers/rawSamples';
import { TIFF, TiffView, tiffHeader, writeTiff } from '../server/mediaHandlers/tiff';
import { hashFile, orientedSize, readMetadata, workingFile } from '../server/media';

const RAW_IDS = MEDIA_FORMATS.filter((f) => f.kind === 'raw').map((f) => f.id);
const META = { make: 'Synthetic', model: 'RAW 1', date: '2026:05:06 07:08:09', gps: { lat: 49.25, lon: -123.1 } };

/** The upright picture: 300 × 200, red on the left half and blue on the right. */
const upright = () => sharp({ create: { width: 300, height: 200, channels: 3, background: '#ff0000' } })
  .composite([{ input: { create: { width: 150, height: 200, channels: 3, background: '#0000ff' } }, left: 150, top: 0 }])
  .png().toBuffer();

/** The colour of the middle of the left half and of the right half of an upright picture. */
async function halves(img: Sharp): Promise<[number[], number[]]> {
  const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number) => {
    const o = (Math.floor(info.height / 2) * info.width + x) * 3;
    return [data[o], data[o + 1], data[o + 2]];
  };
  return [at(Math.floor(info.width / 4)), at(Math.floor((3 * info.width) / 4))];
}
const isRed = (c: number[]) => c[0] > 180 && c[1] < 80 && c[2] < 80;
const isBlue = (c: number[]) => c[2] > 180 && c[0] < 80 && c[1] < 80;

let root: string;
let dataDir: string;
let picture: Buffer;
/** The picture stored turned 90° counter-clockwise, as a camera held upright on its side stores it (orientation 6). */
let onItsSide: Buffer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'media-raw-'));
  dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'derived'), { recursive: true });
  picture = await upright();
  onItsSide = await sharp(picture).rotate(-90).png().toBuffer();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
async function writeSample(id: string, bytes: Buffer): Promise<string> {
  const dir = join(root, `f${n++}`);
  mkdirSync(dir);
  const file = join(dir, `IMG_0001.${id}`);
  writeFileSync(file, bytes);
  return file;
}
const work = (file: string) => workingFile(file, dataDir, () => hashFile(file));

describe('the TIFF structure reader and writer', () => {
  it('reads back what it wrote, in both byte orders, with values inline and out of line', () => {
    for (const le of [true, false]) {
      const blob = Buffer.from('0123456789');
      const buf = writeTiff({ fields: [{ tag: 0x010f, ascii: 'Maker' }, { tag: 0x0112, type: TIFF.SHORT, values: [6] }, { tag: 0x0201, offsetOf: blob }, { tag: 0x0202, type: TIFF.LONG, values: [blob.length] }], next: { fields: [{ tag: 0x0100, type: TIFF.LONG, values: [7] }] } }, { le });
      const h = tiffHeader(buf)!;
      expect(h.le).toBe(le);
      const view = new TiffView(buf, 0, le);
      const ifd = view.readIfd(h.ifd0)!;
      expect(view.bytes(ifd.entries.get(0x010f)!).toString('latin1')).toBe('Maker\0');
      expect(view.int(ifd.entries.get(0x0112))).toBe(6);
      const off = view.int(ifd.entries.get(0x0201))!;
      expect(buf.subarray(off, off + 10)).toEqual(blob);
      expect(view.int(view.readIfd(ifd.next)!.entries.get(0x0100))).toBe(7);
    }
  });

  it('drops an entry whose value lies outside the file, and an IFD that does not fit', () => {
    const buf = writeTiff({ fields: [{ tag: 0x010f, ascii: 'A long maker name' }] });
    const view = new TiffView(buf, 0, true);
    const h = tiffHeader(buf)!;
    // Point the ASCII value past the end, and give it a count whose bytes overflow 32 bits.
    const e = h.ifd0 + 2;
    buf.writeUInt32LE(buf.length + 100, e + 8);
    expect(view.readIfd(h.ifd0)!.entries.has(0x010f)).toBe(false);
    buf.writeUInt16LE(TIFF.DOUBLE, e + 2);
    buf.writeUInt32LE(0xffffffff, e + 4);
    buf.writeUInt32LE(8, e + 8);
    expect(view.readIfd(h.ifd0)!.entries.has(0x010f)).toBe(false);
    // An IFD claiming more entries than the file holds is not read at all.
    buf.writeUInt16LE(900, h.ifd0);
    expect(view.readIfd(h.ifd0)).toBeNull();
    expect(view.readIfd(buf.length - 1)).toBeNull();
    expect(view.readIfd(2 ** 40)).toBeNull();
  });
});

describe('every RAW format, from a synthetic file of its layout', () => {
  it('has a sample layout for every RAW extension', () => {
    expect(Object.keys(RAW_SAMPLE_LAYOUT).sort()).toEqual([...RAW_IDS].sort());
  });

  for (const id of RAW_IDS) {
    describe(`.${id} (${RAW_SAMPLE_LAYOUT[id]} layout)`, () => {
      let file: string;
      beforeAll(async () => {
        file = await writeSample(id, await makeRawSample(id, { picture, previewSide: 300, ...META }));
      });

      it('finds the big preview first: not the thumbnail, not the lossless sensor data', () => {
        const { candidates } = findRawPreviews(readFileSync(file));
        expect(candidates.length).toBeGreaterThan(0);
        expect([candidates[0].width, candidates[0].height]).toEqual([300, 200]);
        for (const c of candidates) expect([0xc0, 0xc1, 0xc2]).toContain(c.sof);
      });

      it('makes the working image from the preview, once, in the derived cache', async () => {
        const w = await work(file);
        expect(w.derived).toBe(join(dataDir, 'derived', `${await hashFile(file)}.preview.jpg`));
        expect(w.path).toBe(w.derived);
        expect((await sharp(w.path).metadata()).format).toBe('jpeg');
        expect(await orientedSize(w.path)).toMatchObject({ width: 300, height: 200 });
        const [left, right] = await halves(sharp(w.path).rotate());
        expect(isRed(left) && isBlue(right), `${left} ${right}`).toBe(true);
        expect((await work(file)).path).toBe(w.path);
      });

      it('gives an upright picture in memory (the editor\'s shelf previews)', async () => {
        const img = await handlerFor(file)!.image(file);
        const { info } = await img.clone().png().toBuffer({ resolveWithObject: true });
        expect([info.width, info.height]).toEqual([300, 200]);
      });

      it('reads the date, the camera and the place from the RAW', async () => {
        const meta = await readMetadata(file);
        expect(meta.capturedAt).toBe('2026-05-06T07:08:09');
        expect(meta.camera).toBe('Synthetic RAW 1');
        expect(meta.gpsLat).toBeCloseTo(49.25, 3);
        expect(meta.gpsLon).toBeCloseTo(-123.1, 3);
      });
    });
  }
});

describe('orientation', () => {
  // The camera was held on its side: the preview is stored turned, and the RAW says 6 ("turn 90° to view").
  const layouts = RAW_IDS.filter((id) => !['raf', 'crw', 'x3f', 'iiq'].includes(id));
  for (const id of layouts) {
    it(`.${id}: the RAW's own orientation is applied once, over a different one in the preview`, async () => {
      const file = await writeSample(id, await makeRawSample(id, { picture: onItsSide, previewSide: 300, orientation: 6, previewOrientation: 3 }));
      const w = await work(file);
      expect(await orientedSize(w.path)).toMatchObject({ width: 300, height: 200 });
      const [left, right] = await halves(sharp(w.path).rotate());
      expect(isRed(left) && isBlue(right), `${left} ${right}`).toBe(true);
      const mem = await halves(await handlerFor(file)!.image(file));
      expect(isRed(mem[0]) && isBlue(mem[1])).toBe(true);
    });
  }

  for (const id of ['raf', 'crw', 'x3f', 'iiq']) {
    it(`.${id}: with no orientation of its own, the preview's is used`, async () => {
      const file = await writeSample(id, await makeRawSample(id, { picture: onItsSide, previewSide: 300, orientation: 6 }));
      expect(await orientedSize((await work(file)).path)).toMatchObject({ width: 300, height: 200 });
    });
  }
});

describe('RAW files with no usable preview', () => {
  it('throws NoPreviewError, remembers that, and gives a placeholder picture', async () => {
    const file = await writeSample('nef', filler(20_000, 99));
    await expect(work(file)).rejects.toBeInstanceOf(NoPreviewError);
    const hash = await hashFile(file);
    expect(existsSync(join(dataDir, 'derived', `${hash}.no-preview`))).toBe(true);
    // Asked again: the same answer, from the note, without reading the file.
    await expect(work(file)).rejects.toBeInstanceOf(NoPreviewError);
    const ph = await noPreviewPicture(join(dataDir, 'derived'));
    expect(await sharp(ph).metadata()).toMatchObject({ format: 'jpeg', width: 1200, height: 800 });
    // The editor's shelf shows the placeholder too, rather than failing.
    const img = await handlerFor(file)!.image(file);
    expect((await img.metadata()).width).toBe(1200);
  });

  it('never hands sharp an SVG: neither a whole file of one, nor one where a preview should be', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><image href="secret.jpg" width="900" height="900"/></svg>');
    for (const id of ['dng', 'cr2', 'arw', 'cr3', 'raf', 'x3f']) {
      const whole = await writeSample(id, svg);
      writeFileSync(join(whole, '..', 'secret.jpg'), await sharp(picture).jpeg().toBuffer());
      await expect(work(whole), id).rejects.toBeInstanceOf(NoPreviewError);
    }
    const pointing = writeTiff({ fields: [{ tag: 0x0201, offsetOf: svg }, { tag: 0x0202, type: TIFF.LONG, values: [svg.length] }] });
    expect(findRawPreviews(pointing).candidates).toEqual([]);
    await expect(work(await writeSample('dng', pointing))).rejects.toBeInstanceOf(NoPreviewError);
  });

  it('refuses a damaged preview it can\'t decode, and falls back to a smaller one that decodes', async () => {
    const big = await sharp(picture).resize(300).jpeg().toBuffer();
    const thumb = await sharp(picture).resize(160).jpeg().toBuffer();
    // The big preview cut after its headers: its frame header still says 300 × 200.
    const cut = big.subarray(0, Math.floor(big.length / 3));
    const file = await writeSample('arw', rawSample('arw', { preview: cut, thumb }));
    expect(findRawPreviews(readFileSync(file)).candidates[0].width).toBe(300);
    expect(await orientedSize((await work(file)).path)).toMatchObject({ width: 160 });
  });
});

describe('hostile and truncated files: the finder never throws, never reads outside the file', () => {
  let small: Map<RawSampleLayout, Buffer>;
  beforeAll(async () => {
    const tiny = await sharp(picture).resize(24).jpeg({ quality: 50 }).toBuffer();
    const tinier = await sharp(picture).resize(12).jpeg({ quality: 50 }).toBuffer();
    small = new Map();
    for (const layout of new Set(Object.values(RAW_SAMPLE_LAYOUT))) small.set(layout, rawSample(layout, { preview: tiny, thumb: tinier, ...META, orientation: 6 }));
  });

  const checkBounds = (buf: Buffer) => {
    const r = findRawPreviews(buf);
    for (const c of r.candidates) {
      expect(c.offset).toBeGreaterThanOrEqual(0);
      expect(c.offset + c.length).toBeLessThanOrEqual(buf.length);
      expect(buf[c.offset]).toBe(0xff);
      expect(buf[c.offset + 1]).toBe(0xd8);
    }
    expect(r.orientation === null || (r.orientation >= 1 && r.orientation <= 8)).toBe(true);
    rawExifBlock(buf);
  };

  it('survives every truncation of every layout', () => {
    for (const [layout, buf] of small) {
      for (let len = 0; len <= buf.length; len += len < 2048 ? 1 : 7) {
        try {
          checkBounds(buf.subarray(0, len));
        } catch (e) {
          throw new Error(`${layout} cut to ${len} bytes: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  });

  it('survives random damage to every layout', () => {
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (const [layout, buf] of small) {
      for (let round = 0; round < 400; round++) {
        const b = Buffer.from(buf);
        for (let k = 0; k < 1 + Math.floor(rnd() * 8); k++) b[Math.floor(rnd() * Math.min(b.length, round % 2 ? b.length : 600))] = Math.floor(rnd() * 256);
        try {
          checkBounds(b);
        } catch (e) {
          throw new Error(`${layout} round ${round}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  });

  it('follows an IFD loop, a SubIFD pointing to itself and a long chain only so far', () => {
    const buf = writeTiff({ fields: [{ tag: 0x0112, type: TIFF.SHORT, values: [3] }] });
    const h = tiffHeader(buf)!;
    const n = buf.readUInt16LE(h.ifd0);
    buf.writeUInt32LE(h.ifd0, h.ifd0 + 2 + 12 * n);
    expect(findRawPreviews(buf).orientation).toBe(3);
    // SubIFDs (several, all IFD0 itself) and the Exif IFD pointing back.
    const loop = writeTiff({ fields: [{ tag: 0x014a, type: TIFF.LONG, values: [8, 8, 8, 8] }, { tag: 0x8769, type: TIFF.LONG, values: [8] }] });
    expect(findRawPreviews(loop).candidates).toEqual([]);
    // A chain of 5000 IFDs: done in no time, with only the first ones read.
    let spec = { fields: [{ tag: 0x0100, type: TIFF.LONG, values: [1] }] } as Parameters<typeof writeTiff>[0];
    for (let i = 0; i < 5000; i++) spec = { fields: [{ tag: 0x0100, type: TIFF.LONG, values: [i] }], next: spec };
    const t = Date.now();
    findRawPreviews(writeTiff(spec));
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('turns down JPEG pointers and lengths that run outside the file', () => {
    const big = writeTiff({ fields: [{ tag: 0x0201, type: TIFF.LONG, values: [0xfffffff0] }, { tag: 0x0202, type: TIFF.LONG, values: [0xffffffff] }, { tag: 0x0111, type: TIFF.LONG, values: [4, 0xffffff00] }, { tag: 0x0117, type: TIFF.LONG, values: [0xffffff00, 0xffffffff] }] });
    expect(findRawPreviews(big).candidates).toEqual([]);
  });

  it('reads only the JPEG frames it can show, with sizes inside the segment', () => {
    const jpeg = (sof: number, precision: number, w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, sof, 0x00, 0x0b, precision, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
    expect(jpegAt(jpeg(0xc0, 8, 640, 480), 0, 15)).toMatchObject({ width: 640, height: 480 });
    expect(jpegAt(jpeg(0xc2, 8, 640, 480), 0, 15)).toMatchObject({ sof: 0xc2 });
    expect(jpegAt(jpeg(0xc3, 8, 640, 480), 0, 15)).toBeNull();
    expect(jpegAt(jpeg(0xc0, 12, 640, 480), 0, 15)).toBeNull();
    expect(jpegAt(jpeg(0xc0, 8, 0, 480), 0, 15)).toBeNull();
    expect(jpegAt(jpeg(0xc0, 8, 65535, 65535), 0, 15)).toBeNull();
    // The segment runs past the bytes it may take.
    expect(jpegAt(jpeg(0xc0, 8, 640, 480), 0, 12)).toBeNull();
    expect(jpegAt(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]), 0, 6)).toBeNull();
    expect(jpegAt(jpeg(0xc0, 8, 640, 480), -1, 15)).toBeNull();
    expect(jpegAt(jpeg(0xc0, 8, 640, 480), 3, 2 ** 60)).toBeNull();
  });

  it('looks at a bounded number of start markers in a file full of them', () => {
    const buf = Buffer.alloc(3_000_000);
    for (let i = 0; i + 3 <= buf.length; i += 3) buf.set([0xff, 0xd8, 0xff], i);
    const t = Date.now();
    expect(searchJpegs(buf)).toEqual([]);
    expect(findRawPreviews(buf).candidates).toEqual([]);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('copes with ISO boxes that are empty, too big, 64-bit, or nested past the file', () => {
    const box = (size: number, type: string, body = Buffer.alloc(0)) => {
      const b = Buffer.alloc(8);
      b.writeUInt32BE(size);
      b.write(type, 4, 'latin1');
      return Buffer.concat([b, body]);
    };
    const ftyp = box(16, 'ftyp', Buffer.from('crx \0\0\0\x01', 'latin1'));
    for (const rest of [
      box(0, 'moov'), box(1, 'moov', Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), box(4, 'moov'), box(0xffffffff, 'moov'),
      box(40, 'moov', box(32, 'uuid', Buffer.alloc(8))), box(24, 'moov', box(16, 'trak', box(8, 'mdia'))),
    ]) {
      const buf = Buffer.concat([ftyp, rest]);
      expect(rawContainer(buf)).toBe('cr3');
      checkBounds(buf);
    }
  });

  it('copes with a RAF header that points anywhere', () => {
    const head = Buffer.alloc(100);
    head.write('FUJIFILMCCD-RAW ', 0, 'latin1');
    head.writeUInt32BE(0xfffffff0, 84);
    head.writeUInt32BE(0xffffffff, 88);
    expect(rawContainer(head)).toBe('raf');
    checkBounds(head);
    expect(rawContainer(head.subarray(0, 50))).toBe('raf');
    checkBounds(head.subarray(0, 50));
  });

  it('gives every RAW extension a clean answer for empty, junk, cut and SVG files: a picture or NoPreviewError', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>');
    for (const id of RAW_IDS) {
      const sample = await makeRawSample(id, { picture, previewSide: 120, ...META });
      for (const [what, bytes] of [['empty', Buffer.alloc(0)], ['junk', filler(64, 5)], ['cut', sample.subarray(0, Math.floor(sample.length / 2))], ['svg', svg]] as const) {
        const file = await writeSample(id, bytes);
        const got = await work(file).then((w) => w.path, (e) => e);
        if (typeof got === 'string') expect((await sharp(got).metadata()).format, `${id} ${what}`).toBe('jpeg');
        else expect(got, `${id} ${what}: ${got}`).toBeInstanceOf(NoPreviewError);
        // The page's details still get an answer, never a crash.
        expect((await readMetadata(file)).read).toBe(true);
      }
    }
  });
});

describe('extractRawPreview', () => {
  it('is null for a file with nothing in it', async () => {
    expect(await extractRawPreview(Buffer.alloc(0))).toBeNull();
    expect(await extractRawPreview(filler(1000))).toBeNull();
  });
  it('leaves no temp files behind in the derived cache', () => {
    expect(readdirSync(join(dataDir, 'derived')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
