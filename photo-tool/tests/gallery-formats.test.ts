// Photo Tool reads the formats phase 2 of #6 added (fixtures/generated/formats): the scan picks each
// one up, and every route the page and the desktop app use gives a picture of it.
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGalleryApp } from '../server/app';

const FORMATS = join(process.cwd(), 'fixtures', 'generated', 'formats');

describe.runIf(existsSync(FORMATS))('the new formats in Photo Tool', () => {
  let root: string;
  let photos: string;
  let server: Server;
  let close: () => void;
  let base: string;
  let items: any[];
  let errors: unknown[];

  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gallery-formats-'));
    photos = join(root, 'formats');
    cpSync(FORMATS, photos, { recursive: true });
    const made = createGalleryApp(join(root, 'data'), { photoInfoFallbackDir: join(root, 'fallback') });
    close = made.close;
    await new Promise<void>((r) => (server = made.app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const open = await fetch(`${base}/api/gallery/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: photos, recursive: false }) });
    const { jobId } = (await open.json()) as { jobId: string };
    for (;;) {
      const job = (await (await fetch(`${base}/api/gallery/jobs/${jobId}`)).json()) as any;
      if (job.done) {
        items = job.items;
        errors = job.errors;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    close();
    rmSync(root, { recursive: true, force: true });
  });

  it('scans every one, catalogued under its own format', () => {
    expect(errors).toEqual([]);
    const byName = Object.fromEntries(items.map((i) => [i.fileName, i]));
    expect(Object.keys(byName).sort()).toEqual(['avif-lake.avif', 'bmp-garden.bmp', 'gif-animated.gif', 'ico-app.ico', 'svg-badge.svg', 'tiff-harbour.tif']);
    // AVIF is 'avif', though sharp calls it 'heif'.
    expect(Object.fromEntries(items.map((i) => [i.fileName, i.format]))).toEqual({
      'avif-lake.avif': 'avif', 'bmp-garden.bmp': 'bmp', 'gif-animated.gif': 'gif', 'ico-app.ico': 'ico', 'svg-badge.svg': 'svg', 'tiff-harbour.tif': 'tiff',
    });
    expect([byName['tiff-harbour.tif'].width, byName['tiff-harbour.tif'].height]).toEqual([1200, 800]);
    expect([byName['gif-animated.gif'].width, byName['gif-animated.gif'].height]).toEqual([320, 240]);
    expect(byName['svg-badge.svg'].width).toBe(2048);
    expect(byName['avif-lake.avif'].capturedAt).toBe('2026-04-02T12:00:00');
  });

  it('serves both thumbnails, the zoomed view and the clipboard picture of each', async () => {
    for (const item of items) {
      for (const size of ['s', 'm']) {
        const thumb = await get(`/api/gallery/thumb?key=${encodeURIComponent(item.key)}&size=${size}`);
        expect(thumb.status, `${item.fileName} ${size}`).toBe(200);
        expect((await sharp(thumb.body).metadata()).format).toBe('jpeg');
      }
      const full = await get(`/api/gallery/full?path=${encodeURIComponent(item.path)}`);
      expect(full.status, item.fileName).toBe(200);
      expect(full.type).toContain('image/jpeg');
      const meta = await sharp(full.body).metadata();
      expect([meta.width, meta.height], item.fileName).toEqual([item.width, item.height]);
      const png = await get(`/api/gallery/image?path=${encodeURIComponent(item.path)}`);
      expect(png.status, item.fileName).toBe(200);
      expect((await sharp(png.body).metadata()).format).toBe('png');
    }
  });

  it('shows an animated GIF as its first (red) frame', async () => {
    const gif = items.find((i) => i.fileName === 'gif-animated.gif');
    const { data } = await sharp((await get(`/api/gallery/full?path=${encodeURIComponent(gif.path)}`)).body).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[2]).toBeLessThan(60);
  });
});
