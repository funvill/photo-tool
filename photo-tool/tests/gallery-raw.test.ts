// Phase 3 of #6 in Photo Tool: camera RAW files in a folder. A RAW is shown through its preview; a RAW
// and a JPEG of the same name are one photo (the JPEG shown, the RAW named on it); .xmp sidecars are
// never photos; a RAW with no preview gets a placeholder tile, catalogued once, not an error every scan.
// The RAW files are synthetic (shared/server/mediaHandlers/rawSamples.ts), made here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filler, makeRawSample } from '../../shared/server/mediaHandlers/rawSamples';
import { createGalleryApp } from '../server/app';
import { listPhotos } from '../server/walk';

const scene = (colour: string) => sharp({ create: { width: 600, height: 400, channels: 3, background: colour } }).png().toBuffer();

describe('camera RAW files in Photo Tool', () => {
  let root: string;
  let photos: string;
  let server: Server;
  let close: () => void;
  let base: string;

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) } as { status: number; type: string; body: any };
  };

  const scan = async (): Promise<{ jobId: string; items: any[]; errors: unknown[] }> => {
    const { body } = await api('POST', '/api/gallery/open', { folder: photos, recursive: true });
    for (;;) {
      const job = (await api('GET', `/api/gallery/jobs/${body.jobId}`)).body;
      if (job.done) return { jobId: body.jobId, items: job.items, errors: job.errors };
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const byName = (items: any[]) => Object.fromEntries(items.map((i) => [i.relDir ? `${i.relDir}/${i.fileName}` : i.fileName, i]));

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gallery-raw-'));
    photos = join(root, 'card');
    mkdirSync(join(photos, 'sub'), { recursive: true });
    const meta = { make: 'Canon', model: 'Canon EOS R6', date: '2026:06:01 10:00:00', gps: { lat: 10.5, lon: 20.25 } };
    // A pair: the CR3 and the JPEG the camera saved with it, and the sidecars an editor left.
    writeFileSync(join(photos, 'IMG_0001.CR3'), await makeRawSample('cr3', { picture: await scene('#cc3333'), previewSide: 600, ...meta }));
    await sharp(await scene('#33cc33')).jpeg().withExif({ IFD0: { Make: 'Canon', Model: 'Canon EOS R6' }, IFD2: { DateTimeOriginal: '2026:06:01 10:00:00' } }).toFile(join(photos, 'IMG_0001.JPG'));
    writeFileSync(join(photos, 'IMG_0001.xmp'), '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    writeFileSync(join(photos, 'IMG_0001.CR3.xmp'), '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    // A RAW on its own, held on its side (orientation 8).
    writeFileSync(join(photos, 'IMG_0002.NEF'), await makeRawSample('nef', { picture: await sharp(await scene('#3333cc')).rotate(90).png().toBuffer(), previewSide: 600, orientation: 8, ...meta, make: 'NIKON CORPORATION', model: 'NIKON Z 6' }));
    // A RAW with no preview in it at all.
    writeFileSync(join(photos, 'IMG_0003.dng'), Buffer.concat([Buffer.from('II*\0\x08\0\0\0', 'latin1'), filler(4000, 3)]));
    // The same base name in another folder is not a pair.
    writeFileSync(join(photos, 'sub', 'IMG_0001.ARW'), await makeRawSample('arw', { picture: await scene('#cccc33'), previewSide: 400 }));
    const made = createGalleryApp(join(root, 'data'), { photoInfoFallbackDir: join(root, 'fallback') });
    close = made.close;
    await new Promise<void>((r) => (server = made.app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists the JPEG of a pair, never its RAW, and never a sidecar', async () => {
    const { files, twins } = await listPhotos(photos, true);
    expect(files.map((f) => f.slice(photos.length + 1).split('\\').join('/'))).toEqual(['IMG_0001.JPG', 'IMG_0002.NEF', 'IMG_0003.dng', 'sub/IMG_0001.ARW']);
    expect([...twins]).toEqual([[join(photos, 'IMG_0001.JPG'), join(photos, 'IMG_0001.CR3')]]);
  });

  it('shows a RAW-only photo, a RAW+JPEG pair as one photo, and a placeholder for a RAW with no preview', async () => {
    const { items, errors } = await scan();
    expect(errors).toEqual([]);
    const got = byName(items);
    expect(Object.keys(got).sort()).toEqual(['IMG_0001.JPG', 'IMG_0002.NEF', 'IMG_0003.dng', 'sub/IMG_0001.ARW']);
    // The pair: the JPEG is the photo; its RAW is named on it.
    expect(got['IMG_0001.JPG']).toMatchObject({ format: 'jpeg', rawTwin: 'IMG_0001.CR3' });
    expect(got['IMG_0001.JPG'].noPreview).toBeUndefined();
    // The RAW: its preview, turned upright by the RAW's orientation; its EXIF from the RAW.
    expect(got['IMG_0002.NEF']).toMatchObject({ format: 'nef', width: 600, height: 400, camera: 'NIKON CORPORATION NIKON Z 6', capturedAt: '2026-06-01T10:00:00' });
    expect(got['IMG_0002.NEF'].gpsLat).toBeCloseTo(10.5, 3);
    expect(got['IMG_0002.NEF'].rawTwin).toBeUndefined();
    expect(got['IMG_0002.NEF'].analysis).not.toBeNull();
    expect(got['sub/IMG_0001.ARW']).toMatchObject({ format: 'arw', width: 400 });
    // No preview: a catalogued photo with a placeholder, no analysis and no content key (so it is not tagged).
    expect(got['IMG_0003.dng']).toMatchObject({ format: 'dng', noPreview: true, analysis: null, contentKey: null });
    const thumb = await api('GET', `/api/gallery/thumb?key=${got['IMG_0003.dng'].key}&size=s`);
    expect(thumb.status).toBe(200);
    expect((await sharp(thumb.body).metadata()).width).toBe(400);
  });

  it('serves the zoomed view of a RAW from its preview, and the placeholder for one with none', async () => {
    const { items } = await scan();
    const got = byName(items);
    const full = await api('GET', `/api/gallery/full?path=${encodeURIComponent(got['IMG_0002.NEF'].path)}`);
    expect(full.status).toBe(200);
    const meta = await sharp(full.body).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 600, 400]);
    const { data } = await sharp(full.body).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(data[2]).toBeGreaterThan(150);
    const none = await api('GET', `/api/gallery/full?path=${encodeURIComponent(got['IMG_0003.dng'].path)}`);
    expect(none.status).toBe(200);
    expect((await sharp(none.body).metadata()).width).toBe(1200);
    // Copying it, or editing it, has nothing to work from: a clear refusal, not a server error.
    const image = await api('GET', `/api/gallery/image?path=${encodeURIComponent(got['IMG_0003.dng'].path)}`);
    expect(image.status).toBe(409);
    expect(image.body.error).toMatch(/no preview/i);
    const render = await api('POST', '/api/gallery/edit/render', { path: got['IMG_0003.dng'].path, edit: { rotate: 90 } });
    expect(render.status).toBe(409);
    // A RAW with a preview copies and renders as JPEG (a RAW is saved only as a JPEG copy).
    expect((await api('GET', `/api/gallery/image?path=${encodeURIComponent(got['IMG_0002.NEF'].path)}`)).status).toBe(200);
    const edited = await api('POST', '/api/gallery/edit/render', { path: got['IMG_0002.NEF'].path, edit: { rotate: 90 } });
    expect(edited.status).toBe(200);
    expect(edited.body.format).toBe('jpeg');
  });

  it('keeps a star of the pair under the JPEG\'s name, and the RAW on the reply', async () => {
    const { jobId, items } = await scan();
    const jpg = byName(items)['IMG_0001.JPG'];
    const reply = await api('PATCH', '/api/gallery/info', { path: jpg.path, patch: { star: true }, job: jobId });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ rawTwin: 'IMG_0001.CR3', info: { star: true } });
    const info = JSON.parse(readFileSync(join(photos, 'photoinfo.json'), 'utf8')).photos;
    expect(Object.keys(info)).toEqual(['IMG_0001.JPG']);
    const again = (await api('GET', `/api/gallery/items?job=${jobId}`)).body;
    expect(byName(again)['IMG_0001.JPG']).toMatchObject({ rawTwin: 'IMG_0001.CR3', info: { star: true } });
  });

  it('reads a folder again from the cache: the pair, the RAW and the placeholder stay as they were', async () => {
    const first = byName((await scan()).items);
    const second = byName((await scan()).items);
    for (const name of Object.keys(first)) expect([second[name].key, second[name].rawTwin, second[name].contentKey], name).toEqual([first[name].key, first[name].rawTwin, first[name].contentKey]);
    expect(second['IMG_0003.dng']).toMatchObject({ noPreview: true, contentKey: null });
  });

  it('shows the RAW on its own once the JPEG of its pair is deleted', async () => {
    const { jobId } = await scan();
    unlinkSync(join(photos, 'IMG_0001.JPG'));
    const removed = await api('POST', '/api/gallery/removed', { paths: [join(photos, 'IMG_0001.JPG')] });
    expect(removed.body.removed).toEqual([join(photos, 'IMG_0001.JPG')]);
    const items = byName((await api('GET', `/api/gallery/items?job=${jobId}`)).body);
    expect(items['IMG_0001.CR3']).toMatchObject({ format: 'cr3', width: 600 });
    expect(items['IMG_0001.JPG']).toBeUndefined();
    // And a JPEG put back beside it (a copy restored from the Recycle Bin) folds it in again.
    await sharp(await scene('#33cc33')).jpeg().toFile(join(photos, 'IMG_0001.JPG'));
    const refreshed = await api('POST', '/api/gallery/refresh', { paths: [join(photos, 'IMG_0001.JPG')] });
    expect(refreshed.body[0]).toMatchObject({ fileName: 'IMG_0001.JPG', rawTwin: 'IMG_0001.CR3' });
    const after = byName((await api('GET', `/api/gallery/items?job=${jobId}`)).body);
    expect(after['IMG_0001.CR3']).toBeUndefined();
    expect(after['IMG_0001.JPG']).toMatchObject({ rawTwin: 'IMG_0001.CR3' });
    expect(existsSync(join(photos, 'IMG_0001.CR3'))).toBe(true);
  });
});
