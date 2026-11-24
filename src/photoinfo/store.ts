// Reading and writing a folder's photoinfo.json (or its fallback copy when the folder is read-only).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PHOTOINFO_FORMAT, PHOTOINFO_NAME, parsePhotoInfo, serialisePhotoInfo, type PhotoInfo, type PhotoInfoFile } from './format';

export class PhotoInfoWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoInfoWriteError';
  }
}

export interface PhotoInfoOptions {
  /** Where per-folder fallback files live when a folder cannot be written. */
  fallbackDir: string;
  /**
   * Replaces the default write (temp file + rename). Receives the full target path and the text to store.
   * A seam for tests, so a read-only folder can be simulated on any platform.
   */
  writeFile?: (target: string, text: string) => void;
  /** Replaces `renameSync` in the default write. A seam for tests, so a busy (locked) file can be simulated. */
  rename?: (from: string, to: string) => void;
}

export interface FolderInfo {
  photos: Record<string, PhotoInfo>;
  source: 'folder' | 'fallback' | 'none';
  error?: string;
  /** Changes whenever the backing file changes (mtime + size), or 'none'. */
  stamp: string;
}

const FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

function folderFile(folder: string): string {
  return join(folder, PHOTOINFO_NAME);
}

function normalisedFolder(folder: string): string {
  const full = resolve(folder);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function fallbackFile(folder: string, opts: PhotoInfoOptions): string {
  return join(opts.fallbackDir, createHash('sha1').update(normalisedFolder(folder)).digest('hex') + '.json');
}

function stampOf(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}-${st.size}`;
  } catch {
    return undefined;
  }
}

type Loaded =
  | { kind: 'ok'; source: 'folder' | 'fallback'; path: string; file: PhotoInfoFile }
  | { kind: 'none' }
  | { kind: 'broken'; source: 'folder' | 'fallback'; path: string; error: string };

function loadFrom(path: string, source: 'folder' | 'fallback'): Loaded | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR') return undefined;
    return { kind: 'broken', source, path, error: `Could not read ${path}: ${(e as Error).message}` };
  }
  try {
    return { kind: 'ok', source, path, file: parsePhotoInfo(text) };
  } catch (e) {
    return { kind: 'broken', source, path, error: `${path}: ${(e as Error).message}` };
  }
}

/**
 * A fallback file wins when it exists: it is only ever written from a load that already included the folder's own
 * file, so it holds the full merged content. A successful folder write deletes it again.
 */
function load(folder: string, opts: PhotoInfoOptions): Loaded {
  return loadFrom(fallbackFile(folder, opts), 'fallback') ?? loadFrom(folderFile(folder), 'folder') ?? { kind: 'none' };
}

export function readFolderInfo(folder: string, opts: PhotoInfoOptions): FolderInfo {
  try {
    const stamp = folderStamp(folder, opts);
    const loaded = load(folder, opts);
    if (loaded.kind === 'none') return { photos: {}, source: 'none', stamp: 'none' };
    if (loaded.kind === 'broken') return { photos: {}, source: loaded.source, error: loaded.error, stamp };
    return { photos: loaded.file.photos, source: loaded.source, stamp };
  } catch (e) {
    return { photos: {}, source: 'none', error: (e as Error).message, stamp: 'none' };
  }
}

/** Exact key first, then case-insensitive. */
function findKey(photos: Record<string, PhotoInfo>, fileName: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(photos, fileName)) return fileName;
  const lower = fileName.toLowerCase();
  return Object.keys(photos).find((k) => k.toLowerCase() === lower);
}

export function infoFor(info: FolderInfo, fileName: string): PhotoInfo | undefined {
  const key = findKey(info.photos, fileName);
  return key === undefined ? undefined : info.photos[key];
}

/** Codes a rename gets on Windows while another program (OneDrive, Dropbox, antivirus) holds the target open. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Waits between rename attempts: about half a second in all. */
const RENAME_RETRY_MS = [50, 100, 150, 200];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Writes a temp file beside the target, then renames it over the target. A failure to write the temp file is
 * thrown as is (its code tells a read-only folder apart); a rename refused because the target is busy is retried,
 * then reported as a PhotoInfoWriteError — the folder is writable, so it must not send the change to the fallback.
 */
function atomicWrite(target: string, text: string, rename: (from: string, to: string) => void = renameSync): void {
  const tmp = join(dirname(target), `.${PHOTOINFO_NAME}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, target);
      return;
    } catch (e) {
      const code = codeOf(e);
      if (code && BUSY_CODES.has(code) && attempt < RENAME_RETRY_MS.length) {
        sleepSync(RENAME_RETRY_MS[attempt]);
        continue;
      }
      removeQuietly(tmp);
      if (code && BUSY_CODES.has(code)) {
        throw new PhotoInfoWriteError(`${basename(target)} in ${dirname(target)} is in use by another program; try again.`);
      }
      throw new PhotoInfoWriteError(`Could not write ${target}: ${(e as Error).message}`);
    }
  }
}

export function updatePhotoInfo(
  folder: string,
  fileName: string,
  patch: Partial<Record<keyof PhotoInfo, unknown>>,
  opts: PhotoInfoOptions,
): PhotoInfo {
  // Re-read every time so a concurrent writer's changes are kept; only the patched entry changes.
  const loaded = load(folder, opts);
  if (loaded.kind === 'broken') throw new PhotoInfoWriteError(`Refusing to overwrite an unreadable photo info file: ${loaded.error}`);
  const file: PhotoInfoFile = loaded.kind === 'ok' ? loaded.file : { format: PHOTOINFO_FORMAT, photos: {} };

  const key = findKey(file.photos, fileName) ?? fileName;
  const entry: PhotoInfo = { ...(file.photos[key] ?? {}) };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete entry[field];
    else entry[field] = value;
  }
  if (Object.keys(entry).length === 0) delete file.photos[key];
  else file.photos[key] = entry;

  const write = opts.writeFile ?? ((target: string, text: string) => atomicWrite(target, text, opts.rename));
  try {
    write(folderFile(folder), serialisePhotoInfo(file));
    // The folder is writable again: go back to its own file.
    try {
      unlinkSync(fallbackFile(folder, opts));
    } catch {
      /* no fallback file */
    }
  } catch (e) {
    if (e instanceof PhotoInfoWriteError) throw e;
    const code = codeOf(e);
    if (!code || !FALLBACK_CODES.has(code)) throw new PhotoInfoWriteError(`Could not write ${folderFile(folder)}: ${(e as Error).message}`);
    try {
      mkdirSync(opts.fallbackDir, { recursive: true });
      write(fallbackFile(folder, opts), serialisePhotoInfo({ ...file, folder: resolve(folder) }));
    } catch (e2) {
      throw new PhotoInfoWriteError(`Could not write the fallback file either: ${(e2 as Error).message}`);
    }
  }
  return entry;
}

/**
 * Cheap change detector: stat only. Combines the fallback file and the folder's own file, so a change to either
 * (a star written to the fallback while the folder also has its own file, say) changes the stamp.
 */
export function folderStamp(folder: string, opts: PhotoInfoOptions): string {
  const fallback = stampOf(fallbackFile(folder, opts));
  const own = stampOf(folderFile(folder));
  return fallback === undefined && own === undefined ? 'none' : `fallback:${fallback ?? '-'}|folder:${own ?? '-'}`;
}
