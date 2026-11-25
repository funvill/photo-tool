// HEIC on the Shelf and PDF rendering without macOS: the bundled WebAssembly engines (libheif for HEIC,
// PDFium for image and flipbook export). They run on every platform, so these tests do too.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { fontFilePath } from '../core';
import { createApp } from '../server/app';
import { rasterPdf } from '../server/pdfRaster';
import { fontFile } from '../../shared/server/resources';

const FIXTURES = join(process.cwd(), 'fixtures', 'generated', 'trip');
const HEIC = join(FIXTURES, 'day2-06-heic-sunset.heic');

/** The pixel at (x, y) of raw RGB data. */
const at = (data: Buffer, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

describe.runIf(existsSync(HEIC))('HEIC on the Shelf', () => {
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
