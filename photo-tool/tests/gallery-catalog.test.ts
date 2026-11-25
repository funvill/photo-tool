import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir as fsReaddir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../server/catalog';
import { GalleryFolderError, Scanner } from '../server/scanner';
import { listPhotos, type ReadDir } from '../server/walk';
import { analyze, readMetadata } from '../../shared/server/media';

const TRIP = join(process.cwd(), 'fixtures', 'generated', 'trip');

let root: string;
let photos: string;
let dataDir: string;
let catalog: Catalog;

const listing = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gallery-'));
  photos = join(root, 'trip');
  dataDir = join(root, 'data');
  cpSync(TRIP, photos, { recursive: true });
  catalog = new Catalog(dataDir);
});

afterEach(() => {
  catalog.close();
  rmSync(root, { recursive: true, force: true });
});

describe('readMetadata camera', () => {
  it('reads Make and Model, and gives null without EXIF', async () => {
    expect((await readMetadata(join(TRIP, 'day1-01-arrival.jpg'))).camera).toBe('Photobook Fixture Synthetic');
    expect((await readMetadata(join(TRIP, 'undated-scan.png'))).camera).toBeNull();
  });
});

describe('catalog exif column', () => {
  it('opens a cache made without the exif column and adds it', () => {
    const dir = join(root, 'old');
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'gallery.sqlite'));
    db.exec(`CREATE TABLE photos (
      path TEXT PRIMARY KEY, folder TEXT NOT NULL, file_name TEXT NOT NULL, rel_dir TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      format TEXT NOT NULL, captured_at TEXT, gps_lat REAL, gps_lon REAL, camera TEXT, analysis TEXT,
      key TEXT NOT NULL UNIQUE);
      INSERT INTO photos VALUES ('/p/a.jpg', '/p', 'a.jpg', '', 1, 2, 3, 4, 'jpeg', NULL, NULL, NULL, 'Cam', NULL, 'k');`);
    db.close();
    const old = new Catalog(dir);
    try {
      expect(old.get('/p/a.jpg')).toMatchObject({ camera: 'Cam', exif: null });
    } finally {
      old.close();
    }
  });

  it('put and get round-trip exif', () => {
    const photo = { path: '/p/b.jpg', folder: '/p', fileName: 'b.jpg', relDir: '', size: 1, mtimeMs: 2, width: 3, height: 4, format: 'jpeg', capturedAt: null, gpsLat: null, gpsLon: null, camera: null, analysis: null, key: 'kb', contentKey: null };
    catalog.put({ ...photo, exif: { iso: 100, flash: false, exposureBias: 0 } });
    expect(catalog.get('/p/b.jpg')?.exif).toEqual({ iso: 100, flash: false, exposureBias: 0 });
    catalog.put({ ...photo, path: '/p/c.jpg', key: 'kc', exif: null });
    expect(catalog.get('/p/c.jpg')?.exif).toBeNull();
  });
});

describe('gallery scan', () => {
  it('catalogues the trip folder with analysis and thumbnails', async () => {
    const before = listing(photos);
    const scanner = new Scanner(catalog, dataDir);
    const job = await scanner.wait(scanner.open(photos, false).id);
    expect(job.done).toBe(true);
    expect([job.total, job.processed, job.photos.length]).toEqual([21, 21, 21]);
    expect(job.errors).toEqual([]);
    for (const p of job.photos) {
      expect(p.analysis).not.toBeNull();
      expect(p.width).toBeGreaterThan(0);
      expect(existsSync(catalog.thumbPath(p.key, 's'))).toBe(true);
      expect(existsSync(catalog.thumbPath(p.key, 'm'))).toBe(true);
    }
    const heic = job.photos.find((p) => p.fileName === 'day2-06-heic-sunset.heic')!;
    expect(heic.path.endsWith('.heic')).toBe(true);
    expect(heic.format).toBe('heif');
    expect(heic.relDir).toBe('');
    expect(catalog.get(heic.path)?.key).toBe(heic.key);
    expect(catalog.getByKey(heic.key)?.path).toBe(heic.path);
    expect(catalog.get(join(photos, 'nope.jpg'))).toBeNull();
    expect(listing(photos)).toEqual(before); // nothing written beside the photos
  });

  it('reuses cached analysis when path, size and mtime are unchanged', async () => {
    const first = new Scanner(catalog, dataDir);
    await first.wait(first.open(photos, false).id);
    const spy = vi.fn(analyze);
    const second = new Scanner(catalog, dataDir, { analyze: spy });
    const job = await second.wait(second.open(photos, false).id);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(job.photos).toHaveLength(21);
  });

  it('re-analyses only a file whose mtime changed', async () => {
    const first = new Scanner(catalog, dataDir);
    await first.wait(first.open(photos, false).id);
    const t = new Date(Date.now() + 60_000);
    utimesSync(join(photos, 'day1-01-arrival.jpg'), t, t);
    const spy = vi.fn(analyze);
    const second = new Scanner(catalog, dataDir, { analyze: spy });
    await second.wait(second.open(photos, false).id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves out a file deleted between scans', async () => {
    const scanner = new Scanner(catalog, dataDir);
    await scanner.wait(scanner.open(photos, false).id);
    rmSync(join(photos, 'day1-02-street.jpg'));
    const job = await scanner.wait(scanner.open(photos, false).id);
    expect(job.photos).toHaveLength(20);
    expect(job.photos.some((p) => p.fileName === 'day1-02-street.jpg')).toBe(false);
  });

  it('throws GalleryFolderError for a folder that does not exist', () => {
    const scanner = new Scanner(catalog, dataDir);
    expect(() => scanner.open(join(root, 'missing'), true)).toThrow(GalleryFolderError);
  });

  it('includes subfolders only when recursive', async () => {
    mkdirSync(join(photos, 'sub'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, 'sub', 'inner.jpg'));
    const scanner = new Scanner(catalog, dataDir);
    const flat = await scanner.wait(scanner.open(photos, false).id);
    expect(flat.photos.some((p) => p.relDir === 'sub')).toBe(false);
    const deep = await scanner.wait(scanner.open(photos, true).id);
    const inner = deep.photos.filter((p) => p.relDir === 'sub');
    expect(inner.map((p) => p.fileName)).toEqual(['inner.jpg']);
    expect(deep.photos).toHaveLength(22);
  });

  it('skips a subfolder it may not read, reports it, and still reads the rest', async () => {
    mkdirSync(join(photos, 'System Volume Information'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, 'System Volume Information', 'hidden.jpg'));
    mkdirSync(join(photos, 'sub'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, 'sub', 'inner.jpg'));
    const denied = join(photos, 'System Volume Information');
    const readdir: ReadDir = async (dir) => {
      if (dir === denied) throw Object.assign(new Error(`EPERM: operation not permitted, scandir '${dir}'`), { code: 'EPERM' });
      return fsReaddir(dir, { withFileTypes: true });
    };
    const scanner = new Scanner(catalog, dataDir, { readdir });
    const job = await scanner.wait(scanner.open(photos, true).id);
    expect(job.photos).toHaveLength(22);
    expect(job.photos.some((p) => p.fileName === 'inner.jpg')).toBe(true);
    expect(job.photos.some((p) => p.fileName === 'hidden.jpg')).toBe(false);
    expect(job.errors).toEqual([{ path: denied, message: expect.stringContaining('EPERM') }]);
  });

  it('walks (supported files, no dotfiles, numeric order) and throws GalleryFolderError for an unreadable root', async () => {
    mkdirSync(join(photos, '.hidden'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, '.hidden', 'x.jpg'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, 'img10.jpg'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, 'img9.jpg'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, '.dot.jpg'));
    writeFileSync(join(photos, 'notes.txt'), 'x');
    const listing = await listPhotos(photos, true);
    expect(listing.errors).toEqual([]);
    const names = listing.files.map((f) => basename(f));
    expect(names.indexOf('img9.jpg')).toBeLessThan(names.indexOf('img10.jpg'));
    expect(names).not.toContain('x.jpg');
    expect(names).not.toContain('.dot.jpg');
    expect(names).not.toContain('notes.txt');
    const denied: ReadDir = async () => {
      throw new Error('EPERM: operation not permitted');
    };
    await expect(listPhotos(photos, true, denied)).rejects.toThrow(GalleryFolderError);
  });

  it('a second open of the same folder cancels the first, and no photo is analysed twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi.fn(async (workPath: string) => {
      await gate;
      return analyze(workPath);
    });
    const scanner = new Scanner(catalog, dataDir, { analyze: spy });
    const first = scanner.open(photos, false);
    // The first scan has photos half done when the folder is opened again.
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const second = scanner.open(photos, false);
    release();
    const done = await scanner.wait(second.id);
    const old = await scanner.wait(first.id);
    expect(old).toMatchObject({ done: true, cancelled: true });
    expect(old.photos.length).toBeLessThan(21);
    expect(done).toMatchObject({ done: true, cancelled: false, errors: [] });
    expect(done.photos).toHaveLength(21);
    expect(new Set(done.photos.map((p) => p.path)).size).toBe(21);
    expect(spy).toHaveBeenCalledTimes(21);
    // Every thumbnail is under its final name only: no half-written temp file is left behind.
    const thumbs = readdirSync(join(dataDir, 'thumbs')).sort();
    expect(thumbs).toEqual(done.photos.flatMap((p) => [`${p.key}_m.jpg`, `${p.key}_s.jpg`]).sort());
  });

  it('cancel stops a running scan at the next photo and keeps the photos read so far', async () => {
    const scanner = new Scanner(catalog, dataDir, { concurrency: 1 });
    const job = scanner.open(photos, false);
    await vi.waitFor(() => expect(job.processed).toBeGreaterThan(0), { timeout: 20_000 });
    scanner.cancel(job.id);
    const ended = await scanner.wait(job.id);
    expect(ended).toMatchObject({ done: true, cancelled: true });
    expect(ended.processed).toBeLessThan(21);
    expect(ended.photos.length).toBe(ended.processed);
    // Cancelling a finished scan changes nothing.
    const full = await scanner.wait(scanner.open(photos, false).id);
    scanner.cancel(full.id);
    expect(full.cancelled).toBe(false);
  });

  it('lists recent folders newest first', () => {
    catalog.touchRecent('/a', false);
    catalog.touchRecent('/b', true);
    expect(catalog.recentFolders().map((r) => [r.folder, r.recursive])).toEqual([['/b', true], ['/a', false]]);
    catalog.touchRecent('/a', true);
    expect(catalog.recentFolders().map((r) => r.folder)).toEqual(['/a', '/b']);
  });

  it('records opened folders as recent', async () => {
    const scanner = new Scanner(catalog, dataDir);
    await scanner.wait(scanner.open(photos, true).id);
    expect(catalog.recentFolders()[0]).toMatchObject({ folder: photos, recursive: true });
  });
});
