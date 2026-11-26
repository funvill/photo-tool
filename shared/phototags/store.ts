// Keeping an album folder's phototool-tags.json (and its vectors file) up to date: results are collected in memory
// and written together (debounced), each file atomically (temp file, then rename). A read-only folder's files go to
// <fallbackDir>/phototool-tags/ instead, beside the photoinfo fallback files. A file that can't be read is never
// overwritten. Nothing here throws at a timer: a write that fails is reported and tried again with the next one.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  PHOTOTAGS_FORMAT,
  PHOTOTAGS_NAME,
  PHOTOVECTORS_FORMAT,
  PHOTOVECTORS_NAME,
  encodeVector,
  findName,
  isPlainObject,
  modelsOf,
  parsePhotoTags,
  parsePhotoVectors,
  resultsOf,
  serialisePhotoTags,
  serialisePhotoVectors,
  vectorsOf,
  type StoredResult,
  type StoredVector,
  type TagResult,
} from './format';

export interface AlbumTagsOptions {
  /** The shared fallback folder of read-only photo folders (the photoinfo one); these files go in its `phototool-tags` subfolder. */
  fallbackDir: string;
  /** Write once results have stopped coming for this long. Default 5 s. */
  debounceMs?: number;
  /** ...or at the latest this long after the first result not yet written. Default 60 s. */
  maxWaitMs?: number;
  /** Replaces the default write (temp file + rename). A seam for tests (a read-only folder). */
  writeFile?: (target: string, text: string) => void;
  /** Replaces `renameSync` in the default write. A seam for tests. */
  rename?: (from: string, to: string) => void;
  /** A write that failed (it is tried again with the next one). Default: a console warning, once per message. */
  onError?: (folder: string, message: string) => void;
}

/** A result to keep: the readable part, and for a keywords model its embedding (kept in the vectors file). */
export interface NewTagResult {
  contentKey: string;
  description?: string | null;
  objects?: { label: string; count: number }[];
  keywords?: { label: string; score: number }[];
  embedding?: Float32Array | null;
  madeAt?: string;
}

export interface AlbumResult extends StoredResult {
  /** From the vectors file (or not yet written), only when it was made from the same picture. */
  embedding?: Float32Array;
}

export interface AlbumTagsView {
  results: AlbumResult[];
  source: 'folder' | 'fallback' | 'none';
  /** Why the folder's tags file could not be read (it is left alone). */
  error?: string;
}

type Kind = 'tags' | 'vectors';
const NAMES: Record<Kind, string> = { tags: PHOTOTAGS_NAME, vectors: PHOTOVECTORS_NAME };

const FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
/** The folder is not there (deleted, or a drive that is not connected): its results are dropped, never written elsewhere. */
const GONE_CODES = new Set(['ENOENT', 'ENOTDIR']);
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_MS = [50, 100, 150, 200];

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

class FolderGone extends Error {}
class WriteFailed extends Error {}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* nothing there */
  }
}

/** Temp file beside the target, renamed over it (a busy target is retried for about half a second). */
function atomicWrite(target: string, text: string, rename: (from: string, to: string) => void = renameSync): void {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
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
      // The folder is writable (the temp file was written): never sent to the fallback.
      throw new WriteFailed(code && BUSY_CODES.has(code) ? `${target} is in use by another program` : `Could not write ${target}: ${(e as Error).message}`);
    }
  }
}

const folderKey = (folder: string): string => {
  const full = resolve(folder);
  return process.platform === 'win32' ? full.toLowerCase() : full;
};

const itemKey = (fileName: string, modelId: string) => `${fileName.toLowerCase()}\0${modelId}`;

function stampOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}-${st.size}`;
  } catch {
    return '-';
  }
}

interface Pending {
  folder: string;
  items: Map<string, { fileName: string; modelId: string; result: NewTagResult }>;
  timer: ReturnType<typeof setTimeout> | null;
  firstAt: number;
}

interface Parsed {
  stamp: string;
  results: StoredResult[];
  vectors: StoredVector[];
  source: AlbumTagsView['source'];
  error?: string;
}

type Loaded<T> = { kind: 'ok'; source: 'folder' | 'fallback'; file: T } | { kind: 'none' } | { kind: 'broken'; path: string; error: string };

export class AlbumTagsStore {
  private pending = new Map<string, Pending>();
  private cache = new Map<string, Parsed>();
  private reported = new Set<string>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(private opts: AlbumTagsOptions) {
    this.debounceMs = opts.debounceMs ?? 5000;
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
  }

  /** The folder's results as written, with the ones not written yet on top. */
  read(folder: string): AlbumTagsView {
    const parsed = this.parsed(folder);
    const byKey = new Map<string, AlbumResult>();
    for (const r of parsed.results) byKey.set(itemKey(r.fileName, r.modelId), { ...r });
    for (const v of parsed.vectors) {
      const r = byKey.get(itemKey(v.fileName, v.modelId));
      if (r && r.contentKey === v.contentKey) r.embedding = v.embedding;
    }
    for (const [k, { fileName, modelId, result }] of this.pending.get(folderKey(folder))?.items ?? []) {
      const old = byKey.get(k);
      const embedding = result.embedding ?? (old && old.contentKey === result.contentKey ? old.embedding : undefined);
      byKey.set(k, { ...toStored(result), fileName: old?.fileName ?? fileName, modelId, ...(embedding ? { embedding } : {}) });
    }
    return { results: [...byKey.values()], source: parsed.source, ...(parsed.error ? { error: parsed.error } : {}) };
  }

  /** Keeps a result for a photo of the folder; written with the others a little later. */
  put(folder: string, fileName: string, modelId: string, result: NewTagResult): void {
    const key = folderKey(folder);
    let p = this.pending.get(key);
    if (!p) this.pending.set(key, (p = { folder: resolve(folder), items: new Map(), timer: null, firstAt: Date.now() }));
    if (!p.items.size && !p.timer) p.firstAt = Date.now();
    p.items.set(itemKey(fileName, modelId), { fileName, modelId, result: { ...result, madeAt: result.madeAt ?? new Date().toISOString() } });
    this.schedule(key, p);
  }

  /** True while results for the folder (or any folder) are not written yet. */
  hasPending(folder?: string): boolean {
    return folder === undefined ? this.pending.size > 0 : this.pending.has(folderKey(folder));
  }

  /** Writes now what is waiting (for one folder, or every one). Never throws. */
  flush(folder?: string): void {
    const keys = folder === undefined ? [...this.pending.keys()] : [folderKey(folder)];
    for (const k of keys) this.flushFolder(k);
  }

  /** Writes what is waiting and stops the timers. */
  close(): void {
    this.flush();
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
  }

  private schedule(key: string, p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    const delay = Math.max(0, Math.min(this.debounceMs, p.firstAt + this.maxWaitMs - Date.now()));
    p.timer = setTimeout(() => this.flushFolder(key), delay);
    // A timer never keeps the process alive; close() writes what is left.
    (p.timer as { unref?: () => void }).unref?.();
  }

  private report(folder: string, message: string): void {
    if (this.opts.onError) return this.opts.onError(folder, message);
    if (this.reported.has(message)) return;
    this.reported.add(message);
    console.warn(`Photo Tool could not save tags for ${folder}: ${message}`);
  }

  private flushFolder(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    const items = [...p.items.values()];
    try {
      this.writeKind('tags', p.folder, items);
      const withVectors = items.filter((i) => i.result.embedding?.length);
      if (withVectors.length) this.writeKind('vectors', p.folder, withVectors);
      // Results that came in during the write stay (none can: it is synchronous), the written ones go.
      for (const i of items) if (p.items.get(itemKey(i.fileName, i.modelId)) === i) p.items.delete(itemKey(i.fileName, i.modelId));
    } catch (e) {
      if (e instanceof FolderGone) {
        p.items.clear();
      } else {
        // Kept: written with the next result, or the next flush.
        this.report(p.folder, e instanceof Error ? e.message : String(e));
      }
    }
    if (!p.items.size) this.pending.delete(key);
    this.cache.delete(key);
  }

  private fallbackFile(folder: string, kind: Kind): string {
    const hash = createHash('sha1').update(folderKey(folder)).digest('hex');
    return join(this.opts.fallbackDir, 'phototool-tags', `${hash}${kind === 'tags' ? '' : '.vectors'}.json`);
  }

  private folderFile(folder: string, kind: Kind): string {
    return join(folder, NAMES[kind]);
  }

  private loadFrom<T>(path: string, source: 'folder' | 'fallback', parse: (t: string) => T): Loaded<T> | undefined {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if (GONE_CODES.has(codeOf(e) ?? '')) return undefined;
      return { kind: 'broken', path, error: `Could not read ${path}: ${(e as Error).message}` };
    }
    try {
      return { kind: 'ok', source, file: parse(text) };
    } catch (e) {
      return { kind: 'broken', path, error: `${path}: ${(e as Error).message}` };
    }
  }

  /** The fallback file wins when there is one: it is only written from a load that included the folder's own file. */
  private load<T>(folder: string, kind: Kind, parse: (t: string) => T): Loaded<T> {
    return this.loadFrom(this.fallbackFile(folder, kind), 'fallback', parse) ?? this.loadFrom(this.folderFile(folder, kind), 'folder', parse) ?? { kind: 'none' };
  }

  private stamp(folder: string): string {
    return (['tags', 'vectors'] as Kind[]).map((k) => `${stampOf(this.fallbackFile(folder, k))}|${stampOf(this.folderFile(folder, k))}`).join('|');
  }

  private parsed(folder: string): Parsed {
    const key = folderKey(folder);
    const stamp = this.stamp(folder);
    const hit = this.cache.get(key);
    if (hit && hit.stamp === stamp) return hit;
    const tags = this.load(folder, 'tags', parsePhotoTags);
    const vectors = this.load(folder, 'vectors', parsePhotoVectors);
    const out: Parsed = {
      stamp,
      results: tags.kind === 'ok' ? resultsOf(tags.file) : [],
      vectors: vectors.kind === 'ok' ? vectorsOf(vectors.file) : [],
      source: tags.kind === 'ok' ? tags.source : 'none',
      ...(tags.kind === 'broken' ? { error: tags.error } : {}),
    };
    this.cache.set(key, out);
    return out;
  }

  /** Applies the items to the file's current content (re-read, so another program's changes are kept) and writes it. */
  private writeKind(kind: Kind, folder: string, items: Pending['items'] extends Map<string, infer V> ? V[] : never): void {
    const parse = kind === 'tags' ? parsePhotoTags : parsePhotoVectors;
    const loaded = this.load<{ format: string; photos: Record<string, unknown>; [k: string]: unknown }>(folder, kind, parse);
    if (loaded.kind === 'broken') throw new WriteFailed(`${loaded.path} can't be read, so it was left alone. Fix or delete it. (${loaded.error})`);
    const file = loaded.kind === 'ok' ? loaded.file : { format: kind === 'tags' ? PHOTOTAGS_FORMAT : PHOTOVECTORS_FORMAT, photos: {} };
    for (const { fileName, modelId, result } of items) {
      const name = findName(file.photos, fileName) ?? fileName;
      const old = file.photos[name];
      const entry: Record<string, unknown> = isPlainObject(old) ? { ...old } : {};
      const models: Record<string, unknown> = { ...(modelsOf(old) ?? {}) };
      const was = models[modelId];
      // Unknown fields of a result stay while it is about the same picture.
      const same = isPlainObject(was) && was.contentKey === result.contentKey ? { ...was } : {};
      models[modelId] = kind === 'tags' ? { ...withoutKnown(same), ...toStored(result) } : { ...same, contentKey: result.contentKey, data: encodeVector(result.embedding!) };
      entry.models = models;
      file.photos[name] = entry;
    }
    const text = kind === 'tags' ? serialisePhotoTags(file) : serialisePhotoVectors(file);
    this.writeFile(folder, kind, text, file);
  }

  private writeFile(folder: string, kind: Kind, text: string, file: Record<string, unknown>): void {
    const write = this.opts.writeFile ?? ((target: string, t: string) => atomicWrite(target, t, this.opts.rename));
    try {
      write(this.folderFile(folder, kind), text);
      // The folder is writable again: back to its own file.
      removeQuietly(this.fallbackFile(folder, kind));
      return;
    } catch (e) {
      if (e instanceof WriteFailed) throw e;
      const code = codeOf(e) ?? '';
      if (GONE_CODES.has(code)) throw new FolderGone();
      if (!FALLBACK_CODES.has(code)) throw new WriteFailed(`Could not write ${this.folderFile(folder, kind)}: ${(e as Error).message}`);
    }
    try {
      mkdirSync(dirname(this.fallbackFile(folder, kind)), { recursive: true });
      const withFolder = { ...file, folder: resolve(folder) };
      write(this.fallbackFile(folder, kind), kind === 'tags' ? serialisePhotoTags(withFolder as never) : serialisePhotoVectors(withFolder as never));
    } catch (e) {
      throw new WriteFailed(`${folder} is read-only, and the fallback file could not be written either: ${(e as Error).message}`);
    }
  }
}

const KNOWN = ['contentKey', 'description', 'objects', 'keywords', 'madeAt'];

function withoutKnown(r: Record<string, unknown>): Record<string, unknown> {
  const out = { ...r };
  for (const k of KNOWN) delete out[k];
  return out;
}

/** The readable part of a result, as stored. */
function toStored(r: NewTagResult): TagResult {
  return {
    contentKey: r.contentKey,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(Array.isArray(r.objects) && r.objects.length ? { objects: r.objects } : {}),
    ...(Array.isArray(r.keywords) && r.keywords.length ? { keywords: r.keywords } : {}),
    ...(r.madeAt ? { madeAt: r.madeAt } : {}),
  };
}
