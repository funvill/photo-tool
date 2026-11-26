// The Photobook Editor takes the formats phase 2 of #6 added (fixtures/generated/formats): the Shelf
// counts and previews them, and import catalogues them under their own format with thumbnails. An
// SVG that tries to draw a file beside it never gets to.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';

const FORMATS = join(process.cwd(), 'fixtures', 'generated', 'formats');
const NAMES = ['avif-lake.avif', 'bmp-garden.bmp', 'gif-animated.gif', 'ico-app.ico', 'svg-badge.svg', 'tiff-harbour.tif'];

describe.runIf(existsSync(FORMATS))('the new formats in the Photobook Editor', () => {
  let root: string;
  let dataDir: string;
  let shelf: string;
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
  const centre = async (img: Buffer) => {
    const { data, info } = await sharp(img).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const o = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
    return [data[o], data[o + 1], data[o + 2]];
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'editor-formats-'));
    dataDir = join(root, 'data');
    shelf = join(root, 'Studio Shelf');
    mkdirSync(shelf);
    cpSync(FORMATS, join(shelf, 'Formats'), { recursive: true });
    // An SVG that tries to draw the red picture beside it over its blue background.
    mkdirSync(join(shelf, 'Sneaky'));
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toFile(join(shelf, 'Sneaky', 'red.png'));
    writeFileSync(join(shelf, 'Sneaky', 'sneaky.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0000ff"/><image href="red.png" width="64" height="64"/></svg>');
    const { app, store } = createApp(dataDir, { photoInfoFallbackDir: join(root, 'photoinfo') });
    store.setSetting('shelf_root', shelf);
    await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeStore = () => store.close();
    projectId = (await api('POST', '/api/projects', { title: 'Formats', product: 'poster', sizeId: 'p11x14' })).body.doc.id;
  });
  afterAll(() => {
    server?.close();
    closeStore?.();
    rmSync(root, { recursive: true, force: true });
  });

  it('counts and previews each one on the Shelf', async () => {
    const listing = (await api('GET', '/api/shelf')).body;
    const formats = listing.folders.find((f: any) => f.name === 'Formats');
    expect(formats.photos).toBe(NAMES.length);
    for (const name of NAMES) {
      const res = await fetch(`${base}/api/shelf/preview?path=${encodeURIComponent(join(shelf, 'Formats', name))}`);
      expect(res.status, name).toBe(200);
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect(meta.format, name).toBe('webp');
      expect(Math.max(meta.width!, meta.height!), name).toBe(160);
    }
  });

  it('imports each one under its own format, with thumbnails', async () => {
    const job = await finish((await api('POST', `/api/projects/${projectId}/import`, { folder: join(shelf, 'Formats'), recursive: false })).body);
    expect(job.errors).toEqual([]);
    expect(job.imported).toBe(NAMES.length);
    const assets = (await api('GET', `/api/projects/${projectId}/assets`)).body as any[];
    expect(Object.fromEntries(assets.map((a) => [a.fileName, a.format]))).toEqual({
      'avif-lake.avif': 'avif', 'bmp-garden.bmp': 'bmp', 'gif-animated.gif': 'gif', 'ico-app.ico': 'ico', 'svg-badge.svg': 'svg', 'tiff-harbour.tif': 'tiff',
    });
    for (const a of assets) {
      for (const size of ['s', 'm']) {
        const res = await fetch(`${base}/api/assets/${a.id}/thumb?size=${size}`);
        expect(res.status, `${a.fileName} ${size}`).toBe(200);
      }
    }
    // The GIF is its first (red) frame; the icon its biggest (orange) picture.
    const thumbOf = async (name: string) => Buffer.from(await (await fetch(`${base}/api/assets/${assets.find((a) => a.fileName === name).id}/thumb?size=m`)).arrayBuffer());
    const [gr, , gb] = await centre(await thumbOf('gif-animated.gif'));
    expect(gr - gb).toBeGreaterThan(150);
    const [ir, ig, ib] = await centre(await thumbOf('ico-app.ico'));
    expect([ir > 200, ig > 100 && ig < 170, ib < 60]).toEqual([true, true, true]);
  });

  it('never lets an SVG draw the file beside it, on the Shelf or once imported', async () => {
    const preview = await fetch(`${base}/api/shelf/preview?path=${encodeURIComponent(join(shelf, 'Sneaky', 'sneaky.svg'))}`);
    expect(await centre(Buffer.from(await preview.arrayBuffer()))).toEqual([0, 0, 255]);
    const job = await finish((await api('POST', `/api/projects/${projectId}/import-paths`, { paths: [join(shelf, 'Sneaky', 'sneaky.svg')] })).body);
    expect(job.errors).toEqual([]);
    const assets = (await api('GET', `/api/projects/${projectId}/assets`)).body as any[];
    const sneaky = assets.find((a) => a.fileName === 'sneaky.svg');
    const thumb = Buffer.from(await (await fetch(`${base}/api/assets/${sneaky.id}/thumb?size=m`)).arrayBuffer());
    const [r, , b] = await centre(thumb);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(40);
  });
});
