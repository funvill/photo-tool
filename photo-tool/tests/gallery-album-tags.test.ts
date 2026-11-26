// The album tags sidecar between the catalogue (a cache) and the album folder (where the results live): opening a
// folder brings its results into the catalogue, and writes out once the ones the catalogue has but the folder lacks.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumTagsStore, PHOTOTAGS_NAME, PHOTOVECTORS_NAME, encodeVector, fileKeyOf } from '../../shared/phototags';
import { contentKeyOf } from '../server/scanner';
import { createGalleryApp } from '../server/app';
import { Catalog, type GalleryPhoto, type TagRow } from '../server/catalog';
import { AlbumTags } from '../server/tagging/albumTags';
import type { TaggerBackend } from '../server/tagging/backend';
import { FAKE_CATALOGUE, fakeFetch } from './support/fakeTagging';

const [describeSmall, , keywordsSmall] = FAKE_CATALOGUE;

let root: string;
let trip: string;
let catalog: Catalog;
let store: AlbumTagsStore;
let albumTags: AlbumTags;

const photo = (name: string, contentKey = `ck-${name}`): GalleryPhoto => ({
  path: join(trip, `${name}.jpg`), folder: trip, fileName: `${name}.jpg`, relDir: '', size: 1, mtimeMs: 1, width: 10, height: 10, format: 'jpeg',
  capturedAt: null, gpsLat: null, gpsLon: null, camera: null, exif: null, analysis: null, key: `k-${name}`, contentKey,
});
const row = (contentKey: string, modelId: string, r: Partial<TagRow> = {}): TagRow => ({
  contentKey, modelId, status: 'done', description: null, keywords: [], objects: [], embedding: null, error: null, ...r,
});
const writeSidecar = (photos: Record<string, Record<string, Record<string, unknown>>>) =>
  writeFileSync(join(trip, PHOTOTAGS_NAME), JSON.stringify({ format: 'phototool-tags/1', photos: Object.fromEntries(Object.entries(photos).map(([n, models]) => [n, { models }])) }));
const writeVectors = (photos: Record<string, Record<string, { contentKey: string; v: number[] }>>) =>
  writeFileSync(join(trip, PHOTOVECTORS_NAME), JSON.stringify({
    format: 'phototool-vectors/1',
    photos: Object.fromEntries(Object.entries(photos).map(([n, models]) => [n, { models: Object.fromEntries(Object.entries(models).map(([m, x]) => [m, { contentKey: x.contentKey, data: encodeVector(new Float32Array(x.v)) }])) }])),
  }));
const sidecar = () => JSON.parse(readFileSync(join(trip, PHOTOTAGS_NAME), 'utf8')).photos;
const tag = (key: string, id: string) => catalog.tagsFor([key], [id], true).get(key)?.[0];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'album-tags-'));
  trip = join(root, 'trip');
  mkdirSync(trip);
  catalog = new Catalog(join(root, 'data'));
  store = new AlbumTagsStore({ fallbackDir: join(root, 'fallback'), debounceMs: 60_000, maxWaitMs: 60_000, onError: () => {} });
  albumTags = new AlbumTags({ catalog, store, catalogue: FAKE_CATALOGUE });
});
afterEach(() => {
  store.close();
  catalog.close();
  rmSync(root, { recursive: true, force: true });
});

describe('AlbumTags.sync: opening a folder', () => {
  it('brings the sidecar results into the catalogue, by content key', () => {
    writeSidecar({ 'a.jpg': { [describeSmall.id]: { contentKey: 'ck-a', description: 'A dog.', objects: [{ label: 'dog', count: 1 }] } } });
    expect(albumTags.sync([photo('a')])).toEqual(['ck-a']);
    expect(tag('ck-a', describeSmall.id)).toMatchObject({ status: 'done', description: 'A dog.', objects: [{ label: 'dog', count: 1 }] });
  });

  it('a result made from another picture (the file was replaced) is not given to the photo', () => {
    writeSidecar({ 'a.jpg': { [describeSmall.id]: { contentKey: 'old-picture', description: 'Wrong.' } } });
    expect(albumTags.sync([photo('a')])).toEqual([]);
    expect(tag('ck-a', describeSmall.id)).toBeUndefined();
  });

  it('a renamed photo finds its result by content key, and gets it under its new name too', () => {
    writeSidecar({ 'old-name.jpg': { [describeSmall.id]: { contentKey: 'ck-a', description: 'A dog.' } } });
    albumTags.sync([photo('new-name', 'ck-a')]);
    expect(tag('ck-a', describeSmall.id)?.description).toBe('A dog.');
    store.flush();
    expect(sidecar()['new-name.jpg'].models[describeSmall.id]).toMatchObject({ contentKey: 'ck-a', description: 'A dog.' });
    expect(sidecar()['old-name.jpg']).toBeTruthy();
  });

  it('a keywords result comes in with its vector; without one it is left for the model to redo', () => {
    writeSidecar({
      'a.jpg': { [keywordsSmall.id]: { contentKey: 'ck-a', keywords: [{ label: 'dog', score: 0.9 }] } },
      'b.jpg': { [keywordsSmall.id]: { contentKey: 'ck-b', keywords: [{ label: 'cat', score: 0.8 }] } },
    });
    writeVectors({ 'a.jpg': { [keywordsSmall.id]: { contentKey: 'ck-a', v: [0.5, 0.5] } } });
    albumTags.sync([photo('a'), photo('b')]);
    expect(tag('ck-a', keywordsSmall.id)?.keywords).toEqual([{ label: 'dog', score: 0.9 }]);
    expect([...tag('ck-a', keywordsSmall.id)!.embedding!]).toEqual([0.5, 0.5]);
    expect(tag('ck-b', keywordsSmall.id)).toBeUndefined();
  });

  it('migration: catalogue results the folder lacks are written out once (done ones only)', () => {
    catalog.putTags(row('ck-a', describeSmall.id, { description: 'A dog.', objects: [{ label: 'dog', count: 1 }] }));
    catalog.putTags(row('ck-a', keywordsSmall.id, { keywords: [{ label: 'dog', score: 0.9 }], embedding: new Float32Array([1, 0]) }));
    catalog.putTags(row('ck-b', describeSmall.id, { status: 'failed', error: 'unreadable' }));
    albumTags.sync([photo('a'), photo('b')]);
    store.flush();
    const photos = sidecar();
    expect(Object.keys(photos)).toEqual(['a.jpg']);
    expect(photos['a.jpg'].models[describeSmall.id]).toMatchObject({ contentKey: 'ck-a', description: 'A dog.' });
    expect(photos['a.jpg'].models[keywordsSmall.id]).toMatchObject({ contentKey: 'ck-a', keywords: [{ label: 'dog', score: 0.9 }] });
    expect(existsSync(join(trip, PHOTOVECTORS_NAME))).toBe(true);
    // Once: a second open has nothing to write.
    albumTags.sync([photo('a'), photo('b')]);
    expect(store.hasPending()).toBe(false);
  });

  it('the sidecar wins: a newer description there (Regenerate on another computer) replaces the catalogue one', () => {
    catalog.putTags(row('ck-a', describeSmall.id, { description: 'Old.', objects: [{ label: 'dog', count: 1 }] }));
    writeSidecar({ 'a.jpg': { [describeSmall.id]: { contentKey: 'ck-a', description: 'Newer.', objects: [{ label: 'dog', count: 1 }] } } });
    expect(albumTags.sync([photo('a')])).toEqual(['ck-a']);
    expect(tag('ck-a', describeSmall.id)?.description).toBe('Newer.');
    expect(store.hasPending()).toBe(false);
    expect(sidecar()['a.jpg'].models[describeSmall.id].description).toBe('Newer.');
  });

  it('a sidecar result replaces a failed catalogue row', () => {
    catalog.putTags(row('ck-a', describeSmall.id, { status: 'failed', error: 'unreadable' }));
    writeSidecar({ 'a.jpg': { [describeSmall.id]: { contentKey: 'ck-a', description: 'A dog.' } } });
    albumTags.sync([photo('a')]);
    expect(tag('ck-a', describeSmall.id)).toMatchObject({ status: 'done', description: 'A dog.' });
  });

  it('a keywords result whose vector is missing from the folder gets it from the catalogue', () => {
    catalog.putTags(row('ck-a', keywordsSmall.id, { keywords: [{ label: 'dog', score: 0.9 }], embedding: new Float32Array([1, 0]) }));
    writeSidecar({ 'a.jpg': { [keywordsSmall.id]: { contentKey: 'ck-a', keywords: [{ label: 'dog', score: 0.9 }] } } });
    albumTags.sync([photo('a')]);
    store.flush();
    const kw = store.read(trip).results.find((r) => r.modelId === keywordsSmall.id)!;
    expect([...kw.embedding!]).toEqual([1, 0]);
  });

  it('a broken sidecar imports nothing and is left alone', () => {
    writeFileSync(join(trip, PHOTOTAGS_NAME), '{oops');
    catalog.putTags(row('ck-a', describeSmall.id, { description: 'A dog.' }));
    albumTags.sync([photo('a')]);
    store.flush();
    expect(readFileSync(join(trip, PHOTOTAGS_NAME), 'utf8')).toBe('{oops');
    expect(tag('ck-a', describeSmall.id)?.description).toBe('A dog.');
  });
});

describe('opening an album with a sidecar through the server', () => {
  /** A backend that records every call (none are expected) and describes from the file name. */
  const recording = () => {
    const calls: string[] = [];
    const backend: TaggerBackend = {
      async load() {},
      async describe(p) { calls.push(`describe:${p}`); return { description: 'From the model.', objects: [] }; },
      async caption(p) { calls.push(`caption:${p}`); return 'Again.'; },
      async keywords(p) { calls.push(`keywords:${p}`); return { keywords: [{ label: 'model', score: 0.9 }], embedding: new Float32Array([0, 1]) }; },
      async embedText() { return new Float32Array([1, 0]); },
      async close() {},
    };
    return { calls, backend };
  };

  it('a moved or reinstalled album shows its tags at once, and its photos are not tagged again', async () => {
    const sharp = (await import('sharp')).default;
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c04020' } }).jpeg().toFile(join(trip, 'harbour.jpg'));
    const dataDir = join(root, 'fresh-data');
    const { calls, backend } = recording();
    const { app, close } = createGalleryApp(dataDir, {
      photoInfoFallbackDir: join(root, 'fallback'),
      tagging: { fetch: fakeFetch(), catalogue: FAKE_CATALOGUE, backend, imageOf: async (p) => p.path },
    });
    const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    };
    try {
      for (const id of [describeSmall.id, keywordsSmall.id]) {
        expect((await api('POST', `/api/gallery/models/${id}/download`)).status).toBe(202);
        for (let i = 0; i < 300 && (await api('GET', '/api/gallery/models')).body.downloading; i++) await new Promise((r) => setTimeout(r, 10));
      }
      // Work out the content key the way the scan will: open once with tagging off, read it, close.
      expect((await api('PUT', '/api/gallery/tagging/settings', { describe: null, keywords: null, paused: false })).status).toBe(200);
      let job = (await api('POST', '/api/gallery/open', { folder: trip, recursive: false })).body.jobId;
      for (let i = 0; i < 300 && !(await api('GET', `/api/gallery/jobs/${job}`)).body.done; i++) await new Promise((r) => setTimeout(r, 10));
      const key = (await api('GET', `/api/gallery/items?job=${job}`)).body[0].contentKey as string;
      // Closed before the models are chosen, so nothing is tagged until it is opened again.
      expect((await api('POST', '/api/gallery/tagging/close', { job })).status).toBe(204);
      writeSidecar({ 'harbour.jpg': { [describeSmall.id]: { contentKey: key, description: 'Written on another computer.', objects: [{ label: 'boat', count: 3 }] }, [keywordsSmall.id]: { contentKey: key, keywords: [{ label: 'boat', score: 0.9 }] } } });
      writeVectors({ 'harbour.jpg': { [keywordsSmall.id]: { contentKey: key, v: [1, 0] } } });

      expect((await api('PUT', '/api/gallery/tagging/settings', { describe: describeSmall.id, keywords: keywordsSmall.id, paused: false })).status).toBe(200);
      job = (await api('POST', '/api/gallery/open', { folder: trip, recursive: false })).body.jobId;
      let status = (await api('GET', '/api/gallery/tagging/status')).body;
      for (let i = 0; i < 300 && !(status.job === job && status.done === 1); i++) {
        await new Promise((r) => setTimeout(r, 10));
        status = (await api('GET', '/api/gallery/tagging/status')).body;
      }
      expect(status).toMatchObject({ job, total: 1, done: 1, failed: 0 });
      const [item] = (await api('GET', `/api/gallery/items?job=${job}`)).body;
      expect(item.tags).toMatchObject({ state: 'done', description: 'Written on another computer.', keywords: ['boat'], objects: [{ label: 'boat', count: 3 }] });
      // Search by meaning works from the vector in the album folder.
      expect((await api('GET', `/api/gallery/search?job=${job}&q=boats`)).body.paths).toEqual([join(trip, 'harbour.jpg')]);
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      close();
    }
  });
});

describe('fix round 1: matching a photo on any computer', () => {
  it('the content key depends on how this computer encoded the thumbnail (so it is only a hint across computers)', async () => {
    const sharp = (await import('sharp')).default;
    const src = join(trip, 'src.png');
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#808080' } })
      .composite([{ input: Buffer.from('<svg width="64" height="48"><circle cx="20" cy="20" r="15" fill="#c04020"/><rect x="35" y="10" width="20" height="30" fill="#2040c0"/></svg>') }])
      .png().toFile(src);
    // The same picture through two JPEG encoders (as a different sharp/mozjpeg build would make it).
    await sharp(src).jpeg({ quality: 82, mozjpeg: true }).toFile(join(trip, 'a.jpg'));
    await sharp(src).jpeg({ quality: 82, mozjpeg: false }).toFile(join(trip, 'b.jpg'));
    expect(await contentKeyOf(join(trip, 'a.jpg'))).not.toBe(await contentKeyOf(join(trip, 'b.jpg')));
  });

  it('the file key is the same for a copy under another name, folder or time, and changes with the bytes', async () => {
    const bytes = Buffer.alloc(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    writeFileSync(join(trip, 'a.jpg'), bytes);
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere', 'renamed.jpg'), bytes);
    utimesSync(join(root, 'elsewhere', 'renamed.jpg'), new Date('2020-01-01'), new Date('2020-01-01'));
    const k = fileKeyOf(join(trip, 'a.jpg'));
    expect(k).toMatch(/^fk1:\d+:[0-9a-f]{40}$/);
    expect(fileKeyOf(join(root, 'elsewhere', 'renamed.jpg'))).toBe(k);
    bytes[99_999] ^= 1;
    writeFileSync(join(trip, 'a.jpg'), bytes);
    expect(fileKeyOf(join(trip, 'a.jpg'))).not.toBe(k);
    expect(fileKeyOf(join(trip, 'missing.jpg'))).toBeUndefined();
  });

  it('a result made on another computer (other content key) is found by the file key; its key in the file is left as it was', () => {
    writeFileSync(join(trip, 'a.jpg'), 'the photo bytes');
    const fk = fileKeyOf(join(trip, 'a.jpg'))!;
    writeSidecar({ 'a.jpg': { [describeSmall.id]: { contentKey: 'their-content-key', fileKey: fk, description: 'From the other computer.' } } });
    expect(albumTags.sync([{ ...photo('a', 'my-content-key'), size: statSync(join(trip, 'a.jpg')).size }])).toEqual(['my-content-key']);
    expect(tag('my-content-key', describeSmall.id)?.description).toBe('From the other computer.');
    store.flush();
    expect(sidecar()['a.jpg'].models[describeSmall.id].contentKey).toBe('their-content-key');
  });

  it('results written from here carry the file key', () => {
    writeFileSync(join(trip, 'a.jpg'), 'the photo bytes');
    catalog.putTags(row('ck-a', describeSmall.id, { description: 'A dog.' }));
    albumTags.sync([photo('a')]);
    albumTags.save([photo('a')], row('ck-a', keywordsSmall.id, { keywords: [{ label: 'dog', score: 1 }], embedding: new Float32Array([1]) }));
    store.flush();
    const models = sidecar()['a.jpg'].models;
    expect(models[describeSmall.id].fileKey).toBe(fileKeyOf(join(trip, 'a.jpg')));
    expect(models[keywordsSmall.id].fileKey).toBe(fileKeyOf(join(trip, 'a.jpg')));
  });
});

describe('fix round 1: opening a big album', () => {
  it('one index build for a whole folder, however many photos are synced one by one', () => {
    const n = 5000;
    const photos: Record<string, Record<string, Record<string, unknown>>> = {};
    for (let i = 0; i < n; i++) photos[`p${i}.jpg`] = { [describeSmall.id]: { contentKey: `ck-p${i}`, description: `P${i}.` } };
    writeSidecar(photos);
    const t = Date.now();
    for (let i = 0; i < n; i++) albumTags.sync([photo(`p${i}`)]);
    const ms = Date.now() - t;
    expect(store.stats.indexBuilds).toBe(1);
    expect(tag('ck-p4999', describeSmall.id)?.description).toBe('P4999.');
    expect(ms).toBeLessThan(5_000);
  }, 30_000);
});

describe('fix round 1: a folder whose tags file cannot be read just now', () => {
  it('holds its photos (not tagged, nothing imported) until it can be read, then imports them', () => {
    writeSidecar({ 'a.jpg': { [describeSmall.id]: { contentKey: 'ck-a', description: 'Saved.' } } });
    let locked = true;
    const s2 = new AlbumTagsStore({
      fallbackDir: join(root, 'fallback'), unreadableRetryMs: 0, onError: () => {},
      readFile: (p) => { if (locked && p.endsWith(PHOTOTAGS_NAME)) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return readFileSync(p, 'utf8'); },
    });
    const at = new AlbumTags({ catalog, store: s2, catalogue: FAKE_CATALOGUE });
    const a = photo('a');
    expect(at.sync([a])).toEqual([]);
    expect(at.holds(a)).toBe(true);
    expect(at.retryDeferred()).toEqual([]);
    locked = false;
    expect(at.retryDeferred()).toEqual(['ck-a']);
    expect(at.holds(a)).toBe(false);
    expect(tag('ck-a', describeSmall.id)?.description).toBe('Saved.');
    s2.close();
  });
});

describe('fix round 1: a file that never becomes readable', () => {
  it('holds its photos only for a while; then they are tagged (results kept in the catalogue, the file left alone)', () => {
    writeSidecar({});
    const s2 = new AlbumTagsStore({
      fallbackDir: join(root, 'fallback'), unreadableRetryMs: 0, onError: () => {},
      readFile: (p) => { if (p.endsWith(PHOTOTAGS_NAME)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return readFileSync(p, 'utf8'); },
    });
    let now = 1_000_000;
    const at = new AlbumTags({ catalog, store: s2, catalogue: FAKE_CATALOGUE, maxHoldMs: 600_000, now: () => now });
    const a = photo('a');
    at.sync([a]);
    expect(at.holds(a)).toBe(true);
    now += 600_001;
    expect(at.holds(a)).toBe(false);
    s2.close();
  });
});

describe('fix round 1: opening a tagged album reads no photo files', () => {
  it('a folder fully tagged here (real files, file keys in the sidecar) syncs without working out a single file key', () => {
    const photos: Record<string, Record<string, Record<string, unknown>>> = {};
    const list: GalleryPhoto[] = [];
    for (let i = 0; i < 50; i++) {
      const path = join(trip, `p${i}.jpg`);
      writeFileSync(path, `photo number ${i} `.repeat(10 + i));
      photos[`p${i}.jpg`] = { [describeSmall.id]: { contentKey: `ck-p${i}`, fileKey: fileKeyOf(path), description: `P${i}.` } };
      list.push({ ...photo(`p${i}`), size: statSync(path).size });
    }
    // An untagged photo too.
    writeFileSync(join(trip, 'new.jpg'), 'a photo nobody has tagged yet');
    list.push({ ...photo('new'), size: statSync(join(trip, 'new.jpg')).size });
    writeSidecar(photos);
    const spy = vi.spyOn(albumTags, 'fileKeyOf');
    for (const p of list) albumTags.sync([p]);
    expect(spy).not.toHaveBeenCalled();
    expect(tag('ck-p49', describeSmall.id)?.description).toBe('P49.');
  });

  it('the file key starts with the file size, so other sizes are ruled out without reading', () => {
    writeFileSync(join(trip, 'a.jpg'), 'x'.repeat(1234));
    expect(fileKeyOf(join(trip, 'a.jpg'))).toMatch(/^fk1:1234:[0-9a-f]{40}$/);
  });
});

describe('fix round 1: file keys are kept in the catalogue', () => {
  it('a later run (a new AlbumTags) does not read the photo file again while it is unchanged', () => {
    writeFileSync(join(trip, 'a.jpg'), 'the photo bytes');
    const p = { ...photo('a'), size: statSync(join(trip, 'a.jpg')).size, mtimeMs: statSync(join(trip, 'a.jpg')).mtimeMs };
    const k = albumTags.fileKeyOf(p);
    expect(k).toBe(fileKeyOf(join(trip, 'a.jpg')));
    // The file changes on disk but the catalogue's row is for the same size and time: the kept key is used.
    const later = new AlbumTags({ catalog, store, catalogue: FAKE_CATALOGUE });
    rmSync(join(trip, 'a.jpg'));
    expect(later.fileKeyOf(p)).toBe(k);
    // Another size or time is another file: worked out again (here: gone, so none).
    expect(later.fileKeyOf({ ...p, mtimeMs: p.mtimeMs + 1 })).toBeUndefined();
  });
});
