// Search by meaning: GET /api/gallery/search ranks a folder's photos by how close their picture is to the words,
// using the keywords model chosen in Settings (fake models here: a photo "is" the words of its file name).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGalleryApp } from '../src/gallery/server/app';
import { FAKE_CATALOGUE, fakeBackend, fakeFetch } from './support/fakeTagging';

const keywordsSmall = FAKE_CATALOGUE.find((m) => m.id === 'fake-keywords-small')!;
const describeSmall = FAKE_CATALOGUE.find((m) => m.id === 'fake-describe-small')!;

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gallery-search-'));
  dataDir = join(root, 'data');
  mkdirSync(join(root, 'trip'));
  const sharp = (await import('sharp')).default;
  const colours: Record<string, string> = { harbour: '#c04020', 'harbour-boat': '#a06020', lake: '#2040c0' };
  for (const [n, c] of Object.entries(colours)) await sharp({ create: { width: 40, height: 30, channels: 3, background: c } }).jpeg().toFile(join(root, 'trip', `${n}.jpg`));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A gallery server on a free port; `api` calls it. */
async function serve() {
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
  const stop = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    close();
  };
  return { api, stop };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const name = (p: string) => p.split(/[\\/]/).pop();

describe('search by meaning', () => {
  it('search route ranks by similarity above the threshold, best first; [] under 3 letters or with no keywords model', async () => {
    const { api, stop } = await serve();
    try {
      for (const m of [keywordsSmall, describeSmall]) {
        expect((await api('POST', `/api/gallery/models/${m.id}/download`)).status).toBe(202);
        for (let i = 0; i < 200 && (await api('GET', '/api/gallery/models')).body.downloading; i++) await wait(10);
      }
      await api('PUT', '/api/gallery/tagging/settings', { describe: null, keywords: keywordsSmall.id, paused: false });
      const { jobId } = (await api('POST', '/api/gallery/open', { folder: join(root, 'trip'), recursive: false })).body;
      for (let i = 0; i < 300; i++) {
        const st = (await api('GET', '/api/gallery/tagging/status')).body;
        if (st.job === jobId && st.done === 3) break;
        await wait(10);
      }
      const search = async (q: string) => {
        const r = await api('GET', `/api/gallery/search?job=${jobId}&q=${encodeURIComponent(q)}`);
        expect(r.status).toBe(200);
        return (r.body.paths as string[]).map(name);
      };
      // "seaside" means harbour: harbour.jpg is the closest (1.0), harbour-boat.jpg next (0.71); lake.jpg is below 0.5.
      expect(await search('seaside')).toEqual(['harbour.jpg', 'harbour-boat.jpg']);
      expect(await search('lake')).toEqual(['lake.jpg']);
      expect(await search('se')).toEqual([]);
      expect(await search('  a 1 2 b  ')).toEqual([]);
      // Only descriptions chosen: no search by meaning.
      await api('PUT', '/api/gallery/tagging/settings', { describe: describeSmall.id, keywords: null, paused: false });
      expect(await search('seaside')).toEqual([]);
      expect((await api('GET', '/api/gallery/search?job=nope&q=seaside')).status).toBe(404);
    } finally {
      await stop();
    }
  });

  it('works while tagging is paused, in a new session that has not loaded the keywords model yet', async () => {
    const first = await serve();
    let jobId: string;
    try {
      expect((await first.api('POST', `/api/gallery/models/${keywordsSmall.id}/download`)).status).toBe(202);
      for (let i = 0; i < 200 && (await first.api('GET', '/api/gallery/models')).body.downloading; i++) await wait(10);
      await first.api('PUT', '/api/gallery/tagging/settings', { describe: null, keywords: keywordsSmall.id, paused: false });
      jobId = (await first.api('POST', '/api/gallery/open', { folder: join(root, 'trip'), recursive: false })).body.jobId;
      for (let i = 0; i < 300; i++) {
        const st = (await first.api('GET', '/api/gallery/tagging/status')).body;
        if (st.job === jobId && st.done === 3) break;
        await wait(10);
      }
      await first.api('PUT', '/api/gallery/tagging/settings', { describe: null, keywords: keywordsSmall.id, paused: true });
    } finally {
      await first.stop();
    }
    const second = await serve();
    try {
      jobId = (await second.api('POST', '/api/gallery/open', { folder: join(root, 'trip'), recursive: false })).body.jobId;
      for (let i = 0; i < 300 && !(await second.api('GET', `/api/gallery/jobs/${jobId}?since=0`)).body.done; i++) await wait(10);
      const r = await second.api('GET', `/api/gallery/search?job=${jobId}&q=seaside`);
      expect((r.body.paths as string[]).map(name)).toEqual(['harbour.jpg', 'harbour-boat.jpg']);
    } finally {
      await second.stop();
    }
  });
});
