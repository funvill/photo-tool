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
  /** sha1 of the decoded pixels of the 1600 px thumbnail: the same for a renamed, moved or re-tagged file. Null only before it was worked out. */
  contentKey: string | null;
}

/** One model's results for one picture (by content key). */
export interface TagRow {
  contentKey: string;
  modelId: string;
  status: 'done' | 'failed';
  description: string | null;
  keywords: { label: string; score: number }[];
  objects: { label: string; count: number }[];
  /** The picture's embedding (keywords models); stays in this cache. */
  embedding: Float32Array | null;
  error: string | null;
}

export const photoKey = (path: string, size: number, mtimeMs: number) => createHash('sha1').update(`${path}|${size}|${mtimeMs}`).digest('hex');

const RECENT_MAX = 12;

interface PhotoRow {
  path: string; folder: string; file_name: string; rel_dir: string; size: number; mtime_ms: number;
  width: number; height: number; format: string; captured_at: string | null; gps_lat: number | null;
  gps_lon: number | null; camera: string | null; exif: string | null; analysis: string | null; key: string;
  content_key: string | null;
}

interface TagDbRow {
  content_key: string; model_id: string; status: string; description: string | null; keywords: string | null;
  objects: string | null; embedding: Uint8Array | null; error: string | null;
}

const toTagRow = (r: TagDbRow): TagRow => ({
  contentKey: r.content_key, modelId: r.model_id, status: r.status === 'failed' ? 'failed' : 'done', description: r.description,
  keywords: r.keywords ? JSON.parse(r.keywords) : [], objects: r.objects ? JSON.parse(r.objects) : [],
  embedding: r.embedding ? new Float32Array(new Uint8Array(r.embedding).buffer) : null, error: r.error,
});

/** SQLite caps the number of `?` in one statement; look keys up in batches. */
const IN_BATCH = 500;

const toPhoto = (r: PhotoRow): GalleryPhoto => ({
  path: r.path, folder: r.folder, fileName: r.file_name, relDir: r.rel_dir, size: r.size, mtimeMs: r.mtime_ms,
  width: r.width, height: r.height, format: r.format, capturedAt: r.captured_at, gpsLat: r.gps_lat, gpsLon: r.gps_lon,
  camera: r.camera, exif: r.exif ? (JSON.parse(r.exif) as PhotoExif) : null, analysis: r.analysis ? (JSON.parse(r.analysis) as PhotoAnalysis) : null, key: r.key,
  contentKey: r.content_key ?? null,
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
    // Nor one made before tagging: the content key is worked out on the next scan.
    if (!columns.some((c) => c.name === 'content_key')) this.db.exec('ALTER TABLE photos ADD COLUMN content_key TEXT');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        content_key TEXT NOT NULL, model_id TEXT NOT NULL, status TEXT NOT NULL, description TEXT, keywords TEXT,
        objects TEXT, embedding BLOB, error TEXT, made_at INTEGER NOT NULL, PRIMARY KEY (content_key, model_id)
      );
    `);
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
        `INSERT OR REPLACE INTO photos (path, folder, file_name, rel_dir, size, mtime_ms, width, height, format, captured_at, gps_lat, gps_lon, camera, exif, analysis, key, content_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.path, p.folder, p.fileName, p.relDir, p.size, p.mtimeMs, p.width, p.height, p.format, p.capturedAt, p.gpsLat, p.gpsLon, p.camera, p.exif ? JSON.stringify(p.exif) : null, p.analysis ? JSON.stringify(p.analysis) : null, p.key, p.contentKey ?? null);
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

  putTags(t: TagRow): void {
    const emb = t.embedding ? new Uint8Array(t.embedding.buffer, t.embedding.byteOffset, t.embedding.byteLength) : null;
    this.db
      .prepare('INSERT OR REPLACE INTO tags (content_key, model_id, status, description, keywords, objects, embedding, error, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.contentKey, t.modelId, t.status, t.description, JSON.stringify(t.keywords), JSON.stringify(t.objects), emb, t.error, Date.now());
  }

  /** The rows of these models for these pictures, by content key. */
  tagsFor(contentKeys: string[], modelIds: string[]): Map<string, TagRow[]> {
    const out = new Map<string, TagRow[]>();
    if (!modelIds.length) return out;
    const models = modelIds.map(() => '?').join(',');
    const keys = [...new Set(contentKeys)];
    for (let i = 0; i < keys.length; i += IN_BATCH) {
      const batch = keys.slice(i, i + IN_BATCH);
      const rows = this.db
        .prepare(`SELECT content_key, model_id, status, description, keywords, objects, embedding, error FROM tags WHERE model_id IN (${models}) AND content_key IN (${batch.map(() => '?').join(',')})`)
        .all(...modelIds, ...batch) as unknown as TagDbRow[];
      for (const r of rows) {
        const list = out.get(r.content_key) ?? [];
        list.push(toTagRow(r));
        out.set(r.content_key, list);
      }
    }
    return out;
  }

  /** The picture embeddings of one model, by content key (pictures without one are left out). */
  embeddings(contentKeys: string[], modelId: string): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (const [k, rows] of this.tagsFor(contentKeys, [modelId])) {
      const e = rows[0]?.embedding;
      if (e) out.set(k, e);
    }
    return out;
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
