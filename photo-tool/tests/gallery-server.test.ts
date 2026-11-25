import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGalleryApp, type GalleryAppOptions } from '../server/app';
import { infoFor, readFolderInfo, updatePhotoInfo } from '../../shared/photoinfo';

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

  it('a cached photo without exif gets it on the next scan and keeps its thumbnail files', async () => {
    await start();
    const first = await loaded();
    const arrival = first.byName('day1-01-arrival.jpg');
    expect(arrival.exif).toBeTruthy();
    const thumbs = ['s', 'm'].map((s) => join(root, 'data', 'thumbs', `${arrival.key}_${s}.jpg`));
    const mtimes = () => thumbs.map((t) => statSync(t).mtimeMs);
    const before = mtimes();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    closeApp?.();
    closeApp = undefined;
    const db = new DatabaseSync(join(root, 'data', 'gallery.sqlite'));
    db.prepare('UPDATE photos SET exif = NULL, camera = NULL').run();
    db.close();
    await start();
    const second = await loaded();
    const again = second.byName('day1-01-arrival.jpg');
    expect(again.exif).not.toBeNull();
    expect(again.camera).toBe('Photobook Fixture Synthetic');
    expect(again.key).toBe(arrival.key);
    expect(mtimes()).toEqual(before);
  });

  it('cancels a scan on request: it ends done and cancelled, and GET jobs/:id says so', async () => {
    await start();
    const jobId = await open();
    const res = await api('POST', `/api/gallery/jobs/${jobId}/cancel`);
    expect(res.status).toBe(200);
    const job = await finish(jobId);
    expect(job).toMatchObject({ done: true, cancelled: true });
    expect(job.processed).toBeLessThan(COUNT);
    expect((await api('POST', '/api/gallery/jobs/nope/cancel')).status).toBe(404);
    // A finished scan reports cancelled: false.
    const next = await finish(await open());
    expect(next).toMatchObject({ done: true, cancelled: false });
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
    // What the editor reads: the same shared photoinfo module, with the same fallback folder.
    expect(infoFor(readFolderInfo(dirname(a.path), { fallbackDir }), basename(a.path))?.star).toBe(true);
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

  it('lists info entries whose photo is gone, and forget removes them', async () => {
    await start();
    const { jobId, byName } = await loaded();
    const a = byName('day1-01-arrival.jpg');
    await api('PATCH', '/api/gallery/info', { path: a.path, patch: { star: true } });
    writeFileSync(infoFile(), JSON.stringify({ ...readInfo(), owner: 'x', photos: { ...readInfo().photos, 'deleted.jpg': { star: true }, 'Deleted2.JPG': { notes: 'n' } } }));
    expect((await api('GET', `/api/gallery/orphans?job=${jobId}`)).body).toEqual([{ folder: photos, fileNames: ['deleted.jpg', 'Deleted2.JPG'].sort() }]);

    const res = await api('POST', '/api/gallery/forget', { folder: photos, fileNames: ['deleted.jpg', 'Deleted2.JPG'] });
    expect(res.body).toEqual({ removed: 2 });
    expect(Object.keys(readInfo().photos)).toEqual(['day1-01-arrival.jpg']);
    expect(readInfo().owner).toBe('x');
    expect((await api('GET', `/api/gallery/orphans?job=${jobId}`)).body).toEqual([]);
  });

  it('leaves a deleted photo out of GET items, and keeps its photoinfo.json entry', async () => {
    await start();
    const { jobId, byName } = await loaded();
    const gone = byName('day1-02-street.jpg');
    await api('PATCH', '/api/gallery/info', { path: gone.path, patch: { star: true } });
    const before = readFileSync(infoFile(), 'utf8');
    unlinkSync(gone.path);
    const items = (await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body;
    expect(items).toHaveLength(COUNT - 1);
    expect(items.some((i) => i.path === gone.path)).toBe(false);
    // Nothing is written: the entry stays until "Tidy photo info" removes it.
    expect(readFileSync(infoFile(), 'utf8')).toBe(before);
    expect((await api('GET', `/api/gallery/orphans?job=${jobId}`)).body).toEqual([{ folder: photos, fileNames: ['day1-02-street.jpg'] }]);
  });

  it('forget refuses a name whose file still exists, and writes nothing', async () => {
    await start();
    const { jobId, byName } = await loaded();
    const a = byName('day1-01-arrival.jpg');
    await api('PATCH', '/api/gallery/info', { path: a.path, patch: { star: true } });
    writeFileSync(infoFile(), JSON.stringify({ ...readInfo(), photos: { ...readInfo().photos, 'deleted.jpg': { star: true } } }));
    const before = readFileSync(infoFile(), 'utf8');
    const res = await api('POST', '/api/gallery/forget', { folder: photos, fileNames: ['deleted.jpg', 'DAY1-01-arrival.jpg'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('DAY1-01-arrival.jpg');
    expect(readFileSync(infoFile(), 'utf8')).toBe(before);

    // A file that comes back after the list was made is refused too.
    writeFileSync(join(photos, 'deleted.jpg'), 'x');
    expect((await api('POST', '/api/gallery/forget', { folder: photos, fileNames: ['deleted.jpg'] })).status).toBe(400);
    expect(readFileSync(infoFile(), 'utf8')).toBe(before);
    unlinkSync(join(photos, 'deleted.jpg'));

    // Nothing outside an open folder, and no path tricks.
    expect((await api('POST', '/api/gallery/forget', { folder: root, fileNames: ['x.jpg'] })).status).toBe(404);
    expect((await api('POST', '/api/gallery/forget', { folder: photos, fileNames: ['../x.jpg'] })).status).toBe(400);
    expect((await api('POST', '/api/gallery/forget', { folder: photos, fileNames: [] })).status).toBe(400);
    expect((await api('GET', '/api/gallery/orphans?job=nope')).status).toBe(404);
    expect(jobId).toBeTruthy();
    expect(readFileSync(infoFile(), 'utf8')).toBe(before);
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

  it('image route returns a PNG for a catalogued photo', async () => {
    await start();
    const { byName } = await loaded();
    const a = byName('day1-01-arrival.jpg');
    const res = await api('GET', `/api/gallery/image?path=${encodeURIComponent(a.path)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect((res.body as Buffer).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('image route 404s for an unknown path', async () => {
    await start();
    await loaded();
    expect((await api('GET', `/api/gallery/image?path=${encodeURIComponent('C:\\Windows\\win.ini')}`)).status).toBe(404);
    expect((await api('GET', `/api/gallery/image?path=${encodeURIComponent(join(photos, 'nope.jpg'))}`)).status).toBe(404);
    expect((await api('GET', '/api/gallery/image')).status).toBe(404);
  });

  it('removed drops a deleted photo from items and photoinfo.json', async () => {
    await start();
    const { jobId, byName } = await loaded();
    const gone = byName('day1-02-street.jpg');
    const kept = byName('day1-01-arrival.jpg');
    await api('PATCH', '/api/gallery/info', { path: gone.path, patch: { star: true } });
    await api('PATCH', '/api/gallery/info', { path: kept.path, patch: { star: true } });
    // Only ever the temp copy of the fixture.
    expect(gone.path.startsWith(root)).toBe(true);
    rmSync(gone.path);

    const res = await api('POST', '/api/gallery/removed', { paths: [gone.path] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: [gone.path] });
    const items = (await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body;
    expect(items.some((i) => i.path === gone.path)).toBe(false);
    expect(items).toHaveLength(COUNT - 1);
    // The scan's own list drops it too (not just the existence filter of GET items).
    expect((await api('GET', `/api/gallery/jobs/${jobId}`)).body.items.some((i: any) => i.path === gone.path)).toBe(false);
    expect(Object.keys(readInfo().photos)).toEqual(['day1-01-arrival.jpg']);
    // Its catalogue row and thumbnails are gone.
    expect((await api('GET', `/api/gallery/thumb?key=${gone.key}&size=s`)).status).toBe(404);
    expect(existsSync(join(root, 'data', 'thumbs', `${gone.key}_s.jpg`))).toBe(false);
    expect(existsSync(join(root, 'data', 'thumbs', `${gone.key}_m.jpg`))).toBe(false);
    expect((await api('POST', '/api/gallery/removed', { paths: 'x' })).status).toBe(400);
    expect((await api('POST', '/api/gallery/removed', { paths: [1] })).status).toBe(400);
  });

  it('removed skips a photo still on disk', async () => {
    await start();
    const { jobId, byName } = await loaded();
    const a = byName('day1-01-arrival.jpg');
    await api('PATCH', '/api/gallery/info', { path: a.path, patch: { star: true } });
    const before = readFileSync(infoFile(), 'utf8');
    const res = await api('POST', '/api/gallery/removed', { paths: [a.path, 'C:\\Windows\\win.ini'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: [] });
    expect(existsSync(a.path)).toBe(true);
    expect(readFileSync(infoFile(), 'utf8')).toBe(before);
    expect((await api<any[]>('GET', `/api/gallery/items?job=${jobId}`)).body).toHaveLength(COUNT);
    expect((await api('GET', `/api/gallery/thumb?key=${a.key}&size=s`)).status).toBe(200);
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

  it('file-check passes only photos of the folder open now, in the order asked', async () => {
    await start();
    const { byName } = await loaded();
    const a = byName('day1-01-arrival.jpg').path;
    const b = byName('day1-02-street.jpg').path;
    const ok = await api('POST', '/api/gallery/file-check', { paths: [b, 'C:\\Windows\\win.ini', a] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ paths: [b, a] });
    expect((await api('POST', '/api/gallery/file-check', { paths: 'x' })).status).toBe(400);

    // Open another folder: the trip folder is no longer open (though its scan is still kept, and its
    // photos stay catalogued).
    const small = join(root, 'small');
    mkdirSync(small);
    cpSync(join(TRIP, 'day1-04-lunch.jpg'), join(small, 'c.jpg'));
    await finish(await open(small));
    expect((await api('POST', '/api/gallery/drag-check', { paths: [a] })).body.paths).toEqual([a]);
    expect((await api('POST', '/api/gallery/file-check', { paths: [a, b, join(small, 'c.jpg')] })).body).toEqual({ paths: [join(small, 'c.jpg')] });
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

  it('serves staticDir with an index.html fallback', async () => {
    const web = join(root, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<p>gallery</p>');
    await start({ staticDir: web });
    const res = await fetch(base + '/some/route');
    expect(await res.text()).toBe('<p>gallery</p>');
    expect((await fetch(base + '/api/nope')).status).toBe(404);
  });

  it('serves the staticPage it is told to (the desktop build keeps the page as gallery.html beside the editor index.html)', async () => {
    const web = join(root, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<p>editor</p>');
    writeFileSync(join(web, 'gallery.html'), '<p>gallery</p>');
    await start({ staticDir: web, staticPage: 'gallery.html' });
    expect(await (await fetch(base + '/some/route')).text()).toBe('<p>gallery</p>');
  });
});
