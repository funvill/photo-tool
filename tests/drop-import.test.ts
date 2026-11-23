// Photos dropped from the file manager: the server imports individual files (or folders) by path
// and reports the asset for each one, in input order.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';

const FIXTURES = join(process.cwd(), 'fixtures', 'generated', 'trip');

describe.runIf(existsSync(FIXTURES))('dropping files (API)', () => {
  let dataDir: string;
  let tmp: string;
  let server: Server;
  let base: string;
  let closeStore: () => void;

  const api = async <T = any>(method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  };
  const finish = async (job: any) => {
    let st = job;
    while (st.status !== 'done' && st.status !== 'failed') {
      await new Promise((r) => setTimeout(r, 40));
      st = (await api('GET', `/api/jobs/${job.id}`)).body;
    }
    return st;
  };
  const newProject = async () => (await api('POST', '/api/projects', { title: 'Drop', product: 'poster', sizeId: 'p11x14' })).body.doc.id as string;
  const dropPaths = async (projectId: string, paths: string[]) => {
    const res = await api('POST', `/api/projects/${projectId}/import-paths`, { paths });
    expect(res.status).toBe(202);
    return finish(res.body);
  };
  const folder = (name: string, ...photos: string[]) => {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    for (const p of photos) copyFileSync(join(FIXTURES, p), join(dir, p));
    return dir;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'drop-data-'));
    tmp = mkdtempSync(join(tmpdir(), 'drop-'));
    const { app, store } = createApp(dataDir);
    await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeStore = () => store.close();
  });
  afterAll(() => {
    server?.close();
    closeStore?.();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('imports single files and reports their ids in order', async () => {
    const id = await newProject();
    const a = folder('one', 'day1-01-arrival.jpg');
    const b = folder('two', 'day1-02-street.jpg');
    const job = await dropPaths(id, [join(b, 'day1-02-street.jpg'), join(a, 'day1-01-arrival.jpg')]);
    expect(job).toMatchObject({ kind: 'paths', imported: 2, failed: 0 });
    expect(job.assetIds).toHaveLength(2);
    expect(job.assetIds.every((x: string) => x)).toBe(true);
    const assets = (await api('GET', `/api/projects/${id}/assets`)).body as { id: string; fileName: string }[];
    expect(assets.map((x) => x.id).sort()).toEqual([...job.assetIds].sort());
    expect(assets.find((x) => x.id === job.assetIds[0])!.fileName).toBe('day1-02-street.jpg');
    expect(assets.find((x) => x.id === job.assetIds[1])!.fileName).toBe('day1-01-arrival.jpg');
  });

  it('already in the book is linked not re-imported', async () => {
    const id = await newProject();
    const dir = folder('book', 'day1-01-arrival.jpg', 'day1-02-street.jpg');
    await finish((await api('POST', `/api/projects/${id}/import`, { folder: dir })).body);
    const before = (await api('GET', `/api/projects/${id}/assets`)).body as { id: string; fileName: string }[];
    const job = await dropPaths(id, [join(dir, 'day1-02-street.jpg')]);
    expect(job.alreadyInLibrary).toBe(1);
    expect(job.imported).toBe(0);
    expect(job.assetIds).toEqual([before.find((x) => x.fileName === 'day1-02-street.jpg')!.id]);
  });

  it('unsupported file is reported', async () => {
    const id = await newProject();
    const dir = folder('notes');
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const job = await dropPaths(id, [join(dir, 'notes.txt')]);
    expect(job.failed).toBe(0);
    expect(job.errors[0].error).toMatch(/not a photo/);
    expect(job.assetIds).toEqual(['']);
  });

  it('a folder path imports the folder', async () => {
    const id = await newProject();
    const dir = folder('whole', 'day1-01-arrival.jpg', 'day1-02-street.jpg', 'day1-04-lunch.jpg');
    const job = await dropPaths(id, [dir]);
    expect(job.imported).toBe(3);
    expect(job.assetIds.filter(Boolean)).toHaveLength(3);
    expect((await api('GET', `/api/projects/${id}/assets`)).body).toHaveLength(3);
  });

  it('exact duplicate in another folder', async () => {
    const id = await newProject();
    const a = folder('orig', 'day1-03-market.jpg');
    const b = folder('copy');
    copyFileSync(join(FIXTURES, 'day1-03-market.jpg'), join(b, 'market-again.jpg'));
    await dropPaths(id, [join(a, 'day1-03-market.jpg')]);
    const job = await dropPaths(id, [join(b, 'market-again.jpg')]);
    expect(job.exactDuplicates).toBe(1);
    expect(job.assetIds[0]).toBeTruthy();
  });

  it('the stamp follows a dropped file\'s folder', async () => {
    const id = await newProject();
    const dir = folder('stamped', 'day1-01-arrival.jpg');
    const stamp = async () => (await api('GET', `/api/projects/${id}/photoinfo-stamp`)).body.stamp as string;
    await dropPaths(id, [join(dir, 'day1-01-arrival.jpg')]);
    const first = await stamp();
    writeFileSync(join(dir, 'photoinfo.json'), JSON.stringify({ format: 'photoinfo/1', photos: { 'day1-01-arrival.jpg': { star: true } } }));
    expect(await stamp()).not.toBe(first);
  });
});
