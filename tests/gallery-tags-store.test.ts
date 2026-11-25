// The content key (same pixels = same photo) and where tagging results are kept.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGalleryApp } from '../src/gallery/server/app';
import { Catalog, type TagRow } from '../src/gallery/server/catalog';
import { Scanner } from '../src/gallery/server/scanner';
import { writeTaggingSettings } from '../src/gallery/server/models/store';
import { downloadModel } from '../src/gallery/server/models/download';
import { FAKE_CATALOGUE, fakeFetch } from './support/fakeTagging';

let root: string;
let photos: string;
let dataDir: string;

const makeJpeg = (file: string, colour: { r: number; g: number; b: number }, width = 64, height = 48) =>
  sharp({ create: { width, height, channels: 3, background: colour } }).jpeg().toFile(file);

const scan = async (catalog: Catalog) => {
  const scanner = new Scanner(catalog, dataDir, { analyze: async () => null as never });
  const job = scanner.open(photos, false);
  return (await scanner.wait(job.id)).photos;
};
const byName = <T extends { fileName: string }>(list: T[], n: string): T => list.find((p) => p.fileName === n)!;

const tagRow = (contentKey: string, modelId: string, extra: Partial<TagRow> = {}): TagRow => ({
  contentKey, modelId, status: 'done', description: null, keywords: [], objects: [], embedding: null, error: null, ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gallery-tags-'));
  photos = join(root, 'trip');
  dataDir = join(root, 'data');
  mkdirSync(photos, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('content key', () => {
  it('the same pixels under another name and time give the same content key', async () => {
    await makeJpeg(join(photos, 'a.jpg'), { r: 200, g: 60, b: 40 });
    copyFileSync(join(photos, 'a.jpg'), join(photos, 'b.jpg'));
    utimesSync(join(photos, 'b.jpg'), new Date(2001, 1, 1), new Date(2001, 1, 1));
    await makeJpeg(join(photos, 'c.jpg'), { r: 20, g: 160, b: 40 });
    const catalog = new Catalog(dataDir);
    const list = await scan(catalog);
    catalog.close();
    expect(byName(list, 'a.jpg').contentKey).toMatch(/^[0-9a-f]{40}$/);
    expect(byName(list, 'b.jpg').contentKey).toBe(byName(list, 'a.jpg').contentKey);
    expect(byName(list, 'b.jpg').key).not.toBe(byName(list, 'a.jpg').key);
    expect(byName(list, 'c.jpg').contentKey).not.toBe(byName(list, 'a.jpg').contentKey);
  });

  it('a metadata-only rewrite (sharp withMetadata exif date) keeps the key; one changed pixel changes it', async () => {
    const raw = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 90, b: 200 } } });
    const pixels = await raw.raw().toBuffer();
    await sharp(pixels, { raw: { width: 64, height: 48, channels: 3 } }).jpeg({ quality: 100 }).toFile(join(photos, 'a.jpg'));
    const original = await sharp(join(photos, 'a.jpg')).raw().toBuffer();
    // The same decoded pixels written again with an EXIF date: what a tagging tool does.
    await sharp(original, { raw: { width: 64, height: 48, channels: 3 } }).jpeg({ quality: 100 })
      .withMetadata({ exif: { IFD0: { DateTime: '2020:01:02 03:04:05' } } }).toFile(join(photos, 'b.jpg'));
    const changed = Buffer.from(original);
    changed[0] = changed[0] > 128 ? 0 : 255;
    await sharp(changed, { raw: { width: 64, height: 48, channels: 3 } }).jpeg({ quality: 100 }).toFile(join(photos, 'c.jpg'));
    const catalog = new Catalog(dataDir);
    const list = await scan(catalog);
    catalog.close();
    expect(byName(list, 'b.jpg').contentKey).toBe(byName(list, 'a.jpg').contentKey);
    expect(byName(list, 'c.jpg').contentKey).not.toBe(byName(list, 'a.jpg').contentKey);
  });

  it('a cached row without a content key gets one on the next scan', async () => {
    await makeJpeg(join(photos, 'a.jpg'), { r: 200, g: 60, b: 40 });
    const catalog = new Catalog(dataDir);
    const first = byName(await scan(catalog), 'a.jpg');
    catalog.close();
    const db = new DatabaseSync(join(dataDir, 'gallery.sqlite'));
    db.exec('UPDATE photos SET content_key = NULL');
    db.close();
    const again = new Catalog(dataDir);
    expect(again.get(first.path)!.contentKey).toBeNull();
    const second = byName(await scan(again), 'a.jpg');
    expect(second.contentKey).toBe(first.contentKey);
    expect(again.get(first.path)!.contentKey).toBe(first.contentKey);
    again.close();
  });
});

describe('tag rows', () => {
  it('putTags then tagsFor returns the row without its embedding (only embeddings() reads those); failed rows keep their error', () => {
    const catalog = new Catalog(dataDir);
    const embedding = new Float32Array([0.6, 0.8]);
    catalog.putTags(tagRow('k1', 'm1', { description: 'A dog.', keywords: [{ label: 'dog', score: 0.9 }], objects: [{ label: 'dog', count: 2 }], embedding }));
    catalog.putTags(tagRow('k2', 'm1', { status: 'failed', error: 'unreadable' }));
    catalog.putTags(tagRow('k1', 'other', { description: 'Not asked for.' }));
    const got = catalog.tagsFor(['k1', 'k2', 'k3'], ['m1']);
    expect([...got.keys()].sort()).toEqual(['k1', 'k2']);
    // The embedding (2-3 KB a photo) is not read for the items or the queue: only search by meaning needs it.
    expect(got.get('k1')).toEqual([tagRow('k1', 'm1', { description: 'A dog.', keywords: [{ label: 'dog', score: 0.9 }], objects: [{ label: 'dog', count: 2 }], embedding: null })]);
    expect(got.get('k2')![0]).toMatchObject({ status: 'failed', error: 'unreadable' });
    expect([...catalog.embeddings(['k1', 'k2'], 'm1').entries()]).toEqual([['k1', embedding]]);
    catalog.close();
  });
});

describe('items carry tags', () => {
  let server: Server | undefined;
  let closeApp: (() => void) | undefined;
  let base: string;
  const [describeSmall, , keywordsSmall] = FAKE_CATALOGUE;

  const start = async () => {
    const { app, close } = createGalleryApp(dataDir, { photoInfoFallbackDir: join(root, 'fallback'), tagging: { fetch: fakeFetch(), catalogue: FAKE_CATALOGUE } });
    closeApp = close;
    await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };
  const items = async () => {
    const { jobId } = await (await fetch(`${base}/api/gallery/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: photos, recursive: false }) })).json();
    for (;;) {
      const job = await (await fetch(`${base}/api/gallery/jobs/${jobId}`)).json();
      if (job.done) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return (await (await fetch(`${base}/api/gallery/items?job=${jobId}`)).json()) as { fileName: string; contentKey: string; tags: Record<string, unknown> }[];
  };

  beforeEach(async () => {
    await makeJpeg(join(photos, 'a.jpg'), { r: 200, g: 60, b: 40 });
    await makeJpeg(join(photos, 'b.jpg'), { r: 20, g: 60, b: 240 });
  });
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    closeApp?.();
  });

  it('items carry tags for the chosen models only, state waiting when not done, off when no model chosen', async () => {
    await start();
    const off = await items();
    expect(off.map((i) => i.tags)).toEqual([
      { state: 'off', description: null, keywords: [], objects: [] },
      { state: 'off', description: null, keywords: [], objects: [] },
    ]);
    await downloadModel(dataDir, describeSmall, { fetch: fakeFetch() });
    writeTaggingSettings(dataDir, { describe: describeSmall.id, keywords: null, paused: false });
    const a = off.find((i) => i.fileName === 'a.jpg')!;
    const catalog = new Catalog(join(dataDir));
    catalog.putTags(tagRow(a.contentKey, describeSmall.id, { description: 'A red square.', objects: [{ label: 'square', count: 1 }] }));
    catalog.putTags(tagRow(a.contentKey, describeSmall.id.replace('small', 'large'), { description: 'From the other model.' }));
    catalog.close();
    const got = await items();
    expect(got.find((i) => i.fileName === 'a.jpg')!.tags).toEqual({ state: 'done', description: 'A red square.', keywords: [], objects: [{ label: 'square', count: 1 }] });
    expect(got.find((i) => i.fileName === 'b.jpg')!.tags).toEqual({ state: 'waiting', description: null, keywords: [], objects: [] });
  });

  it('an item carries at most 12 keywords and no embedding', async () => {
    await downloadModel(dataDir, keywordsSmall, { fetch: fakeFetch() });
    writeTaggingSettings(dataDir, { describe: null, keywords: keywordsSmall.id, paused: false });
    await start();
    const first = await items();
    const catalog = new Catalog(dataDir);
    for (const i of first) {
      catalog.putTags(tagRow(i.contentKey, keywordsSmall.id, {
        keywords: Array.from({ length: 20 }, (_, n) => ({ label: `word${n}`, score: 1 - n / 100 })),
        embedding: new Float32Array(512).fill(0.01),
      }));
    }
    catalog.close();
    const got = await items();
    for (const i of got) {
      expect(i.tags.state).toBe('done');
      expect(i.tags.keywords).toEqual(Array.from({ length: 12 }, (_, n) => `word${n}`));
      expect(JSON.stringify(i)).not.toMatch(/embedding/);
    }
  });
});
