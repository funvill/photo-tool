import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import type { PhotoAnalysis } from '../../core';
import { scanFolder } from '../../server/importer';
import { analyze as defaultAnalyze, fileStat, hashFile, orientedSize, readMetadata, THUMB_SIZES, workingFile, writeJpegThumb, type ThumbSize } from '../../server/media';
import { photoKey, type Catalog, type GalleryPhoto } from './catalog';

// Background folder scan for the gallery: walks a folder, and for each photo either reuses the
// catalog row (same path, size and mtime) or runs the editor's image pipeline once.

export class GalleryFolderError extends Error {}

export interface ScanJob {
  id: string;
  root: string;
  recursive: boolean;
  total: number;
  processed: number;
  startedAt: number;
  done: boolean;
  errors: { path: string; message: string }[];
  /** In completion order, only ever appended to. */
  photos: GalleryPhoto[];
}

interface ScannerOptions {
  concurrency?: number;
  analyze?: (workPath: string) => Promise<PhotoAnalysis>;
}

export class Scanner {
  private jobs = new Map<string, ScanJob>();
  private concurrency: number;
  private analyze: (workPath: string) => Promise<PhotoAnalysis>;

  constructor(private catalog: Catalog, private dataDir: string, opts: ScannerOptions = {}) {
    this.concurrency = opts.concurrency ?? 4;
    this.analyze = opts.analyze ?? defaultAnalyze;
  }

  /** Starts a scan and returns at once; poll `get` for progress. */
  open(root: string, recursive: boolean): ScanJob {
    const folder = resolve(root);
    let isDir = false;
    try {
      isDir = statSync(folder).isDirectory();
    } catch {
      // not there or not readable: reported below
    }
    if (!isDir) throw new GalleryFolderError(`Not a readable folder: ${root}`);
    const job: ScanJob = { id: randomUUID(), root: folder, recursive, total: 0, processed: 0, startedAt: Date.now(), done: false, errors: [], photos: [] };
    this.jobs.set(job.id, job);
    this.catalog.touchRecent(folder, recursive);
    void this.run(job);
    return job;
  }

  get(id: string): ScanJob | undefined {
    return this.jobs.get(id);
  }

  async wait(id: string): Promise<ScanJob> {
    for (;;) {
      const job = this.jobs.get(id);
      if (!job) throw new Error(`No such scan: ${id}`);
      if (job.done) return job;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private async run(job: ScanJob) {
    try {
      const files = await scanFolder(job.root, job.recursive);
      job.total = files.length;
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const file = files[next++];
          try {
            job.photos.push(await this.scanOne(job, file));
          } catch (e) {
            job.errors.push({ path: file, message: e instanceof Error ? e.message : String(e) });
          }
          job.processed++;
        }
      };
      await Promise.all(Array.from({ length: this.concurrency }, worker));
    } catch (e) {
      job.errors.push({ path: job.root, message: e instanceof Error ? e.message : String(e) });
    }
    job.done = true;
  }

  private async scanOne(job: ScanJob, path: string): Promise<GalleryPhoto> {
    const st = await fileStat(path);
    const relDir = relative(job.root, dirname(path)).split(/[\\/]/).filter(Boolean).join('/');
    const hit = this.catalog.lookup(path, st.size, st.mtimeMs);
    // A cached row is reused as long as its thumbnails are still on disk.
    if (hit && (await this.thumbsExist(hit.key))) {
      const photo = { ...hit, folder: job.root, relDir };
      if (photo.folder !== hit.folder || photo.relDir !== hit.relDir) this.catalog.put(photo);
      return photo;
    }
    // The content hash is only needed to name a HEIC's derived JPEG.
    const isHeic = ['.heic', '.heif'].includes(extname(path).toLowerCase());
    const work = await workingFile(path, this.dataDir, isHeic ? await hashFile(path) : '');
    const [dims, meta, analysis] = await Promise.all([orientedSize(work.path), readMetadata(path), this.analyze(work.path)]);
    // The derived JPEG of a HEIC would report 'jpeg', so its format comes from the original.
    const key = photoKey(path, st.size, st.mtimeMs);
    await Promise.all((Object.keys(THUMB_SIZES) as ThumbSize[]).map((s) => writeJpegThumb(work.path, s, this.catalog.thumbPath(key, s))));
    const photo: GalleryPhoto = {
      path, folder: job.root, fileName: basename(path), relDir, size: st.size, mtimeMs: st.mtimeMs,
      width: dims.width, height: dims.height, format: isHeic ? 'heif' : dims.format, capturedAt: meta.capturedAt, gpsLat: meta.gpsLat,
      gpsLon: meta.gpsLon, camera: meta.camera, analysis, key,
    };
    this.catalog.put(photo);
    return photo;
  }

  private async thumbsExist(key: string): Promise<boolean> {
    try {
      await Promise.all((['s', 'm'] as const).map((s) => stat(this.catalog.thumbPath(key, s))));
      return true;
    } catch {
      return false;
    }
  }
}
