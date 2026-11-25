// PhotoInfoIndex (the editor's cache over photoinfo.json): the photo's star and the unreachable-folder flag.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PHOTOINFO_NAME,
  folderStamp,
  readFolderInfo,
  updatePhotoInfo,
  type PhotoInfoOptions,
} from '../../shared/photoinfo';
import { PhotoInfoIndex } from '../server/photoInfoIndex';
import { fakeAsset } from './helpers';

describe('PhotoInfoIndex', () => {
  let dir: string;
  let fallbackDir: string;
  let opts: PhotoInfoOptions;
  const file = () => join(dir, PHOTOINFO_NAME);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'photoinfo-'));
    fallbackDir = mkdtempSync(join(tmpdir(), 'photoinfo-fb-'));
    opts = { fallbackDir };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  });

  const readOnlyOpts = (): PhotoInfoOptions => ({
    fallbackDir,
    writeFile: (target, text) => {
      if (target.startsWith(dir)) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      writeFileSync(target, text);
    },
  });

  it('existing read-only photoinfo.json: edit lands in fallback and is visible on the next read', () => {
    writeFileSync(file(), JSON.stringify({ format: 'photoinfo/1', photos: { 'a.jpg': { star: true } } }));
    const index = new PhotoInfoIndex(opts);
    const photo = join(dir, 'b.jpg');
    const asset = fakeAsset({ favorite: false });
    expect(index.apply(asset, photo).favorite).toBe(false);
    const stampBefore = folderStamp(dir, opts);
    updatePhotoInfo(dir, 'b.jpg', { notes: 'new', star: true }, readOnlyOpts());
    // The folder's own file did not change, but the fallback did: the stamp must say so,
    // and an index that already read the folder sees the star.
    expect(folderStamp(dir, opts)).not.toBe(stampBefore);
    expect(index.apply(asset, photo).favorite).toBe(true);
    expect(new PhotoInfoIndex(opts).apply(asset, photo).favorite).toBe(true);
    updatePhotoInfo(dir, 'b.jpg', { star: null }, readOnlyOpts());
    for (const o of [readOnlyOpts(), opts]) {
      const info = readFolderInfo(dir, o);
      expect(info.source).toBe('fallback');
      expect(info.photos['a.jpg']).toEqual({ star: true });
      expect(info.photos['b.jpg']).toEqual({ notes: 'new' });
    }
    expect(JSON.parse(readFileSync(file(), 'utf8')).photos['b.jpg']).toBeUndefined();
  });

  it('applyAll reads each folder once per call, however many photos it holds', () => {
    writeFileSync(file(), JSON.stringify({ format: 'photoinfo/1', photos: { 'p0.jpg': { star: true } } }));
    let stamps = 0;
    let reads = 0;
    const index = new PhotoInfoIndex(opts, {
      stamp: (f, o) => (stamps++, folderStamp(f, o)),
      read: (f, o) => (reads++, readFolderInfo(f, o)),
    });
    const rows = Array.from({ length: 25 }, (_, i) => ({ asset: fakeAsset({ favorite: false }), path: join(dir, `p${i}.jpg`) }));
    const first = index.applyAll(rows);
    expect(first[0].favorite).toBe(true);
    expect(first.slice(1).every((a) => !a.favorite)).toBe(true);
    expect(stamps).toBe(1);
    expect(reads).toBe(1);
    index.applyAll(rows);
    expect(stamps).toBe(2);
    expect(reads).toBe(1); // unchanged file: served from the cache
  });

  it('flags photos whose folder is unreachable or whose photoinfo.json is broken', () => {
    const index = new PhotoInfoIndex(opts);
    const asset = fakeAsset({ favorite: true });
    expect(index.apply(asset, join(dir, 'a.jpg')).infoUnavailable).toBeUndefined();
    const gone = index.apply(asset, join(dir, 'offline', 'a.jpg'));
    expect(gone.infoUnavailable).toBe(true);
    expect(gone.favorite).toBe(false);
    writeFileSync(file(), '{broken');
    expect(index.apply(asset, join(dir, 'a.jpg')).infoUnavailable).toBe(true);
  });
});
