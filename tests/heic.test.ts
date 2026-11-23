// HEIC photos and PDF rendering without macOS: the bundled WebAssembly engines (libheif for HEIC,
// PDFium for image and flipbook export). They run on every platform, so these tests do too; what
// macOS does with `sips` instead is covered by the import and export tests.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { fontFilePath } from '../src/core';
import { createApp } from '../src/server/app';
import { decodeHeic, embedIccProfile, heicToJpeg } from '../src/server/heic';
import { rasterPdf } from '../src/server/pdfRaster';
import { fontFile } from '../src/server/resources';

const FIXTURES = join(process.cwd(), 'fixtures', 'generated', 'trip');
const HEIC = join(FIXTURES, 'day2-06-heic-sunset.heic');

/** The pixel at (x, y) of raw RGB data. */
const at = (data: Buffer, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

describe.runIf(existsSync(HEIC))('HEIC decoding (libheif as WebAssembly)', () => {
  it('decodes the picture itself: right size, right colours in the right places', async () => {
    const { data, width, height, icc } = await decodeHeic(HEIC);
    expect([width, height, data.length]).toEqual([3000, 2000, 3000 * 2000 * 3]);
    expect(icc).toBeNull(); // the fixture carries no profile
    // The fixture's subject is a red dot (#e85d3f) at 60% across, 35% down, in a cream ring (#fff4d6).
    const [r, g, b] = at(data, width, 1800, 700);
    expect(Math.abs(r - 0xe8) + Math.abs(g - 0x5d) + Math.abs(b - 0x3f)).toBeLessThan(40);
    const [rr, rg, rb] = at(data, width, 1800 + 190, 700);
    expect(Math.abs(rr - 0xff) + Math.abs(rg - 0xf4) + Math.abs(rb - 0xd6)).toBeLessThan(40);
    // Pale sky along the top edge, dark water along the bottom: the right way up.
    expect(at(data, width, 1500, 60)[0]).toBeGreaterThan(at(data, width, 1500, 1900)[0] + 100);
  });

  it('decodes several at once, and reports a file that is not HEIC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heic-'));
    const bad = join(dir, 'not-really.heic');
    writeFileSync(bad, 'this is not a photo');
    const results = await Promise.allSettled([decodeHeic(HEIC), decodeHeic(bad), decodeHeic(HEIC), decodeHeic(HEIC), decodeHeic(join(dir, 'missing.heic'))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'rejected']);
    expect(String((results[1] as PromiseRejectedResult).reason.message)).toMatch(/^Could not open this HEIC photo/);
    // The decoder is still usable after the failures.
    expect((await decodeHeic(HEIC)).width).toBe(3000);
    rmSync(dir, { recursive: true, force: true });
  });

  it('converts to a JPEG the rest of the pipeline reads, leaving no temporary file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heic-'));
    const out = join(dir, 'converted.jpg');
    await heicToJpeg(HEIC, out);
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height, meta.orientation]).toEqual(['jpeg', 3000, 2000, undefined]);
    expect(readdirSync(dir)).toEqual(['converted.jpg']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries a colour profile into the JPEG (iPhone photos are Display P3)', async () => {
    const plain = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
    expect((await sharp(plain).metadata()).icc).toBeUndefined();
    const p3 = (await sharp(await sharp(plain).withIccProfile('p3').jpeg().toBuffer()).metadata()).icc!;
    expect(p3.length).toBeGreaterThan(100);
    const tagged = embedIccProfile(plain, p3);
    const meta = await sharp(tagged).metadata();
    expect([meta.width, meta.height]).toEqual([40, 30]);
    expect(meta.icc!.equals(p3)).toBe(true);
    // A profile too large for one segment is split, each part numbered "n of count".
    const big = embedIccProfile(plain, Buffer.alloc(150_000, 7));
    const segments: number[][] = [];
    for (let i = 2; big.readUInt16BE(i) === 0xffe2; i += 2 + big.readUInt16BE(i + 2)) segments.push([big[i + 16], big[i + 17], big.readUInt16BE(i + 2)]);
    expect(segments).toEqual([[1, 3, 65535], [2, 3, 65535], [3, 3, 150_000 - 2 * 65519 + 16]]);
    expect((await sharp(big).metadata()).width).toBe(40);
  });

  it('previews a HEIC photo on the Shelf', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'heic-data-'));
    const shelf = mkdtempSync(join(tmpdir(), 'heic-shelf-'));
    mkdirSync(join(shelf, 'Phone'));
    copyFileSync(HEIC, join(shelf, 'Phone', 'IMG_0001.HEIC'));
    const { app, store } = createApp(dataDir);
    store.setSetting('shelf_root', shelf);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const listing = (await (await fetch(`${base}/api/shelf`)).json()) as any;
      expect(listing.folders[0]).toMatchObject({ name: 'Phone', photos: 1, previews: [join(shelf, 'Phone', 'IMG_0001.HEIC')] });
      const res = await fetch(`${base}/api/shelf/preview?path=${encodeURIComponent(listing.folders[0].previews[0])}`);
      expect(res.status).toBe(200);
      const img = sharp(Buffer.from(await res.arrayBuffer()));
      const meta = await img.metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 160, 107]);
      expect((await img.stats()).channels[0].stdev).toBeGreaterThan(20);
    } finally {
      server.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(shelf, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform !== 'darwin')('PDF rendering (PDFium as WebAssembly)', () => {
  it('renders a page at exactly the asked size, shapes and embedded-font text where the PDF puts them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raster-'));
    const pdf = join(dir, 'page.pdf');
    const mm = (v: number) => (v * 72) / 25.4;
    const pageMm = { w: 200, h: 100 };
    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({ size: [mm(pageMm.w), mm(pageMm.h)], margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => {
        writeFileSync(pdf, Buffer.concat(chunks));
        resolve();
      });
      doc.on('error', reject);
      doc.rect(0, 0, mm(100), mm(50)).fill('#0050c8'); // top-left quarter blue
      doc.rect(mm(100), mm(50), mm(100), mm(50)).fill('#c81e1e'); // bottom-right quarter red
      doc.font(fontFile(fontFilePath('Inter', 700))).fontSize(40).fillColor('#000000').text('Hxmlp', mm(110), mm(10), { lineBreak: false });
      doc.end();
    });
    const raster = await rasterPdf(pdf, pageMm, 1000);
    try {
      expect([raster.width, raster.height]).toEqual([1000, 500]);
      const { data, info } = await raster.image().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height, info.channels]).toEqual([1000, 500, 3]); // opaque: no alpha channel
      expect(at(data, 1000, 250, 125)).toEqual([0x00, 0x50, 0xc8]);
      expect(at(data, 1000, 750, 375)).toEqual([0xc8, 0x1e, 0x1e]);
      expect(at(data, 1000, 250, 375)).toEqual([255, 255, 255]); // paper
      // The quarter with the text: black glyphs on white, anti-aliased in grey (no colour fringes).
      let dark = 0;
      let chroma = 0;
      for (let y = 0; y < 250; y++) {
        for (let x = 500; x < 1000; x++) {
          const [r, g, b] = at(data, 1000, x, y);
          if (r < 60) dark++;
          chroma = Math.max(chroma, Math.max(r, g, b) - Math.min(r, g, b));
        }
      }
      expect(dark).toBeGreaterThan(2000);
      expect(chroma).toBe(0);
    } finally {
      await raster.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
