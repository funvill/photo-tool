// The editor's server reads and writes photoinfo.json beside the photos.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';

describe('photoinfo.json (server)', () => {
  let dataDir: string;
  let photos: string;
  let server: Server;
  let base: string;
  let closeStore: () => void;
  let projectId: string;

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
  const jpeg = (path: string, shade: number) =>
    sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 160 } } }).jpeg().toFile(path);
  const infoPath = () => join(photos, 'photoinfo.json');
  const assets = async () => (await api('GET', `/api/projects/${projectId}/assets`)).body as any[];
  const byName = async (name: string) => (await assets()).find((a) => a.fileName === name);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pi-data-'));
    photos = mkdtempSync(join(tmpdir(), 'pi-photos-'));
    await jpeg(join(photos, 'a.jpg'), 10);
    await jpeg(join(photos, 'b.jpg'), 120);
    writeFileSync(
      infoPath(),
      JSON.stringify({
        format: 'photoinfo/1',
        photos: {
          'a.jpg': { star: true, date: '2025-08-12T17:40:00', location: { lat: 49.28, lon: -123.12, name: 'Vancouver' }, people: ['Sam', 'Alex'], description: 'Harbour at dusk' },
          'b.jpg': { star: false },
        },
      }),
    );
    const { app, store } = createApp(dataDir, { photoInfoFallbackDir: join(dataDir, 'photoinfo') });
    await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeStore = () => store.close();
    projectId = (await api('POST', '/api/projects', { title: 'Info', product: 'poster', sizeId: 'p11x14' })).body.doc.id;
    await finish((await api('POST', `/api/projects/${projectId}/import`, { folder: photos })).body);
  });
  afterAll(() => {
    server?.close();
    closeStore?.();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(photos, { recursive: true, force: true });
  });

  it('star in the file shows as favourite', async () => {
    const list = await assets();
    expect(list.find((a) => a.fileName === 'a.jpg').favorite).toBe(true);
    expect(list.find((a) => a.fileName === 'b.jpg').favorite).toBe(false);
  });

  it('date and location overrides apply', async () => {
    const a = await byName('a.jpg');
    expect(a.capturedAt).toBe('2025-08-12T17:40:00');
    expect(a.gpsLat).toBe(49.28);
    expect(a.gpsLon).toBe(-123.12);
    expect(a.people).toEqual(['Sam', 'Alex']);
    expect(a.description).toBe('Harbour at dusk');
  });

  it('PATCH favorite writes the file, not the database', async () => {
    const b = await byName('b.jpg');
    const res = await api('PATCH', `/api/projects/${projectId}/assets/${b.id}`, { favorite: true });
    expect(res.status).toBe(200);
    expect(res.body.favorite).toBe(true);
    expect(JSON.parse(readFileSync(infoPath(), 'utf8')).photos['b.jpg'].star).toBe(true);
    // the stored column is untouched: a fresh app on the same data sees the file's value only
    const { store } = createApp(dataDir, { photoInfoFallbackDir: join(dataDir, 'photoinfo') });
    expect(store.assetById(b.id)!.favorite).toBe(0);
    store.close();
    expect((await byName('b.jpg')).favorite).toBe(true);
  });

  it('stamp changes when the file changes', async () => {
    const first = (await api('GET', `/api/projects/${projectId}/photoinfo-stamp`)).body.stamp as string;
    expect(typeof first).toBe('string');
    writeFileSync(infoPath(), JSON.stringify({ format: 'photoinfo/1', photos: { 'a.jpg': { star: true }, 'b.jpg': { star: true, description: 'edited outside the editor' } } }));
    const second = (await api('GET', `/api/projects/${projectId}/photoinfo-stamp`)).body.stamp as string;
    expect(second).not.toBe(first);
    expect((await byName('b.jpg')).description).toBe('edited outside the editor');
  });

  it('a write failure says what went wrong, not that the file is unreadable', async () => {
    const other = mkdtempSync(join(tmpdir(), 'pi-gone-'));
    await jpeg(join(other, 'c.jpg'), 200);
    await finish((await api('POST', `/api/projects/${projectId}/import`, { folder: other })).body);
    const c = await byName('c.jpg');
    rmSync(other, { recursive: true, force: true });
    const res = await api('PATCH', `/api/projects/${projectId}/assets/${c.id}`, { favorite: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Can't save the star: ");
    expect(res.body.error).toContain('Could not write');
    expect(res.body.error).not.toContain("can't be read");
    // Its folder is gone, so its star is unknown: the library says so.
    expect((await byName('c.jpg')).infoUnavailable).toBe(true);
    expect((await byName('a.jpg')).infoUnavailable).toBeUndefined();
  });

  it('broken file gives 409', async () => {
    writeFileSync(infoPath(), '{bad');
    const a = await byName('a.jpg');
    const res = await api('PATCH', `/api/projects/${projectId}/assets/${a.id}`, { favorite: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Can't save the star: photoinfo.json in ");
    expect(res.body.error).toContain("can't be read. Fix or delete it.");
    expect(readFileSync(infoPath(), 'utf8')).toBe('{bad');
    expect((await byName('a.jpg')).infoUnavailable).toBe(true);
  });
});
