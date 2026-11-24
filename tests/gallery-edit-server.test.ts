import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGalleryApp } from '../src/gallery/server/app';

let root: string;
let photos: string;
let other: string;
let server: Server | undefined;
let closeApp: (() => void) | undefined;
let base: string;

const dataDir = () => join(root, 'data');

const api = async <T = any>(method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, body: (type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as T };
};

const makeJpeg = (file: string, width: number, height: number, orientation?: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } } })
    .jpeg()
    .withMetadata(orientation ? { orientation } : {})
    .toFile(file);

async function openAndFinish(folder = photos, recursive = false) {
  const { jobId } = (await api('POST', '/api/gallery/open', { folder, recursive })).body;
  for (;;) {
    const job = (await api('GET', `/api/gallery/jobs/${jobId}`)).body;
    if (job.done) return jobId as string;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gallery-edit-'));
  photos = join(root, 'trip');
  other = join(root, 'other');
  mkdirSync(join(photos, 'sub'), { recursive: true });
  mkdirSync(other);
  await makeJpeg(join(photos, 'a.jpg'), 200, 100);
  await makeJpeg(join(photos, 'tall.jpg'), 200, 100, 6); // shown upright as 100 x 200
  await makeJpeg(join(photos, 'sub', 's.jpg'), 80, 60);
  await makeJpeg(join(other, 'o.jpg'), 60, 60);
  const { app, close } = createGalleryApp(dataDir(), { photoInfoFallbackDir: join(root, 'fallback') });
  closeApp = close;
  await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  closeApp?.();
  closeApp = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('POST /api/gallery/edit/render', () => {
  it('writes the edited picture into <dataDir>/edits', async () => {
    await openAndFinish();
    const res = await api('POST', '/api/gallery/edit/render', { path: join(photos, 'a.jpg'), edit: { rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(res.status).toBe(200);
    expect(res.body.format).toBe('jpeg');
    expect(res.body.file.startsWith(join(dataDir(), 'edits'))).toBe(true);
    expect(existsSync(res.body.file)).toBe(true);
    const meta = await sharp(res.body.file).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });

  it('refuses a photo of an earlier job', async () => {
    await openAndFinish();
    await openAndFinish(other);
    const res = await api('POST', '/api/gallery/edit/render', { path: join(photos, 'a.jpg'), edit: { rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('That photo is not in the open folder any more.');
  });

  it('refuses a bad edit', async () => {
    await openAndFinish();
    const res = await api('POST', '/api/gallery/edit/render', { path: join(photos, 'a.jpg'), edit: { rotate: 45 } });
    expect(res.status).toBe(400);
  });

  it('removes files older than an hour from edits, and only there', async () => {
    await openAndFinish();
    const edits = join(dataDir(), 'edits');
    mkdirSync(edits, { recursive: true });
    const old = join(edits, 'old.jpg');
    writeFileSync(old, 'x');
    const long = new Date(Date.now() - 2 * 3600_000);
    utimesSync(old, long, long);
    const outside = join(dataDir(), 'old-outside.jpg');
    writeFileSync(outside, 'x');
    utimesSync(outside, long, long);
    await api('POST', '/api/gallery/edit/render', { path: join(photos, 'a.jpg'), edit: { rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(readdirSync(edits)).toHaveLength(1);
  });
});

describe('POST /api/gallery/refresh', () => {
  it('re-reads a changed photo: new key and size', async () => {
    const jobId = await openAndFinish();
    const before = (await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body.find((i) => i.fileName === 'a.jpg');
    await makeJpeg(join(photos, 'a.jpg'), 120, 90);
    const res = await api<any[]>('POST', '/api/gallery/refresh', { paths: [join(photos, 'a.jpg')] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].width).toBe(120);
    expect(res.body[0].key).not.toBe(before.key);
    const items = (await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body;
    expect(items.filter((i) => i.fileName === 'a.jpg')).toHaveLength(1);
    expect(items.find((i) => i.fileName === 'a.jpg').width).toBe(120);
  });

  it('appends a new file inside the folder', async () => {
    const jobId = await openAndFinish();
    const file = join(photos, 'new.jpg');
    await makeJpeg(file, 50, 40);
    const res = await api<any[]>('POST', '/api/gallery/refresh', { paths: [file] });
    expect(res.body.map((i) => i.fileName)).toEqual(['new.jpg']);
    const items = (await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body;
    expect(items.some((i) => i.fileName === 'new.jpg')).toBe(true);
  });

  it('skips paths outside the folder, non-photos, and subfolders of a non-recursive job', async () => {
    await openAndFinish();
    writeFileSync(join(photos, 'note.txt'), 'hi');
    const res = await api<any[]>('POST', '/api/gallery/refresh', { paths: [join(other, 'o.jpg'), join(photos, 'note.txt'), join(photos, 'sub', 's.jpg'), join(photos, 'missing.jpg')] });
    expect(res.body).toEqual([]);
  });

  it('accepts a subfolder photo of a recursive job', async () => {
    await openAndFinish(photos, true);
    const res = await api<any[]>('POST', '/api/gallery/refresh', { paths: [join(photos, 'sub', 's.jpg')] });
    expect(res.body.map((i) => i.fileName)).toEqual(['s.jpg']);
  });
});

describe('GET /api/gallery/full', () => {
  it('sends the upright picture as JPEG', async () => {
    await openAndFinish();
    const res = await api<Buffer>('GET', `/api/gallery/full?path=${encodeURIComponent(join(photos, 'tall.jpg'))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    const meta = await sharp(res.body).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });

  it('is a 404 outside the open folder', async () => {
    await openAndFinish();
    await openAndFinish(other);
    const res = await api('GET', `/api/gallery/full?path=${encodeURIComponent(join(photos, 'a.jpg'))}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/gallery/info edit field', () => {
  const patch = (edit: unknown) => api('PATCH', '/api/gallery/info', { path: join(photos, 'a.jpg'), patch: { edit } });
  const infoPath = () => join(photos, 'photoinfo.json');

  it('stores a normalised edit', async () => {
    await openAndFinish();
    const res = await patch({ rotate: 90, straighten: 1.234, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    expect(res.status).toBe(200);
    expect(res.body.info.edit.rotate).toBe(90);
  });

  it('stores an identity edit as a removal', async () => {
    await openAndFinish();
    await patch({ rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } });
    const res = await patch({ rotate: 0, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.info.edit).toBeUndefined();
  });

  it('removes with null', async () => {
    await openAndFinish();
    await patch({ rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } });
    const res = await patch(null);
    expect(res.status).toBe(200);
    expect(res.body.info.edit).toBeUndefined();
  });

  it('refuses an invalid edit and writes nothing', async () => {
    await openAndFinish();
    const res = await patch({ rotate: 45 });
    expect(res.status).toBe(400);
    expect(existsSync(infoPath()) ? readFileSync(infoPath(), 'utf8') : '').not.toContain('45');
    expect(statSync(photos).isDirectory()).toBe(true);
  });
});
