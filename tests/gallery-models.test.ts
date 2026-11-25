// Downloading, keeping and removing on-device tagging models (fake models served from memory).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGalleryApp } from '../src/gallery/server/app';
import { downloadModel, isAllowedModelUrl, type DownloadProgress } from '../src/gallery/server/models/download';
import { installedModels, modelDir, readTaggingSettings } from '../src/gallery/server/models/store';
import { FAKE_CATALOGUE, FAKE_FILES, fakeFetch } from './support/fakeTagging';

let root: string;
const dataDir = () => join(root, 'data');
const [describeSmall, describeLarge, keywordsSmall] = FAKE_CATALOGUE;
const bigFile = (m = describeSmall) => m.files[1];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gallery-models-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('model downloads', () => {
  it('isAllowedModelUrl accepts huggingface.co and cdn hosts, refuses http, other hosts, ports and userinfo', () => {
    expect(isAllowedModelUrl('https://huggingface.co/x/resolve/abc/model.onnx')).toBe(true);
    expect(isAllowedModelUrl('https://cdn-lfs.huggingface.co/repos/a/b')).toBe(true);
    expect(isAllowedModelUrl('https://cas-bridge.xethub.hf.co/xet/abc')).toBe(true);
    expect(isAllowedModelUrl('https://cdn-lfs.hf.co/a')).toBe(true);
    expect(isAllowedModelUrl('http://huggingface.co/x')).toBe(false);
    expect(isAllowedModelUrl('https://huggingface.co.evil.com/x')).toBe(false);
    expect(isAllowedModelUrl('https://evilhuggingface.co/x')).toBe(false);
    expect(isAllowedModelUrl('https://example.com/x')).toBe(false);
    expect(isAllowedModelUrl('https://huggingface.co:8443/x')).toBe(false);
    expect(isAllowedModelUrl('https://user:pw@huggingface.co/x')).toBe(false);
    expect(isAllowedModelUrl('not a url')).toBe(false);
  });

  it('downloads every file into models/<id>, checks sha256, reports progress up to the total', async () => {
    const seen: DownloadProgress[] = [];
    await downloadModel(dataDir(), describeSmall, { fetch: fakeFetch(), onProgress: (p) => seen.push(p) });
    const dir = modelDir(dataDir(), describeSmall.id);
    for (const f of describeSmall.files) expect(statSync(join(dir, f.path)).size).toBe(f.bytes);
    const total = describeSmall.files.reduce((s, f) => s + f.bytes, 0);
    expect(seen.at(-1)).toEqual({ id: describeSmall.id, received: total, total });
    expect(seen.every((p, i) => i === 0 || p.received >= seen[i - 1].received)).toBe(true);
    expect(installedModels(dataDir(), FAKE_CATALOGUE)).toEqual([{ id: describeSmall.id, bytes: total, ok: true }]);
  });

  it('resumes a .part file with a Range request', async () => {
    const f = bigFile();
    const dir = modelDir(dataDir(), describeSmall.id);
    mkdirSync(join(dir, 'onnx'), { recursive: true });
    const content = FAKE_FILES.get(`${describeSmall.repo}/${f.path}`)!;
    writeFileSync(join(dir, `${f.path}.part`), content.subarray(0, 50_000));
    const log: { url: string; range: string | null }[] = [];
    await downloadModel(dataDir(), describeSmall, { fetch: fakeFetch({ log }) });
    expect(log.filter((l) => l.url.endsWith(f.path) && l.url.includes('cdn-lfs')).map((l) => l.range)).toEqual(['bytes=50000-']);
    expect(statSync(join(dir, f.path)).size).toBe(f.bytes);
    expect(existsSync(join(dir, `${f.path}.part`))).toBe(false);
  });

  it('a file whose sha256 does not match is deleted and the download fails; nothing is installed', async () => {
    const f = bigFile();
    const bad = Buffer.alloc(f.bytes, 7);
    await expect(downloadModel(dataDir(), describeSmall, { fetch: fakeFetch({ override: new Map([[`${describeSmall.repo}/${f.path}`, bad]]) }) }))
      .rejects.toThrow(/check/i);
    const dir = modelDir(dataDir(), describeSmall.id);
    expect(existsSync(join(dir, f.path))).toBe(false);
    expect(existsSync(join(dir, `${f.path}.part`))).toBe(false);
    expect(installedModels(dataDir(), FAKE_CATALOGUE).filter((m) => m.ok)).toEqual([]);
  });

  it('a redirect to a host not allowed is refused', async () => {
    await expect(downloadModel(dataDir(), describeSmall, { fetch: fakeFetch({ redirectTo: 'https://example.com/x' }) }))
      .rejects.toThrow(/not allowed/i);
  });

  it('cancel stops it and leaves no finished file', async () => {
    const ac = new AbortController();
    const going = downloadModel(dataDir(), describeSmall, {
      fetch: fakeFetch({ chunkDelayMs: 5 }),
      signal: ac.signal,
      onProgress: (p) => p.received > 20_000 && ac.abort(),
    });
    await expect(going).rejects.toThrow();
    expect(existsSync(join(modelDir(dataDir(), describeSmall.id), bigFile().path))).toBe(false);
  });

  it('installedModels says ok false when a file is missing or the wrong size', async () => {
    await downloadModel(dataDir(), describeSmall, { fetch: fakeFetch() });
    await downloadModel(dataDir(), keywordsSmall, { fetch: fakeFetch() });
    rmSync(join(modelDir(dataDir(), describeSmall.id), bigFile().path));
    writeFileSync(join(modelDir(dataDir(), keywordsSmall.id), bigFile(keywordsSmall).path), 'short');
    const got = installedModels(dataDir(), FAKE_CATALOGUE);
    expect(got.map((m) => [m.id, m.ok])).toEqual([[describeSmall.id, false], [keywordsSmall.id, false]]);
  });
});

describe('model routes', () => {
  let server: Server | undefined;
  let closeApp: (() => void) | undefined;
  let base: string;
  const api = async <T = any>(method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: (type.includes('json') ? await res.json() : null) as T };
  };
  const waitDownloaded = async () => {
    for (;;) {
      const s = (await api('GET', '/api/gallery/models')).body;
      if (!s.downloading) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(async () => {
    const { app, close } = createGalleryApp(dataDir(), {
      photoInfoFallbackDir: join(root, 'fallback'),
      tagging: { fetch: fakeFetch({ chunkDelayMs: 2 }), catalogue: FAKE_CATALOGUE },
    });
    closeApp = close;
    await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    closeApp?.();
  });

  it('routes: 404 for an unknown id, 409 for a second download, settings refuse a model not installed, DELETE clears the setting', async () => {
    const first = await api('GET', '/api/gallery/models');
    expect(first.body.catalogue.map((m: { id: string }) => m.id)).toEqual(FAKE_CATALOGUE.map((m) => m.id));
    expect(first.body.settings).toEqual({ describe: null, keywords: null, paused: false });
    expect((await api('POST', '/api/gallery/models/nope/download')).status).toBe(404);
    expect((await api('POST', `/api/gallery/models/${describeSmall.id}/download`)).status).toBe(202);
    expect((await api('POST', `/api/gallery/models/${describeLarge.id}/download`)).status).toBe(409);
    expect((await api('PUT', '/api/gallery/tagging/settings', { describe: describeLarge.id, keywords: null, paused: false })).status).toBe(400);
    const done = await waitDownloaded();
    expect(done.installed.map((m: { id: string; ok: boolean }) => [m.id, m.ok])).toEqual([[describeSmall.id, true]]);
    expect(done.error).toBeNull();
    // A model of the wrong part is refused too.
    expect((await api('PUT', '/api/gallery/tagging/settings', { describe: null, keywords: describeSmall.id, paused: false })).status).toBe(400);
    const set = await api('PUT', '/api/gallery/tagging/settings', { describe: describeSmall.id, keywords: null, paused: false });
    expect(set.status).toBe(200);
    expect(readTaggingSettings(dataDir()).describe).toBe(describeSmall.id);
    expect((await api('DELETE', `/api/gallery/models/${describeSmall.id}`)).status).toBe(204);
    const after = (await api('GET', '/api/gallery/models')).body;
    expect(after.installed).toEqual([]);
    expect(after.settings.describe).toBeNull();
    expect(readdirSync(join(dataDir(), 'models'))).toEqual([]);
  });

  it('cancel route stops a running download', async () => {
    expect((await api('POST', `/api/gallery/models/${describeLarge.id}/download`)).status).toBe(202);
    expect((await api('POST', '/api/gallery/models/download/cancel')).status).toBe(204);
    const s = await waitDownloaded();
    expect(s.installed.filter((m: { ok: boolean }) => m.ok)).toEqual([]);
  });
});
