// Photo tagging through the gallery server's routes: a model that will not load, closing a folder, Pause, and
// switching a part's model (fake models; a photo "is" the words of its file name).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGalleryApp } from '../server/app';
import { ModelLoadError, type TaggerBackend } from '../server/tagging/backend';
import { modelDir } from '../server/models/store';
import { FAKE_CATALOGUE, fakeBackend, fakeFetch } from './support/fakeTagging';

const describeSmall = FAKE_CATALOGUE.find((m) => m.id === 'fake-describe-small')!;
const describeLarge = FAKE_CATALOGUE.find((m) => m.id === 'fake-describe-large')!;

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gallery-tagging-app-'));
  dataDir = join(root, 'data');
  mkdirSync(join(root, 'trip'));
  mkdirSync(join(root, 'other'));
  const sharp = (await import('sharp')).default;
  const make = (dir: string, n: string, c: string) => sharp({ create: { width: 40, height: 30, channels: 3, background: c } }).jpeg().toFile(join(root, dir, `${n}.jpg`));
  await make('trip', 'harbour', '#c04020');
  await make('trip', 'lake', '#2040c0');
  await make('trip', 'market', '#20a040');
  await make('other', 'garden', '#40c040');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A gallery server on a free port; `api` calls it. */
async function serve(backend: TaggerBackend = fakeBackend()) {
  const { app, close } = createGalleryApp(dataDir, {
    photoInfoFallbackDir: join(root, 'fallback'),
    tagging: { fetch: fakeFetch(), catalogue: FAKE_CATALOGUE, backend, imageOf: async (p) => p.path },
  });
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const download = async (id: string) => {
    expect((await api('POST', `/api/gallery/models/${id}/download`)).status).toBe(202);
    for (let i = 0; i < 300 && (await api('GET', '/api/gallery/models')).body.downloading; i++) await wait(10);
  };
  const choose = (s: { describe?: string | null; keywords?: string | null; paused?: boolean }) =>
    api('PUT', '/api/gallery/tagging/settings', { describe: null, keywords: null, paused: false, ...s });
  const open = async (dir: string): Promise<string> => (await api('POST', '/api/gallery/open', { folder: join(root, dir), recursive: false })).body.jobId;
  const status = async () => (await api('GET', '/api/gallery/tagging/status')).body;
  const until = async (ok: (s: any) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const s = await status();
      if (ok(s)) return s;
      await wait(10);
    }
    return status();
  };
  const stop = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    close();
  };
  return { api, download, choose, open, status, until, stop };
}

describe('photo tagging routes', () => {
  it('a model whose file was damaged in place (same size) fails to load: the damaged file is deleted, and Settings is told it is not working', async () => {
    const real = fakeBackend();
    const s = await serve({ ...real, load: async () => { throw new ModelLoadError('protobuf parsing failed'); } });
    try {
      await s.download(describeSmall.id);
      const big = describeSmall.files[1];
      const file = join(modelDir(dataDir, describeSmall.id), big.path);
      writeFileSync(file, Buffer.alloc(big.bytes, 9)); // same size, wrong bytes
      await s.choose({ describe: describeSmall.id });
      const job = await s.open('trip');
      await s.until((st) => st.job === job && st.notWorking.length > 0 && !st.running);
      const models = (await s.api('GET', '/api/gallery/models')).body;
      expect(models.notWorking).toEqual(['describe']);
      // The damaged file is gone, so "Download again" fetches it.
      for (let i = 0; i < 100 && existsSync(file); i++) await wait(10);
      expect(existsSync(file)).toBe(false);
      expect((await s.api('GET', '/api/gallery/models')).body.installed.find((i: { id: string }) => i.id === describeSmall.id).ok).toBe(false);
    } finally {
      await s.stop();
    }
  });

  it('closing the folder stops tagging it', async () => {
    const s = await serve(fakeBackend({ delayMs: 60 }));
    try {
      await s.download(describeSmall.id);
      await s.choose({ describe: describeSmall.id });
      const job = await s.open('trip');
      await s.until((st) => st.job === job && st.running);
      expect((await s.api('POST', '/api/gallery/tagging/close', { job })).status).toBe(204);
      const after = await s.until((st) => !st.running);
      expect(after.job).toBeNull();
      await wait(200);
      expect((await s.status()).running).toBe(false);
    } finally {
      await s.stop();
    }
  });

  it('Pause is not saved: it holds for this folder, and the next folder opened is tagged', async () => {
    const s = await serve(fakeBackend({ delayMs: 20 }));
    try {
      await s.download(describeSmall.id);
      await s.choose({ describe: describeSmall.id, paused: true });
      expect((await s.api('GET', '/api/gallery/models')).body.settings.paused).toBe(true);
      expect(JSON.parse(readFileSync(join(dataDir, 'tagging.json'), 'utf8')).paused).toBe(false);
      const job = await s.open('other');
      const st = await s.until((x) => x.job === job && x.done === 1);
      expect(st).toMatchObject({ job, done: 1, paused: false });
      expect((await s.api('GET', '/api/gallery/models')).body.settings.paused).toBe(false);
    } finally {
      await s.stop();
    }
  });

  it("switching a part's model keeps showing the old model's results until the new one has looked", async () => {
    const s = await serve();
    try {
      await s.download(describeSmall.id);
      await s.download(describeLarge.id);
      await s.choose({ describe: describeSmall.id });
      const job = await s.open('trip');
      await s.until((st) => st.job === job && st.done === 3);
      // Paused, so the large model has looked at nothing yet.
      await s.choose({ describe: describeLarge.id, paused: true });
      const items = (await s.api('GET', `/api/gallery/items?job=${job}`)).body as { fileName: string; tags: { state: string; description: string | null; objects: unknown[] } }[];
      const lake = items.find((i) => i.fileName === 'lake.jpg')!;
      expect(lake.tags.state).toBe('waiting');
      expect(lake.tags.description).toBe('A picture of lake.');
      expect(lake.tags.objects).toEqual([{ label: 'lake', count: 2 }]);
      // Another model's sentence: Regenerate is not offered for it.
      expect(lake.tags).not.toHaveProperty('canRegenerate');
    } finally {
      await s.stop();
    }
  });
});

describe('#2 POST /api/gallery/tagging/regenerate', () => {
  type Tags = { state: string; description: string | null; objects: unknown[]; canRegenerate?: boolean };
  const itemsOf = async (s: Awaited<ReturnType<typeof serve>>, job: string) =>
    (await s.api('GET', `/api/gallery/items?job=${job}`)).body as { fileName: string; path: string; tags: Tags }[];

  it("replaces the chosen model's description with a new one and returns the photo's tags; objects kept; it lasts", async () => {
    const s = await serve();
    try {
      await s.download(describeSmall.id);
      await s.choose({ describe: describeSmall.id });
      const job = await s.open('trip');
      await s.until((st) => st.job === job && st.done === 3);
      const lake = (await itemsOf(s, job)).find((i) => i.fileName === 'lake.jpg')!;
      expect(lake.tags).toMatchObject({ description: 'A picture of lake.', canRegenerate: true });
      const first = await s.api('POST', '/api/gallery/tagging/regenerate', { job, path: lake.path });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ state: 'done', description: expect.stringMatching(/^Another look at lake \(\d+\)\.$/), keywords: [], objects: [{ label: 'lake', count: 2 }], canRegenerate: true });
      const second = await s.api('POST', '/api/gallery/tagging/regenerate', { job, path: lake.path });
      expect(second.body.description).not.toBe(first.body.description);
      // Kept in the catalogue: the items say the same.
      expect((await itemsOf(s, job)).find((i) => i.fileName === 'lake.jpg')!.tags.description).toBe(second.body.description);
    } finally {
      await s.stop();
    }
  });

  it('works while tagging is paused', async () => {
    const s = await serve();
    try {
      await s.download(describeSmall.id);
      await s.choose({ describe: describeSmall.id });
      const job = await s.open('trip');
      await s.until((st) => st.job === job && st.done === 3);
      await s.choose({ describe: describeSmall.id, paused: true });
      const lake = (await itemsOf(s, job)).find((i) => i.fileName === 'lake.jpg')!;
      const r = await s.api('POST', '/api/gallery/tagging/regenerate', { job, path: lake.path });
      expect(r.status).toBe(200);
      expect(r.body.description).toMatch(/^Another look at lake/);
    } finally {
      await s.stop();
    }
  });

  it('400 for a bad body; 404 for a folder no longer open or a photo not in it; 409 with no working descriptions model', async () => {
    const s = await serve();
    try {
      await s.download(describeSmall.id);
      const job = await s.open('trip');
      await s.until((st) => st.job === job);
      const lake = (await itemsOf(s, job)).find((i) => i.fileName === 'lake.jpg')!;
      expect((await s.api('POST', '/api/gallery/tagging/regenerate', { job })).status).toBe(400);
      expect((await s.api('POST', '/api/gallery/tagging/regenerate', { job: 'nope', path: lake.path })).status).toBe(404);
      expect((await s.api('POST', '/api/gallery/tagging/regenerate', { job, path: join(root, 'trip', 'gone.jpg') })).status).toBe(404);
      // No describe model chosen.
      const none = await s.api('POST', '/api/gallery/tagging/regenerate', { job, path: lake.path });
      expect(none.status).toBe(409);
      expect(none.body.error).toMatch(/no working descriptions model/i);
      // Chosen, but paused before it looked at the photo: nothing to replace yet.
      await s.choose({ describe: describeSmall.id, paused: true });
      expect((await s.api('POST', '/api/gallery/tagging/regenerate', { job, path: lake.path })).status).toBe(409);
      // Another folder opened: the first one's job is gone.
      const other = await s.open('other');
      await s.until((st) => st.job === other);
      expect((await s.api('POST', '/api/gallery/tagging/regenerate', { job, path: lake.path })).status).toBe(404);
    } finally {
      await s.stop();
    }
  });

  it('a backend failure is a 500 with its message, and the old text stays', async () => {
    const real = fakeBackend();
    const s = await serve({ ...real, caption: async () => { throw new Error('out of memory'); } });
    try {
      await s.download(describeSmall.id);
      await s.choose({ describe: describeSmall.id });
      const job = await s.open('trip');
      await s.until((st) => st.job === job && st.done === 3);
      const lake = (await itemsOf(s, job)).find((i) => i.fileName === 'lake.jpg')!;
      const r = await s.api('POST', '/api/gallery/tagging/regenerate', { job, path: lake.path });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/out of memory/);
      expect((await itemsOf(s, job)).find((i) => i.fileName === 'lake.jpg')!.tags.description).toBe('A picture of lake.');
    } finally {
      await s.stop();
    }
  });
});
