// The background tagging queue: one photo at a time, selected photo first, results kept by content key.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelChoice, TagPart } from '../src/core/tagModels';
import { Catalog, type GalleryPhoto } from '../src/gallery/server/catalog';
import { downloadModel } from '../src/gallery/server/models/download';
import { modelDir, type TaggingSettings } from '../src/gallery/server/models/store';
import { ModelLoadError, type TaggerBackend } from '../src/gallery/server/tagging/backend';
import { TaggingQueue } from '../src/gallery/server/tagging/queue';
import { FAKE_CATALOGUE, fakeFetch } from './support/fakeTagging';

const [describeSmall, describeLarge, keywordsSmall, keywordsLarge] = FAKE_CATALOGUE;

let root: string;
let dataDir: string;
let catalog: Catalog;
let queue: TaggingQueue | undefined;

/** A backend whose calls are recorded; `hold` makes every call wait until released. */
function testBackend() {
  const calls: string[] = [];
  const loads: string[] = [];
  let failLoad: TagPart | null = null;
  const failOn = new Set<string>();
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const name = (p: string) => p.split(/[\\/]/).pop()!.replace('.img', '');
  const backend: TaggerBackend = {
    async load(part, model) {
      loads.push(`${part}:${model.id}`);
      if (failLoad === part) throw new ModelLoadError('broken model');
    },
    async describe(path) {
      calls.push(`describe:${name(path)}`);
      if (gate) await gate;
      if (failOn.has(name(path))) throw new Error('unreadable');
      return { description: `About ${name(path)}.`, objects: [{ label: 'thing', count: 1 }] };
    },
    async keywords(path) {
      calls.push(`keywords:${name(path)}`);
      if (gate) await gate;
      if (failOn.has(name(path))) throw new Error('unreadable');
      return { keywords: [{ label: name(path), score: 0.9 }], embedding: new Float32Array([1, 0]) };
    },
    async embedText() {
      return new Float32Array([1, 0]);
    },
    async close() {},
  };
  return {
    backend, calls, loads, failOn,
    failLoadOf: (p: TagPart | null) => (failLoad = p),
    hold: () => (gate = new Promise((r) => (release = r))),
    releaseAll: () => {
      gate = null;
      release?.();
    },
    /** Lets the calls waiting now go on; the next ones wait again. */
    step: () => {
      const r = release;
      gate = new Promise((res) => (release = res));
      r?.();
    },
  };
}

const photo = (name: string, contentKey = `ck-${name}`): GalleryPhoto => {
  const path = join(root, 'trip', `${name}.jpg`);
  writeFileSync(path, 'x');
  return {
    path, folder: join(root, 'trip'), fileName: `${name}.jpg`, relDir: '', size: 1, mtimeMs: 1, width: 10, height: 10, format: 'jpeg',
    capturedAt: null, gpsLat: null, gpsLon: null, camera: null, exif: null, analysis: null, key: `k-${name}`, contentKey,
  };
};

const settings = (s: Partial<TaggingSettings>): TaggingSettings => ({ describe: null, keywords: null, paused: false, ...s });
const install = async (...models: ModelChoice[]) => {
  for (const m of models) await downloadModel(dataDir, m, { fetch: fakeFetch() });
};
const makeQueue = (b: TaggerBackend) =>
  (queue = new TaggingQueue({ catalog, backend: b, dataDir, catalogue: FAKE_CATALOGUE, imageOf: async (p) => join(root, 'img', `${p.fileName.replace('.jpg', '')}.img`) }));
const idle = async (q: TaggingQueue) => {
  for (let i = 0; i < 400 && q.status().running; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tag-queue-'));
  dataDir = join(root, 'data');
  mkdirSync(join(root, 'trip'));
  mkdirSync(join(root, 'img'));
  catalog = new Catalog(dataDir);
});
afterEach(async () => {
  await queue?.stop();
  queue = undefined;
  catalog.close();
  rmSync(root, { recursive: true, force: true });
});

describe('tagging queue', () => {
  it('starts only when the scan is done and a part is chosen and installed', async () => {
    const t = testBackend();
    const q = makeQueue(t.backend);
    const list = [photo('a')];
    q.setSettings(settings({ describe: describeSmall.id }));
    q.startJob('j1', () => list);
    await idle(q);
    expect(t.calls).toEqual([]); // chosen but not installed
    await install(describeSmall);
    q.setSettings(settings({ describe: describeSmall.id }));
    await idle(q);
    expect(t.calls).toEqual(['describe:a']);
    expect(t.loads).toEqual([`describe:${describeSmall.id}`]);
  });

  it('nothing runs before startJob, even with a model chosen', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    await idle(q);
    expect(t.calls).toEqual([]);
    expect(q.status()).toMatchObject({ job: null, running: false, total: 0 });
  });

  it('tags the focused photo first, then the shown ones in order, then the rest', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    const list = ['a', 'b', 'c', 'd', 'e'].map((n) => photo(n));
    q.setSettings(settings({ describe: describeSmall.id }));
    q.focus(['d', 'b', 'e'].map((n) => list.find((p) => p.fileName === `${n}.jpg`)!.path));
    q.startJob('j1', () => list);
    await idle(q);
    expect(t.calls).toEqual(['describe:d', 'describe:b', 'describe:e', 'describe:a', 'describe:c']);
  });

  it('skips photos already done for that model; a renamed photo with the same content key is not redone', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    q.startJob('j1', () => [photo('a'), photo('b')]);
    await idle(q);
    expect(t.calls).toEqual(['describe:a', 'describe:b']);
    q.startJob('j2', () => [photo('a-renamed', 'ck-a'), photo('b'), photo('c')]);
    await idle(q);
    expect(t.calls).toEqual(['describe:a', 'describe:b', 'describe:c']);
    expect(catalog.tagsFor(['ck-a'], [describeSmall.id]).get('ck-a')![0].description).toBe('About a.');
  });

  it('a backend error marks the photo failed and moves on; failed photos are not retried', async () => {
    await install(describeSmall);
    const t = testBackend();
    t.failOn.add('a');
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    q.startJob('j1', () => [photo('a'), photo('b')]);
    await idle(q);
    expect(t.calls).toEqual(['describe:a', 'describe:b']);
    expect(catalog.tagsFor(['ck-a'], [describeSmall.id]).get('ck-a')![0]).toMatchObject({ status: 'failed', error: 'unreadable' });
    expect(q.status()).toMatchObject({ total: 2, done: 1, failed: 1, running: false });
    q.startJob('j2', () => [photo('a'), photo('b')]);
    await idle(q);
    expect(t.calls).toHaveLength(2);
  });

  it('pause holds after the current photo; resume carries on; status counts done and failed', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    t.hold();
    q.startJob('j1', () => [photo('a'), photo('b'), photo('c')]);
    for (let i = 0; i < 100 && !t.calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    q.setSettings(settings({ describe: describeSmall.id, paused: true }));
    t.releaseAll();
    await idle(q);
    expect(t.calls).toEqual(['describe:a']);
    expect(q.status()).toMatchObject({ paused: true, running: false, done: 1, total: 3 });
    q.setSettings(settings({ describe: describeSmall.id, paused: false }));
    await idle(q);
    expect(t.calls).toEqual(['describe:a', 'describe:b', 'describe:c']);
    expect(q.status()).toMatchObject({ paused: false, done: 3, failed: 0, total: 3 });
  });

  it('switching the keywords model re-tags every photo for keywords', async () => {
    await install(keywordsSmall, keywordsLarge);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ keywords: keywordsSmall.id }));
    q.startJob('j1', () => [photo('a'), photo('b')]);
    await idle(q);
    q.setSettings(settings({ keywords: keywordsLarge.id }));
    await idle(q);
    expect(t.calls).toEqual(['keywords:a', 'keywords:b', 'keywords:a', 'keywords:b']);
    expect(t.loads).toEqual([`keywords:${keywordsSmall.id}`, `keywords:${keywordsLarge.id}`]);
    // The old model's rows are kept.
    expect(catalog.tagsFor(['ck-a'], [keywordsSmall.id]).get('ck-a')).toHaveLength(1);
  });

  it('a photo deleted or a folder closed mid-photo: no crash, no row for the gone photo, the queue stops for that job', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    const list = [photo('a'), photo('b'), photo('c')];
    t.hold();
    q.startJob('j1', () => list);
    for (let i = 0; i < 100 && !t.calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    rmSync(list[0].path); // deleted while being looked at
    t.step();
    for (let i = 0; i < 100 && t.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(catalog.tagsFor(['ck-a'], [describeSmall.id]).size).toBe(0);
    q.clearJob(); // another folder opened while b is being looked at
    t.releaseAll();
    await idle(q);
    expect(t.calls).toEqual(['describe:a', 'describe:b']);
    expect(catalog.tagsFor(['ck-b', 'ck-c'], [describeSmall.id]).size).toBe(0);
    expect(q.status()).toMatchObject({ job: null, running: false });
  });

  it('a model that fails to load is reported in notWorking and that part does not run', async () => {
    await install(describeSmall, keywordsSmall);
    const t = testBackend();
    t.failLoadOf('describe');
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id, keywords: keywordsSmall.id }));
    q.startJob('j1', () => [photo('a')]);
    await idle(q);
    expect(q.status().notWorking).toEqual(['describe']);
    expect(t.calls).toEqual(['keywords:a']);
  });

  it('a damaged model folder is reported in notWorking without loading it', async () => {
    await install(describeSmall);
    rmSync(join(modelDir(dataDir, describeSmall.id), describeSmall.files[1].path));
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    q.startJob('j1', () => [photo('a')]);
    await idle(q);
    expect(q.status().notWorking).toEqual(['describe']);
    expect(t.loads).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('stamp bumps after each photo\'s tags are written', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    const before = q.status().stamp;
    q.setSettings(settings({ describe: describeSmall.id }));
    q.startJob('j1', () => [photo('a'), photo('b')]);
    await idle(q);
    expect(q.status().stamp).toBe(before + 2);
  });

  it('the large describe model is not used when the small one is chosen', async () => {
    await install(describeSmall, describeLarge);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    q.startJob('j1', () => [photo('a')]);
    await idle(q);
    expect(t.loads).toEqual([`describe:${describeSmall.id}`]);
  });
});

describe('tagging through the server', () => {
  it('opening a folder with a model chosen tags its photos; status and items follow; a bad focus body is a 400', async () => {
    const { createGalleryApp } = await import('../src/gallery/server/app');
    const { fakeBackend } = await import('./support/fakeTagging');
    const sharp = (await import('sharp')).default;
    for (const n of ['harbour', 'lake']) await sharp({ create: { width: 40, height: 30, channels: 3, background: n === 'lake' ? '#2040c0' : '#c04020' } }).jpeg().toFile(join(root, 'trip', `${n}.jpg`));
    const { app, close } = createGalleryApp(dataDir, {
      photoInfoFallbackDir: join(root, 'fallback'),
      tagging: { fetch: fakeFetch(), catalogue: FAKE_CATALOGUE, backend: fakeBackend(), imageOf: async (p) => p.path },
    });
    const server = await new Promise<import('node:http').Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    };
    try {
      expect((await api('POST', `/api/gallery/models/${keywordsSmall.id}/download`)).status).toBe(202);
      for (let i = 0; i < 200 && (await api('GET', '/api/gallery/models')).body.downloading; i++) await new Promise((r) => setTimeout(r, 10));
      expect((await api('PUT', '/api/gallery/tagging/settings', { describe: null, keywords: keywordsSmall.id, paused: false })).status).toBe(200);
      const { jobId } = (await api('POST', '/api/gallery/open', { folder: join(root, 'trip'), recursive: false })).body;
      expect((await api('POST', '/api/gallery/tagging/focus', { job: jobId, paths: 'nope' })).status).toBe(400);
      expect((await api('POST', '/api/gallery/tagging/focus', { job: jobId, paths: [join(root, 'trip', 'lake.jpg')] })).status).toBe(204);
      let status = (await api('GET', '/api/gallery/tagging/status')).body;
      for (let i = 0; i < 300 && !(status.job === jobId && status.done === 2); i++) {
        await new Promise((r) => setTimeout(r, 10));
        status = (await api('GET', '/api/gallery/tagging/status')).body;
      }
      expect(status).toMatchObject({ job: jobId, total: 2, done: 2, failed: 0, running: false, notWorking: [] });
      expect(status.stamp).toBeGreaterThanOrEqual(2);
      const items = (await api('GET', `/api/gallery/items?job=${jobId}`)).body as { fileName: string; tags: { state: string; keywords: string[] } }[];
      expect(items.map((i) => [i.fileName, i.tags.state, i.tags.keywords])).toEqual(
        expect.arrayContaining([['harbour.jpg', 'done', ['harbour']], ['lake.jpg', 'done', ['lake']]]),
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      close();
    }
  });
});
