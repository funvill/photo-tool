// Camera RAW files in the Photobook Editor (#6 phase 3), through the same raw handler Photo Tool uses:
// the Shelf counts and previews them, import catalogues a RAW from its embedded preview, a RAW+JPEG pair
// is imported once (its JPEG), and .xmp sidecars are skipped, never reported as files it can't read.
// The RAW files are synthetic (shared/server/mediaHandlers/rawSamples.ts), made here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRawSample } from '../../shared/server/mediaHandlers/rawSamples';
import { createApp } from '../server/app';
import { scanFolder } from '../server/importer';

describe('camera RAW files in the Photobook Editor', () => {
  let root: string;
  let shelf: string;
  let card: string;
  let server: Server;
  let base: string;
  let store: ReturnType<typeof createApp>['store'];
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
  const scene = (colour: string) => sharp({ create: { width: 900, height: 600, channels: 3, background: colour } }).png().toBuffer();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'editor-raw-'));
    shelf = join(root, 'Studio Shelf');
    card = join(shelf, 'Card');
    mkdirSync(card, { recursive: true });
    const meta = { make: 'FUJIFILM', model: 'X-T5', date: '2026:07:04 18:30:00' };
    writeFileSync(join(card, 'DSCF0001.RAF'), await makeRawSample('raf', { picture: await scene('#2255dd'), previewSide: 900, ...meta }));
    writeFileSync(join(card, 'DSCF0002.RAF'), await makeRawSample('raf', { picture: await scene('#dd2222'), previewSide: 900, ...meta }));
    await sharp(await scene('#22aa22')).jpeg().toFile(join(card, 'DSCF0002.JPG'));
    writeFileSync(join(card, 'DSCF0002.xmp'), '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    writeFileSync(join(card, 'IMG_0003.dng'), await makeRawSample('dng', { picture: await scene('#dddd22'), previewSide: 600, orientation: 1 }));
    const made = createApp(join(root, 'data'), { photoInfoFallbackDir: join(root, 'photoinfo') });
    store = made.store;
    store.setSetting('shelf_root', shelf);
    await new Promise<void>((r) => (server = made.app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    projectId = (await api('POST', '/api/projects', { title: 'RAW', product: 'poster', sizeId: 'p11x14' })).body.doc.id;
  });
  afterAll(() => {
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists a pair as its JPEG, and never a sidecar', async () => {
    expect((await scanFolder(card, false)).map((f) => f.slice(card.length + 1))).toEqual(['DSCF0001.RAF', 'DSCF0002.JPG', 'IMG_0003.dng']);
  });

  it('counts and previews RAW files on the Shelf', async () => {
    const listing = (await api('GET', '/api/shelf')).body;
    expect(listing.folders.find((f: any) => f.name === 'Card').photos).toBe(3);
    const res = await fetch(`${base}/api/shelf/preview?path=${encodeURIComponent(join(card, 'DSCF0001.RAF'))}`);
    expect(res.status).toBe(200);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.format, meta.width]).toEqual(['webp', 160]);
  });

  it('imports a RAW from its embedded preview, with its EXIF date, and a pair once', async () => {
    const job = await finish((await api('POST', `/api/projects/${projectId}/import`, { folder: card, recursive: false })).body);
    expect(job.errors).toEqual([]);
    expect(job.imported).toBe(3);
    const assets = (await api('GET', `/api/projects/${projectId}/assets`)).body as any[];
    const by = Object.fromEntries(assets.map((a) => [a.fileName, a]));
    expect(Object.keys(by).sort()).toEqual(['DSCF0001.RAF', 'DSCF0002.JPG', 'IMG_0003.dng']);
    expect(by['DSCF0001.RAF']).toMatchObject({ format: 'raf', widthPx: 900, heightPx: 600 });
    expect(by['IMG_0003.dng']).toMatchObject({ format: 'dng', widthPx: 600 });
    expect(by['DSCF0001.RAF'].capturedAt).toBe('2026-07-04T18:30:00');
    const thumb = Buffer.from(await (await fetch(`${base}/api/assets/${by['DSCF0001.RAF'].id}/thumb?size=m`)).arrayBuffer());
    const { data } = await sharp(thumb).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(data[2] - data[0]).toBeGreaterThan(100);
  });

  it('skips a dropped sidecar quietly, and imports a dropped RAW', async () => {
    const job = await finish((await api('POST', `/api/projects/${projectId}/import-paths`, { paths: [join(card, 'DSCF0002.xmp'), join(card, 'DSCF0002.RAF')] })).body);
    expect(job.errors).toEqual([]);
    expect(job.assetIds[0]).toBe('');
    expect(job.assetIds[1]).not.toBe('');
  });
});
