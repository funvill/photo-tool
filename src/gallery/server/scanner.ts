import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import type { PhotoAnalysis } from '../../core';
import { analyze as defaultAnalyze, fileStat, hashFile, orientedSize, readMetadata, THUMB_SIZES, workingFile, writeJpegThumb, type ThumbSize } from '../../server/media';
import { photoKey, type Catalog, type GalleryPhoto } from './catalog';
import { GalleryFolderError, listPhotos, type ReadDir } from './walk';

// Background folder scan for the gallery: walks a folder, and for each photo either reuses the
// catalog row (same path, size and mtime) or runs the editor's image pipeline once.

export { GalleryFolderError };

export interface ScanJob {
  id: string;
  root: string;
  recursive: boolean;
  total: number;
  processed: number;
  startedAt: number;
  done: boolean;
  /** Stopped before the end (another folder was opened, or `cancel`); `done` once the photos in hand are finished. */
  cancelled: boolean;
  errors: { path: string; message: string }[];
  /** In completion order, only ever appended to. */
  photos: GalleryPhoto[];
}

interface ScannerOptions {
  concurrency?: number;
  analyze?: (workPath: string) => Promise<PhotoAnalysis>;
  /** How folders are listed. A seam for tests (a subfolder that can't be read). */
  readdir?: ReadDir;
}

/** The photo's subfolder of `root`, with '/' between names ('' when it is in `root` itself). */
const relDirOf = (root: string, path: string) => relative(root, dirname(path)).split(/[\\/]/).filter(Boolean).join('/');

export class Scanner {
  private jobs = new Map<string, ScanJob>();
  /** Scans not done yet, forgotten ones included: opening a folder cancels them all. */
  private running = new Set<ScanJob>();
  /** Photos being read now, by path: a second scan waits for that result instead of reading the photo again. */
  private inFlight = new Map<string, Promise<GalleryPhoto>>();
  private concurrency: number;
  private analyze: (workPath: string) => Promise<PhotoAnalysis>;
  private readdir?: ReadDir;

  constructor(private catalog: Catalog, private dataDir: string, opts: ScannerOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.analyze = opts.analyze ?? defaultAnalyze;
    this.readdir = opts.readdir;
  }

  /** Starts a scan and returns at once; poll `get` for progress. Any earlier scan still running is cancelled. */
  open(root: string, recursive: boolean): ScanJob {
    const folder = resolve(root);
    let isDir = false;
    try {
      isDir = statSync(folder).isDirectory();
    } catch {
      // not there or not readable: reported below
    }
    if (!isDir) throw new GalleryFolderError(`Not a readable folder: ${root}`);
    for (const earlier of this.running) earlier.cancelled = true;
    const job: ScanJob = { id: randomUUID(), root: folder, recursive, total: 0, processed: 0, startedAt: Date.now(), done: false, cancelled: false, errors: [], photos: [] };
    this.jobs.set(job.id, job);
    this.running.add(job);
    this.catalog.touchRecent(folder, recursive);
    void this.run(job);
    return job;
  }

  get(id: string): ScanJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Stops a running scan: each worker finishes the photo in hand and takes no other. The job keeps the
   * photos read so far and ends `done` and `cancelled`. A finished (or unknown) scan is left as it is.
   */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job && !job.done) job.cancelled = true;
  }

  /** Drops a job's result from memory. A scan still running carries on until cancelled; it just can't be polled any more. */
  forget(id: string): void {
    this.jobs.delete(id);
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
      const { files, errors } = await listPhotos(job.root, job.recursive, this.readdir);
      job.errors.push(...errors);
      job.total = files.length;
      let next = 0;
      const worker = async () => {
        while (next < files.length && !job.cancelled) {
          const file = files[next++];
          try {
            job.photos.push(await this.readPhoto(job, file));
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
    this.running.delete(job);
    job.done = true;
  }

  /** One photo for this scan, read once even when another scan is reading the same file right now. */
  private async readPhoto(job: ScanJob, path: string): Promise<GalleryPhoto> {
    const other = this.inFlight.get(path);
    if (other) return this.forJob(job, await other);
    const work = this.scanOne(job, path);
    this.inFlight.set(path, work);
    try {
      return await work;
    } finally {
      if (this.inFlight.get(path) === work) this.inFlight.delete(path);
    }
  }

  /** A photo read for another scan, as this scan's (its own root and subfolder). */
  private forJob(job: ScanJob, read: GalleryPhoto): GalleryPhoto {
    const photo = { ...read, folder: job.root, relDir: relDirOf(job.root, read.path) };
    if (photo.folder !== read.folder || photo.relDir !== read.relDir) this.catalog.put(photo);
    return photo;
  }

  private async scanOne(job: ScanJob, path: string): Promise<GalleryPhoto> {
    const st = await fileStat(path);
    const relDir = relDirOf(job.root, path);
    const hit = this.catalog.lookup(path, st.size, st.mtimeMs);
    // A cached row is reused as long as its thumbnails are still on disk.
    if (hit && (await this.thumbsExist(hit.key))) {
      const photo = { ...hit, folder: job.root, relDir };
      // A row cached before exif was read: read just that, leaving thumbnails and analysis alone. A file
      // that can't be read just now keeps its row as it was (exif still missing: tried again next time).
      let upgraded = false;
      if (!photo.exif) {
        const meta = await readMetadata(path);
        if (meta.read) {
          photo.exif = meta.exif;
          photo.camera = meta.camera;
          upgraded = true;
        }
      }
      if (upgraded || photo.folder !== hit.folder || photo.relDir !== hit.relDir) this.catalog.put(photo);
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
      gpsLon: meta.gpsLon, camera: meta.camera, exif: meta.exif, analysis, key,
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
