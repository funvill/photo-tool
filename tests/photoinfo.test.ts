// The photoinfo.json module: round trips, preservation of unknown data, safe writes, and the read-only fallback.
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PHOTOINFO_FORMAT,
  PHOTOINFO_NAME,
  PhotoInfoWriteError,
  folderStamp,
  forgetPhotos,
  infoFor,
  parsePhotoInfo,
  readFolderInfo,
  updatePhotoInfo,
  type PhotoInfoOptions,
} from '../src/photoinfo';
import { PhotoInfoIndex } from '../src/server/photoInfoIndex';
import { fakeAsset } from './helpers';

describe('photoinfo', () => {
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

  it('round-trips every field', () => {
    const all = {
      star: true,
      people: ['Ann', 'Bo'],
      date: '2024-05-01T10:20:30',
      location: { lat: 49.28, lon: -123.12, name: 'Vancouver' },
      description: 'A day out',
      notes: 'private',
    };
    updatePhotoInfo(dir, 'a.jpg', all, opts);
    const info = readFolderInfo(dir, opts);
    expect(info.source).toBe('folder');
    expect(info.error).toBeUndefined();
    expect(infoFor(info, 'a.jpg')).toEqual(all);
    const raw = readFileSync(file(), 'utf8');
    expect(JSON.parse(raw).format).toBe('photoinfo/1');
    expect(PHOTOINFO_FORMAT).toBe('photoinfo/1');
    expect(raw).toContain('\n  "');
  });

  it('keeps unknown fields and entries', () => {
    writeFileSync(file(), '{"format":"photoinfo/1","owner":"x","photos":{"gone.jpg":{"star":true},"a.jpg":{"rating":4}}}');
    updatePhotoInfo(dir, 'a.jpg', { star: true }, opts);
    const written = JSON.parse(readFileSync(file(), 'utf8'));
    expect(written.owner).toBe('x');
    expect(written.photos['gone.jpg'].star).toBe(true);
    expect(written.photos['a.jpg']).toEqual({ rating: 4, star: true });
  });

  it('null deletes a field and empty entries go', () => {
    updatePhotoInfo(dir, 'a.jpg', { star: true }, opts);
    updatePhotoInfo(dir, 'a.jpg', { star: null }, opts);
    expect('a.jpg' in readFolderInfo(dir, opts).photos).toBe(false);
  });

  it('two writers do not lose each other\'s changes', () => {
    updatePhotoInfo(dir, 'a.jpg', { star: true }, opts);
    updatePhotoInfo(dir, 'b.jpg', { notes: 'hi' }, opts);
    const { photos } = readFolderInfo(dir, opts);
    expect(photos['a.jpg']).toEqual({ star: true });
    expect(photos['b.jpg']).toEqual({ notes: 'hi' });
  });

  it('broken file is never overwritten', () => {
    writeFileSync(file(), '{not json');
    const info = readFolderInfo(dir, opts);
    expect(info.photos).toEqual({});
    expect(info.error).toBeTruthy();
    expect(() => updatePhotoInfo(dir, 'a.jpg', { star: true }, opts)).toThrow(PhotoInfoWriteError);
    expect(readFileSync(file(), 'utf8')).toBe('{not json');
  });

  it('case-insensitive lookup reuses the key', () => {
    writeFileSync(file(), JSON.stringify({ format: 'photoinfo/1', photos: { 'img_1.jpg': { star: true } } }));
    expect(infoFor(readFolderInfo(dir, opts), 'IMG_1.JPG')).toEqual({ star: true });
    updatePhotoInfo(dir, 'IMG_1.JPG', { notes: 'x' }, opts);
    const written = JSON.parse(readFileSync(file(), 'utf8'));
    expect(Object.keys(written.photos)).toEqual(['img_1.jpg']);
    expect(written.photos['img_1.jpg']).toEqual({ star: true, notes: 'x' });
  });

  it('forgetPhotos removes only the named entries and keeps unknown fields and other entries', () => {
    writeFileSync(file(), '{"format":"photoinfo/1","owner":"x","photos":{"gone.jpg":{"star":true},"Also.JPG":{"notes":"n"},"a.jpg":{"rating":4}}}');
    expect(forgetPhotos(dir, ['gone.jpg', 'also.jpg', 'never.jpg'], opts)).toBe(2);
    const written = JSON.parse(readFileSync(file(), 'utf8'));
    expect(written.owner).toBe('x');
    expect(written.format).toBe('photoinfo/1');
    expect(written.photos).toEqual({ 'a.jpg': { rating: 4 } });
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('forgetPhotos returns 0 without writing when nothing matches', () => {
    expect(forgetPhotos(dir, ['a.jpg'], opts)).toBe(0);
    expect(existsSync(file())).toBe(false);
    updatePhotoInfo(dir, 'a.jpg', { star: true }, opts);
    const before = readFileSync(file(), 'utf8');
    let writes = 0;
    expect(forgetPhotos(dir, ['b.jpg'], { ...opts, writeFile: () => void writes++ })).toBe(0);
    expect(writes).toBe(0);
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('forgetPhotos goes through the fallback for a read-only folder, and never overwrites a broken file', () => {
    updatePhotoInfo(dir, 'gone.jpg', { star: true }, opts);
    updatePhotoInfo(dir, 'a.jpg', { star: true }, opts);
    const ro = readOnlyOpts();
    expect(forgetPhotos(dir, ['gone.jpg'], ro)).toBe(1);
    const info = readFolderInfo(dir, ro);
    expect(info.source).toBe('fallback');
    expect(Object.keys(info.photos)).toEqual(['a.jpg']);
    // The folder's own file is untouched.
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')).photos).sort()).toEqual(['a.jpg', 'gone.jpg']);

    writeFileSync(file(), '{ not json');
    rmSync(fallbackDir, { recursive: true, force: true });
    expect(() => forgetPhotos(dir, ['a.jpg'], opts)).toThrow(PhotoInfoWriteError);
    expect(readFileSync(file(), 'utf8')).toBe('{ not json');
  });

  it('read-only folder falls back', () => {
    // Simulate a read-only folder on any platform: writes into the folder fail with EPERM.
    const writeFile = (target: string, text: string) => {
      if (target.startsWith(dir)) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      writeFileSync(target, text);
    };
    const ro: PhotoInfoOptions = { fallbackDir, writeFile };
    updatePhotoInfo(dir, 'a.jpg', { star: true }, ro);
    expect(existsSync(file())).toBe(false);
    const info = readFolderInfo(dir, ro);
    expect(info.source).toBe('fallback');
    expect(infoFor(info, 'a.jpg')?.star).toBe(true);
    const files = readdirSync(fallbackDir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(fallbackDir, files[0]), 'utf8')).folder).toBeTruthy();
    // A fresh read with default options sees it too, and later updates keep extending it.
    expect(infoFor(readFolderInfo(dir, opts), 'a.jpg')?.star).toBe(true);
    updatePhotoInfo(dir, 'b.jpg', { star: true }, ro);
    expect(Object.keys(readFolderInfo(dir, ro).photos).sort()).toEqual(['a.jpg', 'b.jpg']);
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

  it('a later successful folder write removes the fallback file', () => {
    updatePhotoInfo(dir, 'a.jpg', { star: true }, readOnlyOpts());
    expect(readdirSync(fallbackDir)).toHaveLength(1);
    updatePhotoInfo(dir, 'b.jpg', { star: true }, opts);
    expect(readdirSync(fallbackDir)).toEqual([]);
    const info = readFolderInfo(dir, opts);
    expect(info.source).toBe('folder');
    expect(Object.keys(info.photos).sort()).toEqual(['a.jpg', 'b.jpg']);
  });

  it('update does not create a missing photo folder', () => {
    const missing = join(dir, 'nope');
    expect(() => updatePhotoInfo(missing, 'a.jpg', { star: true }, opts)).toThrow(PhotoInfoWriteError);
    expect(existsSync(missing)).toBe(false);
  });

  it('other write errors are not swallowed into the fallback', () => {
    const writeFile = () => {
      throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
    };
    expect(() => updatePhotoInfo(dir, 'a.jpg', { star: true }, { fallbackDir, writeFile })).toThrow(PhotoInfoWriteError);
    expect(readdirSync(fallbackDir)).toEqual([]);
  });

  it('a busy photoinfo.json (rename refused) is retried, not sent to the fallback', () => {
    let calls = 0;
    const rename = (from: string, to: string) => {
      if (++calls <= 2) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      renameSync(from, to);
    };
    updatePhotoInfo(dir, 'a.jpg', { star: true }, { fallbackDir, rename });
    expect(calls).toBe(3);
    expect(readdirSync(fallbackDir)).toEqual([]);
    expect(readFolderInfo(dir, opts).source).toBe('folder');
    expect(infoFor(readFolderInfo(dir, opts), 'a.jpg')?.star).toBe(true);
    expect(readdirSync(dir)).toEqual([PHOTOINFO_NAME]);
  });

  it('a photoinfo.json that stays busy gives a clear error, no fallback and no temp file', () => {
    const rename = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    let err: unknown;
    try {
      updatePhotoInfo(dir, 'a.jpg', { star: true }, { fallbackDir, rename });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PhotoInfoWriteError);
    expect((err as Error).message).toContain('is in use by another program; try again');
    expect(readdirSync(fallbackDir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stamp changes after a write', () => {
    expect(folderStamp(dir, opts)).toBe('none');
    updatePhotoInfo(dir, 'a.jpg', { star: true }, opts);
    const before = folderStamp(dir, opts);
    expect(before).not.toBe('none');
    updatePhotoInfo(dir, 'a.jpg', { notes: 'a longer change' }, opts);
    expect(folderStamp(dir, opts)).not.toBe(before);
    expect(readFolderInfo(dir, opts).stamp).toBe(folderStamp(dir, opts));
  });

  it('no temp files left behind', () => {
    updatePhotoInfo(dir, 'a.jpg', { star: true }, opts);
    updatePhotoInfo(dir, 'b.jpg', { star: true }, opts);
    updatePhotoInfo(dir, 'a.jpg', { star: null }, opts);
    expect(readdirSync(dir)).toEqual([PHOTOINFO_NAME]);
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

  it('parsePhotoInfo rejects the wrong shape', () => {
    expect(() => parsePhotoInfo('[]')).toThrow();
    expect(() => parsePhotoInfo('{"photos":[]}')).toThrow();
    expect(() => parsePhotoInfo('{"photos":{"a.jpg":3}}')).toThrow();
    expect(parsePhotoInfo('{}').photos).toEqual({});
  });
});
