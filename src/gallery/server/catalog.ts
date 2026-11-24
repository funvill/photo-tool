import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PhotoAnalysis, PhotoExif } from '../../core';

// The gallery's own cache: one row per photo file, keyed by path and validated by size + mtime.
// Lives under the gallery's data dir, never in the editor's database.

export interface GalleryPhoto {
  path: string;
  folder: string;
  fileName: string;
  /** '' for the opened folder itself, else the subfolder relative to it with '/' separators. */
  relDir: string;
  size: number;
  mtimeMs: number;
  width: number;
  height: number;
  format: string;
  capturedAt: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  camera: string | null;
  /** Lens and exposure settings; null only for a row cached before they were read. */
  exif: PhotoExif | null;
  analysis: PhotoAnalysis | null;
  /** sha1(path|size|mtimeMs): names the thumbnails, changes when the file does. */
  key: string;
}

export const photoKey = (path: string, size: number, mtimeMs: number) => createHash('sha1').update(`${path}|${size}|${mtimeMs}`).digest('hex');

const RECENT_MAX = 12;

interface PhotoRow {
  path: string; folder: string; file_name: string; rel_dir: string; size: number; mtime_ms: number;
  width: number; height: number; format: string; captured_at: string | null; gps_lat: number | null;
  gps_lon: number | null; camera: string | null; exif: string | null; analysis: string | null; key: string;
}

const toPhoto = (r: PhotoRow): GalleryPhoto => ({
  path: r.path, folder: r.folder, fileName: r.file_name, relDir: r.rel_dir, size: r.size, mtimeMs: r.mtime_ms,
  width: r.width, height: r.height, format: r.format, capturedAt: r.captured_at, gpsLat: r.gps_lat, gpsLon: r.gps_lon,
  camera: r.camera, exif: r.exif ? (JSON.parse(r.exif) as PhotoExif) : null, analysis: r.analysis ? (JSON.parse(r.analysis) as PhotoAnalysis) : null, key: r.key,
});

export class Catalog {
  private db: DatabaseSync;

  constructor(private dataDir: string) {
    mkdirSync(join(dataDir, 'thumbs'), { recursive: true });
    mkdirSync(join(dataDir, 'derived'), { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'gallery.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS photos (
        path TEXT PRIMARY KEY, folder TEXT NOT NULL, file_name TEXT NOT NULL, rel_dir TEXT NOT NULL,
        size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        format TEXT NOT NULL, captured_at TEXT, gps_lat REAL, gps_lon REAL, camera TEXT, exif TEXT, analysis TEXT,
        key TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS recent (
        folder TEXT PRIMARY KEY, recursive INTEGER NOT NULL, opened_at TEXT NOT NULL, seq INTEGER NOT NULL
      );
    `);
    // A cache made before exif was read has no such column.
    const columns = this.db.prepare('PRAGMA table_info(photos)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'exif')) this.db.exec('ALTER TABLE photos ADD COLUMN exif TEXT');
  }

  get(path: string): GalleryPhoto | null {
    const r = this.db.prepare('SELECT * FROM photos WHERE path = ?').get(path) as PhotoRow | undefined;
    return r ? toPhoto(r) : null;
  }

  getByKey(key: string): GalleryPhoto | null {
    const r = this.db.prepare('SELECT * FROM photos WHERE key = ?').get(key) as PhotoRow | undefined;
    return r ? toPhoto(r) : null;
  }

  /** The cached row for `path`, only if the file is still the one that was analysed. */
  lookup(path: string, size: number, mtimeMs: number): GalleryPhoto | null {
    const p = this.get(path);
    return p && p.size === size && p.mtimeMs === mtimeMs ? p : null;
  }

  put(p: GalleryPhoto): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO photos (path, folder, file_name, rel_dir, size, mtime_ms, width, height, format, captured_at, gps_lat, gps_lon, camera, exif, analysis, key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.path, p.folder, p.fileName, p.relDir, p.size, p.mtimeMs, p.width, p.height, p.format, p.capturedAt, p.gpsLat, p.gpsLon, p.camera, p.exif ? JSON.stringify(p.exif) : null, p.analysis ? JSON.stringify(p.analysis) : null, p.key);
  }

  /**
   * Forget a photo (its file was deleted): its row and its thumbnails in the cache. Only the cache's own
   * files are removed here, never the photo. A thumbnail already gone is fine.
   */
  remove(path: string): void {
    const p = this.get(path);
    if (!p) return;
    this.db.prepare('DELETE FROM photos WHERE path = ?').run(path);
    for (const size of ['s', 'm'] as const) rmSync(this.thumbPath(p.key, size), { force: true });
  }

  thumbPath(key: string, size: 's' | 'm'): string {
    return join(this.dataDir, 'thumbs', `${key}_${size}.jpg`);
  }

  recentFolders(): { folder: string; recursive: boolean; openedAt: string }[] {
    const rows = this.db.prepare('SELECT folder, recursive, opened_at FROM recent ORDER BY seq DESC LIMIT ?').all(RECENT_MAX) as { folder: string; recursive: number; opened_at: string }[];
    return rows.map((r) => ({ folder: r.folder, recursive: !!r.recursive, openedAt: r.opened_at }));
  }

  touchRecent(folder: string, recursive: boolean): void {
    const next = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM recent').get() as { n: number }).n;
    this.db.prepare('INSERT OR REPLACE INTO recent (folder, recursive, opened_at, seq) VALUES (?, ?, ?, ?)').run(folder, recursive ? 1 : 0, new Date().toISOString(), next);
    this.db.prepare('DELETE FROM recent WHERE seq <= ?').run(next - RECENT_MAX);
  }

  close(): void {
    this.db.close();
  }
}
