// The background tagging queue: one photo at a time, selected photo first, results kept by content key.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelChoice, TagPart } from '../core/tagModels';
import { Catalog, type GalleryPhoto } from '../server/catalog';
import { downloadModel } from '../server/models/download';
import { modelDir, type TaggingSettings } from '../server/models/store';
import { BackendLostError, ModelLoadError, type TaggerBackend } from '../server/tagging/backend';
import { NoDescriptionError, TaggingQueue } from '../server/tagging/queue';
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
  let loadGate: Promise<void> | null = null;
  let releaseLoad: (() => void) | null = null;
  // What the (pretend) worker has loaded: a restart forgets it; `forgetAlways` forgets after every load.
  const inWorker = new Set<TagPart>();
  let forgetAlways = false;
  const name = (p: string) => p.split(/[\\/]/).pop()!.replace('.img', '');
  const backend: TaggerBackend = {
    async load(part, model) {
      loads.push(`${part}:${model.id}`);
      if (loadGate) await loadGate;
      if (failLoad === part) throw new ModelLoadError('broken model');
      if (!forgetAlways) inWorker.add(part);
    },
    async describe(path) {
      if (!inWorker.has('describe')) throw new BackendLostError('The tagging worker stopped.');
      calls.push(`describe:${name(path)}`);
      if (gate) await gate;
      if (failOn.has(name(path))) throw new Error('unreadable');
      return { description: `About ${name(path)}.`, objects: [{ label: 'thing', count: 1 }] };
    },
    async caption(path) {
      if (!inWorker.has('describe')) throw new BackendLostError('The tagging worker stopped.');
      calls.push(`caption:${name(path)}`);
      if (gate) await gate;
      if (failOn.has(name(path))) throw new Error('unreadable');
      return `Again ${name(path)} (${calls.filter((c) => c.startsWith('caption:')).length}).`;
    },
    async keywords(path) {
      if (!inWorker.has('keywords')) throw new BackendLostError('The tagging worker stopped.');
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
    /** The worker restarts: it forgets every model. */
    restart: () => inWorker.clear(),
    /** Every load "succeeds" but the worker dies straight after. */
    forgetAlways: () => {
      forgetAlways = true;
      inWorker.clear();
    },
    holdLoad: () => (loadGate = new Promise((r) => (releaseLoad = r))),
    releaseLoad: () => {
      loadGate = null;
      releaseLoad?.();
    },
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

  it('a deleted photo does not stop another photo with the same content from being tagged, in this job or a later one', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    // a and a-copy are the same picture; a is deleted after the scan.
    const gone = photo('a');
    rmSync(gone.path);
    q.focus([gone.path]);
    q.startJob('j1', () => [gone, photo('b')]);
    await idle(q);
    expect(t.calls).toEqual(['describe:b']);
    expect(q.status()).toMatchObject({ total: 2, done: 2 });
    // Another folder with a copy of it: looked at, as its content was never tagged.
    q.startJob('j2', () => [photo('a-copy', 'ck-a')]);
    await idle(q);
    expect(t.calls).toEqual(['describe:b', 'describe:a-copy']);
    expect(catalog.tagsFor(['ck-a'], [describeSmall.id]).get('ck-a')?.[0].description).toBe('About a-copy.');
  });

  it('a worker that restarts mid-folder: the model is loaded again and no photo is marked failed', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    const list = ['a', 'b', 'c', 'd'].map((n) => photo(n));
    t.hold();
    q.startJob('j1', () => list);
    for (let i = 0; i < 100 && !t.calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    t.restart(); // the worker dies while a is being looked at; a's own call still answers
    t.releaseAll();
    await idle(q);
    expect(t.loads).toEqual([`describe:${describeSmall.id}`, `describe:${describeSmall.id}`]);
    expect(q.status()).toMatchObject({ total: 4, done: 4, failed: 0, notWorking: [] });
    const rows = catalog.tagsFor(['ck-a', 'ck-b', 'ck-c', 'ck-d'], [describeSmall.id]);
    expect([...rows.values()].map((r) => r[0].status)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('a worker that keeps dying: that part is reported not working after a few tries, and no photo is marked failed', async () => {
    await install(describeSmall);
    const t = testBackend();
    t.forgetAlways();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    q.startJob('j1', () => ['a', 'b', 'c'].map((n) => photo(n)));
    await idle(q);
    expect(t.loads.length).toBeLessThanOrEqual(4);
    expect(q.status()).toMatchObject({ notWorking: ['describe'], failed: 0, running: false });
    expect(catalog.tagsFor(['ck-a', 'ck-b', 'ck-c'], [describeSmall.id]).size).toBe(0);
  });

  it('a folder opened while a model is loading is tagged once the load finishes', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    t.holdLoad();
    q.startJob('j1', () => [photo('a')]);
    for (let i = 0; i < 100 && !t.loads.length; i++) await new Promise((r) => setTimeout(r, 5));
    q.clearJob(); // another folder is being opened while the model loads
    q.startJob('j2', () => [photo('b')]);
    t.releaseLoad();
    await idle(q);
    expect(t.calls).toEqual(['describe:b']);
    expect(q.status()).toMatchObject({ job: 'j2', done: 1 });
  });

  it('a catalogue write that fails stops tagging with a problem in the status, never an unhandled error', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    vi.spyOn(catalog, 'putTags').mockImplementation(() => {
      throw new Error('database or disk is full');
    });
    q.setSettings(settings({ describe: describeSmall.id }));
    q.startJob('j1', () => [photo('a'), photo('b')]);
    await idle(q);
    expect(q.status()).toMatchObject({ running: false, problem: expect.stringMatching(/disk is full/) });
    expect(t.calls).toEqual(['describe:a']);
    vi.restoreAllMocks();
    // Asked again (a refresh, a setting): it carries on, and the problem is gone.
    q.refresh();
    await idle(q);
    expect(q.status()).toMatchObject({ done: 2, problem: null });
  });

  it('started paused, a folder already tagged counts as done (not 0 of N)', async () => {
    await install(describeSmall);
    const list = [photo('a'), photo('b')];
    const first = makeQueue(testBackend().backend);
    first.setSettings(settings({ describe: describeSmall.id }));
    first.startJob('j1', () => list);
    await idle(first);
    await first.stop();
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id, paused: true }));
    q.startJob('j2', () => list);
    expect(q.status()).toMatchObject({ total: 2, done: 2, running: false, paused: true });
    expect(t.calls).toEqual([]);
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

  it('a big folder: each photo is looked up in the catalogue about once, not once per photo tagged', async () => {
    await install(keywordsSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    // Big enough to tell "once per photo" (N keys) from "once per photo tagged" (about N²/2), small
    // enough that writing the files and catalogue rows fits a slow CI runner.
    const N = 400;
    const list = Array.from({ length: N }, (_, i) => photo(`p${i}`, `ck${i}`));
    for (let i = 0; i < N; i += 2) catalog.putTags({ contentKey: `ck${i}`, modelId: keywordsSmall.id, status: 'done', description: null, keywords: [], objects: [], embedding: null, error: null });
    const keysAsked = { n: 0 };
    const real = catalog.tagsFor.bind(catalog);
    const spy = vi.spyOn(catalog, 'tagsFor').mockImplementation((keys, models) => {
      keysAsked.n += keys.length;
      return real(keys, models);
    });
    let listCalls = 0;
    q.setSettings(settings({ keywords: keywordsSmall.id }));
    q.startJob('j1', () => {
      listCalls++;
      return list;
    });
    await vi.waitFor(() => expect(q.status().done).toBe(N), { timeout: 30_000, interval: 5 });
    await idle(q);
    spy.mockRestore();
    expect(t.calls).toHaveLength(N / 2);
    expect(q.status()).toMatchObject({ done: N, total: N });
    expect(keysAsked.n).toBeLessThan(2 * N);
    expect(listCalls).toBeGreaterThan(0);
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

describe('#2 regenerate a description', () => {
  const described = async (q: TaggingQueue, list: GalleryPhoto[]) => {
    q.startJob('j1', () => list);
    await idle(q);
  };
  const row = (key: string, id = describeSmall.id) => catalog.tagsFor([key], [id]).get(key)?.[0];

  it('new text replaces the old in the catalogue; objects are kept; stamp bumps; nothing else is looked at again', async () => {
    await install(describeSmall, keywordsSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id, keywords: keywordsSmall.id }));
    const a = photo('a');
    await described(q, [a]);
    const before = q.status().stamp;
    expect(await q.regenerate(a)).toBe('Again a (1).');
    expect(row('ck-a')).toMatchObject({ status: 'done', description: 'Again a (1).', objects: [{ label: 'thing', count: 1 }] });
    expect(await q.regenerate(a)).toBe('Again a (2).');
    expect(row('ck-a')?.description).toBe('Again a (2).');
    expect(row('ck-a', keywordsSmall.id)?.keywords).toEqual([{ label: 'a', score: 0.9 }]);
    expect(q.status().stamp).toBe(before + 2);
    expect(t.calls).toEqual(['describe:a', 'keywords:a', 'caption:a', 'caption:a']);
  });

  it('an error when no describe model is chosen, it is not installed, or it is broken; and when this photo has no description from it yet', async () => {
    const t = testBackend();
    const q = makeQueue(t.backend);
    const a = photo('a');
    q.setSettings(settings({}));
    await expect(q.regenerate(a)).rejects.toBeInstanceOf(NoDescriptionError);
    q.setSettings(settings({ describe: describeSmall.id }));
    await expect(q.regenerate(a)).rejects.toThrow(/no working descriptions model/i); // chosen, not installed
    await install(describeSmall);
    q.setSettings(settings({ describe: describeSmall.id, paused: true }));
    await expect(q.regenerate(a)).rejects.toThrow(/has not described this photo yet/i); // installed, but not looked at yet
    t.failLoadOf('describe');
    q.setSettings(settings({ describe: describeSmall.id, paused: true }));
    catalog.putTags({ contentKey: 'ck-a', modelId: describeSmall.id, status: 'done', description: 'Old.', keywords: [], objects: [], embedding: null, error: null });
    await expect(q.regenerate(a)).rejects.toBeInstanceOf(NoDescriptionError); // will not load
    expect(q.status().notWorking).toEqual(['describe']);
    expect(row('ck-a')?.description).toBe('Old.');
    expect(t.calls).toEqual([]);
  });

  it('a backend error keeps the old text and is thrown as it is (not a missing model)', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    const a = photo('a');
    await described(q, [a]);
    t.failOn.add('a');
    const err = await q.regenerate(a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoDescriptionError);
    expect((err as Error).message).toBe('unreadable');
    expect(row('ck-a')?.description).toBe('About a.');
  });

  it('an empty or blank caption is an error, and the old text stays; a caption is saved trimmed', async () => {
    await install(describeSmall);
    const t = testBackend();
    let reply = '  \n ';
    const q = makeQueue({ ...t.backend, caption: async () => reply });
    q.setSettings(settings({ describe: describeSmall.id }));
    const a = photo('a');
    await described(q, [a]);
    const before = q.status().stamp;
    const err = await q.regenerate(a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoDescriptionError);
    expect((err as Error).message).toMatch(/empty description/i);
    expect(row('ck-a')?.description).toBe('About a.');
    expect(q.status().stamp).toBe(before);
    reply = '';
    await expect(q.regenerate(a)).rejects.toThrow(/empty description/i);
    expect(row('ck-a')?.description).toBe('About a.');
    reply = '  A boat at dusk. \n';
    expect(await q.regenerate(a)).toBe('A boat at dusk.');
    expect(row('ck-a')?.description).toBe('A boat at dusk.');
  });

  it('a lost backend: the model is loaded again and the caption asked once more', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    const a = photo('a');
    await described(q, [a]);
    t.restart(); // the worker restarted since: it forgot the model
    expect(await q.regenerate(a)).toBe('Again a (1).');
    expect(t.loads).toEqual([`describe:${describeSmall.id}`, `describe:${describeSmall.id}`]);
    expect(row('ck-a')?.description).toBe('Again a (1).');
  });

  it('a backend lost on every try gives up with a clear error, old text kept', async () => {
    await install(describeSmall);
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id }));
    const a = photo('a');
    await described(q, [a]);
    t.forgetAlways();
    await expect(q.regenerate(a)).rejects.toBeInstanceOf(BackendLostError);
    expect(row('ck-a')?.description).toBe('About a.');
  });

  it('works while tagging is paused, loading the model when tagging has not', async () => {
    await install(describeSmall);
    catalog.putTags({ contentKey: 'ck-a', modelId: describeSmall.id, status: 'done', description: 'Old.', keywords: [], objects: [{ label: 'boat', count: 1 }], embedding: null, error: null });
    const t = testBackend();
    const q = makeQueue(t.backend);
    q.setSettings(settings({ describe: describeSmall.id, paused: true }));
    const a = photo('a');
    q.startJob('j1', () => [a, photo('b')]);
    expect(await q.regenerate(a)).toBe('Again a (1).');
    await idle(q);
    expect(t.loads).toEqual([`describe:${describeSmall.id}`]);
    expect(t.calls).toEqual(['caption:a']); // b stays untagged: still paused
    expect(row('ck-a')).toMatchObject({ description: 'Again a (1).', objects: [{ label: 'boat', count: 1 }] });
    expect(q.status()).toMatchObject({ paused: true, running: false });
  });
});

describe('tagging through the server', () => {
  it('opening a folder with a model chosen tags its photos; status and items follow; a bad focus body is a 400', async () => {
    const { createGalleryApp } = await import('../server/app');
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
