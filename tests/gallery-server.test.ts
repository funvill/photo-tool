import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGalleryApp, type GalleryAppOptions } from '../src/gallery/server/app';
import { PhotoInfoIndex } from '../src/server/photoInfoIndex';
import { updatePhotoInfo } from '../src/photoinfo';

const TRIP = join(process.cwd(), 'fixtures', 'generated', 'trip');
const COUNT = readdirSync(TRIP).length;

let root: string;
let photos: string;
let fallbackDir: string;
let server: Server | undefined;
let closeApp: (() => void) | undefined;
let base: string;

const infoFile = () => join(photos, 'photoinfo.json');
const readInfo = () => JSON.parse(readFileSync(infoFile(), 'utf8'));

const api = async <T = any>(method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, body: (type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as T };
};

async function start(extra: Partial<GalleryAppOptions> = {}) {
  const { app, close } = createGalleryApp(join(root, 'data'), { photoInfoFallbackDir: fallbackDir, ...extra });
  closeApp = close;
  await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const open = async (folder = photos, recursive = false) => (await api('POST', '/api/gallery/open', { folder, recursive })).body.jobId as string;

async function finish(jobId: string) {
  for (;;) {
    const job = (await api('GET', `/api/gallery/jobs/${jobId}`)).body;
    if (job.done) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const loaded = async () => {
  const jobId = await open();
  await finish(jobId);
  const items = (await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body;
  return { jobId, items, byName: (n: string) => items.find((i) => i.fileName === n)! };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gallery-server-'));
  photos = join(root, 'trip');
  fallbackDir = join(root, 'fallback');
  cpSync(TRIP, photos, { recursive: true });
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  closeApp?.();
  closeApp = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('gallery server', () => {
  it('reports health and sends the editor-style CSP', async () => {
    await start();
    const res = await api('GET', '/api/health');
    expect(res.body).toEqual({ ok: true, app: 'gallery' });
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('opens a folder and pages the items with since=n, each photo exactly once', async () => {
    await start();
    const jobId = await open();
    const seen: any[] = [];
    let since = 0;
    let job: any;
    do {
      job = (await api('GET', `/api/gallery/jobs/${jobId}?since=${since}`)).body;
      seen.push(...job.items);
      since += job.items.length;
      if (!job.done) await new Promise((r) => setTimeout(r, 10));
    } while (!job.done);
    // One more poll after done picks up anything that landed between the last two.
    const tail = (await api('GET', `/api/gallery/jobs/${jobId}?since=${since}`)).body;
    seen.push(...tail.items);
    expect(job.total).toBe(COUNT);
    expect(seen).toHaveLength(COUNT);
    expect(new Set(seen.map((i) => i.path)).size).toBe(COUNT);
    expect(seen.every((i) => i.infoSource === 'none' && i.info && Object.keys(i.info).length === 0)).toBe(true);
    expect(seen[0].effectiveDate).toBe(seen[0].capturedAt);
  });

  it('PATCH writes photoinfo.json beside the photo and keeps other entries and unknown fields', async () => {
    writeFileSync(infoFile(), JSON.stringify({ format: 'photoinfo/1', extra: { keep: 1 }, photos: { 'other.jpg': { star: true, custom: 'x' } } }));
    await start();
    const { jobId, byName } = await loaded();
    const a = byName('day1-01-arrival.jpg');
    const res = await api('PATCH', '/api/gallery/info', { path: a.path, patch: { star: true, description: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fileName: 'day1-01-arrival.jpg', infoSource: 'folder', info: { star: true, description: 'x' } });
    const file = readInfo();
    expect(file.extra).toEqual({ keep: 1 });
    expect(file.photos['other.jpg']).toEqual({ star: true, custom: 'x' });
    expect(file.photos['day1-01-arrival.jpg']).toEqual({ star: true, description: 'x' });
    const again = (await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body.find((i) => i.path === a.path);
    expect(again.info).toEqual({ star: true, description: 'x' });
    expect(again.infoSource).toBe('folder');
  });

  it('keeps a star written by the editor between the gallery read and its own PATCH', async () => {
    await start();
    const { byName } = await loaded();
    const a = byName('day1-01-arrival.jpg');
    updatePhotoInfo(photos, a.fileName, { star: true }, { fallbackDir });
    const res = await api('PATCH', '/api/gallery/info', { path: a.path, patch: { notes: 'n' } });
    expect(res.status).toBe(200);
    expect(readInfo().photos[a.fileName]).toEqual({ star: true, notes: 'n' });
  });

  it('stamp changes after an external write', async () => {
    await start();
    const { jobId, byName } = await loaded();
    const before = (await api('GET', `/api/gallery/stamp?job=${jobId}`)).body.stamp;
    expect(before).toBe((await api('GET', `/api/gallery/stamp?job=${jobId}`)).body.stamp);
    updatePhotoInfo(photos, byName('day1-02-street.jpg').fileName, { star: true }, { fallbackDir });
    expect((await api('GET', `/api/gallery/stamp?job=${jobId}`)).body.stamp).not.toBe(before);
  });

  it("PATCH with the job reports the folder's stamp just before and after its write", async () => {
    await start();
    const { jobId, byName } = await loaded();
    const seen = (await api('GET', `/api/gallery/stamp?job=${jobId}`)).body.stamp;
    // Another program writes first: `before` is no longer what the page last saw.
    updatePhotoInfo(photos, byName('day1-02-street.jpg').fileName, { star: true }, { fallbackDir });
    const external = (await api('GET', `/api/gallery/stamp?job=${jobId}`)).body.stamp;
    const res = await api('PATCH', '/api/gallery/info', { path: byName('day1-01-arrival.jpg').path, patch: { star: true }, job: jobId });
    expect(res.status).toBe(200);
    expect(res.body.stamp.before).toBe(external);
    expect(res.body.stamp.before).not.toBe(seen);
    expect(res.body.stamp.after).toBe((await api('GET', `/api/gallery/stamp?job=${jobId}`)).body.stamp);
    // Without the job there is no stamp.
    expect((await api('PATCH', '/api/gallery/info', { path: byName('day1-01-arrival.jpg').path, patch: { star: false } })).body.stamp).toBeUndefined();
  });

  it('a read-only folder falls back to the editor fallback dir and the editor sees it', async () => {
    await start({
      photoInfoSeams: {
        writeFile: (target, text) => {
          if (target.startsWith(photos)) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
          mkdirSync(fallbackDir, { recursive: true });
          writeFileSync(target, text);
        },
      },
    });
    const { jobId, byName } = await loaded();
    const a = byName('day1-01-arrival.jpg');
    const res = await api('PATCH', '/api/gallery/info', { path: a.path, patch: { star: true } });
    expect(res.status).toBe(200);
    expect(res.body.infoSource).toBe('fallback');
    expect(existsSync(infoFile())).toBe(false);
    expect(readdirSync(fallbackDir)).toHaveLength(1);
    const asset = { id: 'x', favorite: false } as any;
    expect(new PhotoInfoIndex({ fallbackDir }).apply(asset, a.path).favorite).toBe(true);
    const items = (await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body;
    expect(items.find((i) => i.path === a.path).info.star).toBe(true);
  });

  it('answers 409 with the write error when the file cannot be read', async () => {
    writeFileSync(infoFile(), '{ not json');
    await start();
    const { byName, items } = await loaded();
    expect(items[0].infoError).toBeTruthy();
    const res = await api('PATCH', '/api/gallery/info', { path: byName('day1-01-arrival.jpg').path, patch: { star: true } });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("can't be read");
  });

  it('date and location overrides change the effective values only', async () => {
    await start();
    const { byName } = await loaded();
    const a = byName('day1-01-arrival.jpg');
    expect(a.capturedAt).not.toBeNull();
    const res = await api('PATCH', '/api/gallery/info', { path: a.path, patch: { date: '2001-02-03T04:05:06', location: { lat: 10.5, lon: -20.25 } } });
    const b = res.body;
    expect([b.effectiveDate, b.effectiveLat, b.effectiveLon]).toEqual(['2001-02-03T04:05:06', 10.5, -20.25]);
    expect([b.capturedAt, b.gpsLat, b.gpsLon]).toEqual([a.capturedAt, a.gpsLat, a.gpsLon]);
  });

  it('lists people across the folder, most used first', async () => {
    await start();
    const { jobId, items } = await loaded();
    const [p1, p2, p3] = items.slice(0, 3).map((i) => i.path);
    await api('PATCH', '/api/gallery/info', { path: p1, patch: { people: ['Sam', 'Alex'] } });
    await api('PATCH', '/api/gallery/info', { path: p2, patch: { people: ['Sam'] } });
    await api('PATCH', '/api/gallery/info', { path: p3, patch: { people: ['Sam', 'Alex', 'Zed'] } });
    expect((await api('GET', `/api/gallery/people?job=${jobId}`)).body).toEqual(['Sam', 'Alex', 'Zed']);
  });

  it('serves thumbnails by catalogued key and 404s the rest', async () => {
    await start();
    const { items } = await loaded();
    const ok = await api('GET', `/api/gallery/thumb?key=${items[0].key}&size=s`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('image/jpeg');
    expect((ok.body as Buffer).subarray(0, 2).toString('hex')).toBe('ffd8');
    expect((await api('GET', '/api/gallery/thumb?key=nope&size=s')).status).toBe(404);
    expect((await api('GET', `/api/gallery/thumb?key=${encodeURIComponent('C:\\Windows\\win.ini')}`)).status).toBe(404);
    expect((await api('GET', `/api/gallery/thumb?key=${items[0].key}&size=xl`)).status).toBe(400);
  });

  it('404s info writes for paths that are not catalogued', async () => {
    await start();
    await loaded();
    const res = await api('PATCH', '/api/gallery/info', { path: 'C:\\Windows\\win.ini', patch: { star: true } });
    expect(res.status).toBe(404);
    expect(existsSync(join('C:\\Windows', 'photoinfo.json'))).toBe(false);
  });

  it('404s a missing folder with a message and keeps it in the recent list as missing', async () => {
    await start();
    const jobId = await open();
    await finish(jobId);
    const gone = join(root, 'gone');
    cpSync(photos, gone, { recursive: true });
    await finish(await open(gone));
    rmSync(gone, { recursive: true, force: true });
    const res = await api('POST', '/api/gallery/open', { folder: gone, recursive: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Not a readable folder');
    const recent = (await api<any[]>('GET', '/api/gallery/recent')).body;
    expect(recent.find((r) => r.folder === gone)).toMatchObject({ exists: false });
    expect(recent.find((r) => r.folder === photos)).toMatchObject({ exists: true });
  });

  it('keeps the 4 most recent jobs and 404s older ones', async () => {
    const small = join(root, 'small');
    mkdirSync(small);
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(small, 'a.jpg'));
    await start();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await open(small));
      if (i === 0) await finish(ids[0]);
    }
    for (const id of ids.slice(1)) await finish(id);
    expect((await api('GET', `/api/gallery/jobs/${ids[0]}`)).status).toBe(404);
    expect((await api('GET', `/api/gallery/items?job=${ids[0]}`)).status).toBe(404);
    for (const id of ids.slice(1)) expect((await api('GET', `/api/gallery/jobs/${id}`)).status).toBe(200);
  });

  it('serves the places like the editor', async () => {
    await start();
    expect(Array.isArray((await api('GET', '/api/places')).body)).toBe(true);
    const res = await api('POST', '/api/places/suggest', { points: [[-123.12, 49.28]] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('serves staticDir with a gallery.html fallback', async () => {
    const web = join(root, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'gallery.html'), '<p>gallery</p>');
    await start({ staticDir: web });
    const res = await fetch(base + '/some/route');
    expect(await res.text()).toBe('<p>gallery</p>');
    expect((await fetch(base + '/api/nope')).status).toBe(404);
  });
});
