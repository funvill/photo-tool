// Dragging photos out of the gallery: the main process drags only files the gallery's server has
// catalogued and that are still on disk, as the original files (a HEIC drags as .heic).
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dragFiles, MAX_DRAG_FILES } from '../electron/drag';
import { createGalleryApp } from '../src/gallery/server/app';

describe('dragFiles', () => {
  const catalogued = (p: string) => p !== 'C:\\x\\unknown.jpg';
  const exists = (p: string) => p !== 'C:\\x\\gone.jpg';

  it('keeps catalogued files that exist, in order', () => {
    expect(dragFiles(['C:\\x\\b.jpg', 'C:\\x\\a.heic', 'C:\\x\\c.png'], catalogued, exists)).toEqual(['C:\\x\\b.jpg', 'C:\\x\\a.heic', 'C:\\x\\c.png']);
  });

  it('drops a file the gallery has not catalogued and one that is gone', () => {
    expect(dragFiles(['C:\\x\\unknown.jpg', 'C:\\x\\a.jpg', 'C:\\x\\gone.jpg'], catalogued, exists)).toEqual(['C:\\x\\a.jpg']);
  });

  it('returns [] when nothing is left', () => {
    expect(dragFiles([], catalogued, exists)).toEqual([]);
    expect(dragFiles(['C:\\x\\unknown.jpg', 'C:\\x\\gone.jpg'], catalogued, exists)).toEqual([]);
  });

  it('caps a drag at 500 files', () => {
    expect(MAX_DRAG_FILES).toBe(500);
    expect(dragFiles(Array.from({ length: 600 }, (_, i) => `C:\\x\\${i}.jpg`), catalogued, exists)).toHaveLength(500);
  });
});

describe('POST /api/gallery/drag-check', () => {
  let root: string;
  let server: Server | undefined;
  let close: (() => void) | undefined;
  let base: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gallery-drag-'));
    cpSync(join(process.cwd(), 'fixtures', 'generated', 'trip'), join(root, 'trip'), { recursive: true });
    const g = createGalleryApp(join(root, 'data'), { photoInfoFallbackDir: join(root, 'fallback') });
    close = g.close;
    await new Promise<void>((r) => (server = g.app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    close?.();
    rmSync(root, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  async function items() {
    const { jobId } = (await post('/api/gallery/open', { folder: join(root, 'trip'), recursive: false })).body;
    for (;;) {
      const job = await (await fetch(`${base}/api/gallery/jobs/${jobId}`)).json();
      if (job.done) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return (await (await fetch(`${base}/api/gallery/items?job=${jobId}`)).json()) as { path: string; fileName: string }[];
  }

  it('returns the catalogued paths in order, the HEIC as its original .heic, and the first one\'s small thumbnail', async () => {
    const all = await items();
    const heic = all.find((i) => i.fileName.endsWith('.heic'))!;
    const jpg = all.find((i) => i.fileName === 'day1-01-arrival.jpg')!;
    const stranger = join(root, 'trip', 'not-catalogued.jpg');

    const res = await post('/api/gallery/drag-check', { paths: [heic.path, stranger, jpg.path] });

    expect(res.status).toBe(200);
    expect(res.body.paths).toEqual([heic.path, jpg.path]);
    expect(res.body.paths[0]).toMatch(/\.heic$/);
    expect(res.body.icon).toMatch(/_s\.jpg$/);
  });

  it('has no icon when nothing is catalogued, and refuses a body that is not a list of paths', async () => {
    expect((await post('/api/gallery/drag-check', { paths: [join(root, 'nope.jpg')] })).body).toEqual({ paths: [], icon: null });
    expect((await post('/api/gallery/drag-check', { paths: 'C:\\x.jpg' })).status).toBe(400);
  });
});
