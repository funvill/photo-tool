// Keeping an album folder's phototool-tags.json (and its vectors file) up to date.
//
// Writing: results wait in memory and go out together, each file on its own and atomically (temp file, fsync, rename):
// a minute after the last result, at the latest five minutes after the first one waiting (models take 6-20 s a photo,
// so a pass writes every five minutes), and whenever the caller flushes (a pass ended, the folder was closed, the
// program stops). A write that fails waits before it is tried again (30 s, doubling to 10 min); a file that can't be
// parsed is not tried again until it changes. A file that can't be read, or parsed, is never written over.
//
// New results never replace the folder's result for the same picture (by content key or file key): the folder wins.
// Only `put(..., 'replace')` (Regenerate) does.
//
// Read-only folders: the files go to <fallbackDir>/phototool-tags/ instead. Reads, and the first write once the folder
// is writable again, merge the folder's file and the fallback entry by entry (the folder's wins unless the fallback's is
// newer), so nothing another device wrote to the folder meanwhile is lost; the fallback is then removed. The fallback
// records the folder's path; the album's own file never carries a local path.
//
// Nothing here throws at a timer.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  PHOTOTAGS_FORMAT,
  PHOTOTAGS_NAME,
  PHOTOVECTORS_FORMAT,
  PHOTOVECTORS_NAME,
  decodeVector,
  encodeVector,
  findName,
  isPlainObject,
  modelsOf,
  parsePhotoTags,
  parsePhotoVectors,
  resultsOf,
  serialisePhotoTags,
  serialisePhotoVectors,
  type StoredResult,
  type TagResult,
} from './format';
import { fileKeySize } from './fileKey';

export interface AlbumTagsOptions {
  /** The shared fallback folder of read-only photo folders (the photoinfo one); these files go in its `phototool-tags` subfolder. */
  fallbackDir: string;
  /** Write once results have stopped coming for this long. Default 60 s. */
  debounceMs?: number;
  /** ...or at the latest this long after the first result waiting. Default 5 min. */
  maxWaitMs?: number;
  /** The first wait after a failed write; it doubles up to `maxRetryMs`. Default 30 s and 10 min. */
  retryMs?: number;
  maxRetryMs?: number;
  /** How long a file that could not be read (locked, offline) is taken as unreadable before it is read again. Default 10 s. */
  unreadableRetryMs?: number;
  /** Replaces the default write (temp file + rename). A seam for tests (a read-only folder). */
  writeFile?: (target: string, text: string) => void;
  /** Replaces `renameSync` in the default write. A seam for tests (a busy file). */
  rename?: (from: string, to: string) => void;
  /** Replaces `readFileSync(path, 'utf8')`. A seam for tests (a locked or offline file). */
  readFile?: (path: string) => string;
  /** A write that failed (it is tried again later). Default: a console warning, once per message. */
  onError?: (folder: string, message: string) => void;
}

/** A result to keep: the readable part, and for a keywords model its embedding (kept in the vectors file). */
export interface NewTagResult {
  contentKey: string;
  fileKey?: string;
  description?: string | null;
  objects?: { label: string; count: number }[];
  keywords?: { label: string; score: number }[];
  embedding?: Float32Array | null;
  madeAt?: string;
}

/** 'keep': the folder's result for the same picture stays (tagging, migration). 'replace': this one wins (Regenerate). */
export type PutMode = 'keep' | 'replace';

export interface AlbumResult extends StoredResult {
  /** From the vectors file (or not written yet), only when it was made from the same picture. */
  embedding?: Float32Array;
}

export interface AlbumTagsView {
  results: AlbumResult[];
  source: 'folder' | 'fallback' | 'none';
  /** Why the folder's tags file could not be used (it is left alone). */
  error?: string;
}

export interface PhotoRef {
  fileName: string;
  contentKey: string | null;
  /** The photo file's size: entries whose file key is for another size are ruled out without reading the file. */
  size?: number;
  /** Worked out only when the content key finds nothing and an entry of this size could match (it reads the photo file). */
  fileKey?: () => string | undefined;
}

/** One folder's results, indexed for lookups by photo. */
export interface FolderView {
  /** unreadable: a file could not be read just now (locked, offline); try again later, and don't tag its photos yet. */
  status: 'ok' | 'none' | 'broken' | 'unreadable';
  error?: string;
  /** Every model id with a result in the folder. */
  modelIds: ReadonlySet<string>;
  /** The photo's result from this model: under its name for this picture, else under any name for this picture. */
  find(modelId: string, photo: PhotoRef): AlbumResult | undefined;
}

type Kind = 'tags' | 'vectors';
const KINDS: Kind[] = ['tags', 'vectors'];
const NAMES: Record<Kind, string> = { tags: PHOTOTAGS_NAME, vectors: PHOTOVECTORS_NAME };
const FORMATS: Record<Kind, string> = { tags: PHOTOTAGS_FORMAT, vectors: PHOTOVECTORS_FORMAT };

const FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
/** The folder is not there (deleted, or a drive that is not connected): its results are dropped, never written elsewhere. */
const GONE_CODES = new Set(['ENOENT', 'ENOTDIR']);
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Short: a busy file is tried again later anyway (with a backoff), so the server is never held up for long. */
const RENAME_RETRY_MS = [50, 150];
/** Our temp files: `~$` and `.tmp` are names OneDrive and Dropbox skip, and most sync engines leave alone. */
const TEMP_PREFIX = '~$';
const isOurTemp = (n: string) => /^(~\$|\.)phototool-tags(\.vectors)?\.json\.[0-9a-f.]+\.tmp$/i.test(n);

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

class FolderGone extends Error {}
class WriteFailed extends Error {}
/** The file can't be parsed: not tried again until it changes. */
class Blocked extends WriteFailed {}

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

/** Temp file beside the target (written and flushed to disk), renamed over it; a busy target is retried briefly. */
function atomicWrite(target: string, text: string, rename: (from: string, to: string) => void = renameSync): void {
  const tmp = join(dirname(target), `${TEMP_PREFIX}${basename(target)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, text, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
      throw new WriteFailed(code && BUSY_CODES.has(code) ? `${target} is in use by another program, or marked read-only` : `Could not write ${target}: ${(e as Error).message}`);
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

const time = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);

/** The fallback's result replaces the folder's only when both have a time and the fallback's is later. */
const fallbackIsNewer = (fb: unknown, own: unknown): boolean => {
  const a = isPlainObject(fb) ? time(fb.madeAt) : NaN;
  const b = isPlainObject(own) ? time(own.madeAt) : NaN;
  return a > b;
};

/** Results about the same picture: the same content key (this computer) or the same file key (any computer). */
const samePicture = (was: unknown, r: { contentKey: string; fileKey?: string }): boolean =>
  isPlainObject(was) && (was.contentKey === r.contentKey || (!!r.fileKey && was.fileKey === r.fileKey));

type RawFile = { format: string; photos: Record<string, unknown>; [k: string]: unknown };

/** Both copies of a folder's file merged entry by entry (see the top of this file). Neither input is changed. */
function mergeFiles(own: RawFile | undefined, fb: RawFile | undefined, kind: Kind): RawFile {
  if (!fb) return own ? { ...own, photos: { ...own.photos } } : { format: FORMATS[kind], photos: {} };
  const { folder: _path, ...fbTop } = fb;
  const out: RawFile = { ...fbTop, ...(own ?? {}), format: FORMATS[kind], photos: { ...(own?.photos ?? {}) } };
  for (const [fbName, fbEntry] of Object.entries(fb.photos)) {
    const fbModels = modelsOf(fbEntry);
    const name = findName(out.photos, fbName);
    if (name === undefined) {
      out.photos[fbName] = fbEntry;
      continue;
    }
    const ownEntry = out.photos[name];
    const ownModels = modelsOf(ownEntry);
    // An entry one side can't read is kept as the folder has it.
    if (!fbModels || !ownModels) continue;
    const models = { ...ownModels };
    for (const [id, r] of Object.entries(fbModels)) if (!(id in models) || fallbackIsNewer(r, models[id])) models[id] = r;
    out.photos[name] = { ...(isPlainObject(fbEntry) ? fbEntry : {}), ...(ownEntry as object), models };
  }
  return out;
}

interface Item {
  fileName: string;
  modelId: string;
  result: NewTagResult;
  mode: PutMode;
}

/** What one of a folder's two files is waiting for. */
interface KindState {
  items: Map<string, Item>;
  timer: ReturnType<typeof setTimeout> | null;
  firstAt: number;
  failures: number;
  retryAt: number;
  /** Set while the file can't be parsed: its stamps then (it is tried again once they change). */
  blockedStamp?: string;
}

interface Pending {
  folder: string;
  kinds: Record<Kind, KindState>;
}

type Loaded = { kind: 'ok'; file: RawFile } | { kind: 'none' } | { kind: 'broken'; path: string; error: string } | { kind: 'unreadable'; path: string; error: string };

interface Index {
  stamp: string;
  checkedAt: number;
  /** For an unreadable folder: when to read it again. */
  retryAt: number;
  status: FolderView['status'];
  error?: string;
  source: AlbumTagsView['source'];
  results: AlbumResult[];
  byName: Map<string, AlbumResult>;
  byContent: Map<string, AlbumResult[]>;
  byFile: Map<string, AlbumResult[]>;
  /** Per model, the file sizes its file keys are for ('?' when a key does not say). */
  fileSizes: Map<string, Set<number | '?'>>;
  modelIds: Set<string>;
}

/** How often a folder's files are looked at (stat) for changes made by someone else, during a burst of lookups. */
const RECHECK_MS = 1000;

export class AlbumTagsStore {
  private pending = new Map<string, Pending>();
  private indexes = new Map<string, Index>();
  private reported = new Set<string>();
  private cleaned = new Set<string>();
  private closed = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly unreadableRetryMs: number;
  /** For tests: how many times a folder's index was built. */
  readonly stats = { indexBuilds: 0 };

  constructor(private opts: AlbumTagsOptions) {
    this.debounceMs = opts.debounceMs ?? 60_000;
    this.maxWaitMs = opts.maxWaitMs ?? 300_000;
    this.retryMs = opts.retryMs ?? 30_000;
    this.maxRetryMs = opts.maxRetryMs ?? 600_000;
    this.unreadableRetryMs = opts.unreadableRetryMs ?? 10_000;
  }

  /** The folder's results, indexed; built once per change of its files. */
  lookup(folder: string): FolderView {
    const idx = this.index(folder, false);
    const pending = this.pending.get(folderKey(folder))?.kinds;
    return {
      status: idx.status,
      ...(idx.error ? { error: idx.error } : {}),
      modelIds: idx.modelIds,
      find: (modelId, photo) => {
        if (idx.status === 'unreadable') return undefined;
        const k = itemKey(photo.fileName, modelId);
        // Not written yet: newest of all (only ever this computer's, so by content key).
        const waiting = pending?.tags.items.get(k);
        if (waiting && waiting.result.contentKey === photo.contentKey) {
          const old = idx.byName.get(k);
          const vector = pending?.vectors.items.get(k)?.result.embedding ?? (old && old.contentKey === photo.contentKey ? old.embedding : undefined);
          return { ...toStored(waiting.result), fileName: old?.fileName ?? photo.fileName, modelId, ...(vector ? { embedding: vector } : {}) };
        }
        const own = idx.byName.get(k);
        if (own && photo.contentKey && own.contentKey === photo.contentKey) return own;
        const renamed = photo.contentKey ? idx.byContent.get(`${photo.contentKey}\0${modelId}`)?.[0] : undefined;
        if (renamed) return renamed;
        // Made on another computer (its content key differs): the file's own fingerprint, read only when an entry of
        // this model could be for a file of this size.
        const sizes = idx.fileSizes.get(modelId);
        if (!sizes || !photo.fileKey) return undefined;
        if (photo.size !== undefined && !sizes.has(photo.size) && !sizes.has('?')) return undefined;
        const fk = photo.fileKey();
        if (!fk) return undefined;
        if (own?.fileKey === fk) return own;
        return idx.byFile.get(`${fk}\0${modelId}`)?.[0];
      },
    };
  }

  /** Every result of the folder, with the ones not written yet on top (for tests and tools; lookups use `lookup`). */
  read(folder: string): AlbumTagsView {
    const idx = this.index(folder, true);
    const byKey = new Map(idx.results.map((r) => [itemKey(r.fileName, r.modelId), { ...r }]));
    const kinds = this.pending.get(folderKey(folder))?.kinds;
    for (const [k, { fileName, modelId, result }] of kinds?.tags.items ?? []) {
      const old = byKey.get(k);
      const embedding = kinds?.vectors.items.get(k)?.result.embedding ?? (old && old.contentKey === result.contentKey ? old.embedding : undefined);
      byKey.set(k, { ...toStored(result), fileName: old?.fileName ?? fileName, modelId, ...(embedding ? { embedding } : {}) });
    }
    return { results: [...byKey.values()], source: idx.source, ...(idx.error ? { error: idx.error } : {}) };
  }

  /** Keeps a result for a photo of the folder; written with the others a little later. */
  put(folder: string, fileName: string, modelId: string, result: NewTagResult, mode: PutMode = 'keep'): void {
    const key = folderKey(folder);
    let p = this.pending.get(key);
    if (!p) {
      const state = (): KindState => ({ items: new Map(), timer: null, firstAt: 0, failures: 0, retryAt: 0 });
      this.pending.set(key, (p = { folder: resolve(folder), kinds: { tags: state(), vectors: state() } }));
    }
    const item: Item = { fileName, modelId, result: { ...result, madeAt: result.madeAt ?? new Date().toISOString() }, mode };
    const ik = itemKey(fileName, modelId);
    this.add(p.kinds.tags, ik, item);
    if (result.embedding?.length) this.add(p.kinds.vectors, ik, item);
    if (this.closed) return this.flushFolder(key, true);
    for (const kind of KINDS) if (p.kinds[kind].items.size) this.schedule(key, kind);
  }

  /** Forget every folder's index, so the next lookup reads the files again (a folder is being opened). */
  invalidate(): void {
    this.indexes.clear();
  }

  /** True while results for the folder (or any folder) are not written yet. */
  hasPending(folder?: string): boolean {
    const has = (p: Pending) => KINDS.some((k) => p.kinds[k].items.size > 0);
    if (folder === undefined) return [...this.pending.values()].some(has);
    const p = this.pending.get(folderKey(folder));
    return !!p && has(p);
  }

  /** Writes now what is waiting (for one folder, or every one), except files waiting out a failed write. Never throws. */
  flush(folder?: string): void {
    const keys = folder === undefined ? [...this.pending.keys()] : [folderKey(folder)];
    for (const k of keys) this.flushFolder(k, false);
  }

  /** Writes what is waiting (trying even files waiting out a failed write), and stops the timers. */
  close(): void {
    for (const k of [...this.pending.keys()]) this.flushFolder(k, true);
    for (const p of this.pending.values()) for (const kind of KINDS) if (p.kinds[kind].timer) clearTimeout(p.kinds[kind].timer!);
    this.closed = true;
  }

  private add(st: KindState, key: string, item: Item): void {
    if (!st.items.size) st.firstAt = Date.now();
    const was = st.items.get(key);
    // A Regenerate waiting is not undone by a later result for the same picture that would only keep.
    if (was?.mode === 'replace' && item.mode === 'keep' && samePicture(was.result, item.result)) return;
    st.items.set(key, item);
  }

  private schedule(key: string, kind: Kind): void {
    const st = this.pending.get(key)?.kinds[kind];
    if (!st || !st.items.size) return;
    if (st.timer) clearTimeout(st.timer);
    const now = Date.now();
    // After a failed write, what waits is late already: it goes as soon as the backoff allows.
    const due = st.failures ? st.retryAt : Math.min(now + this.debounceMs, st.firstAt + this.maxWaitMs);
    st.timer = setTimeout(() => this.flushKind(key, kind, false), Math.max(0, due - now));
    // A timer never keeps the process alive; close() writes what is left.
    (st.timer as { unref?: () => void }).unref?.();
  }

  private report(folder: string, message: string): void {
    if (this.opts.onError) return this.opts.onError(folder, message);
    if (this.reported.has(message)) return;
    this.reported.add(message);
    console.warn(`Photo Tool could not save tags for ${folder}: ${message}`);
  }

  private flushFolder(key: string, force: boolean): void {
    for (const kind of KINDS) this.flushKind(key, kind, force);
  }

  private flushKind(key: string, kind: Kind, force: boolean): void {
    const p = this.pending.get(key);
    const st = p?.kinds[kind];
    if (!p || !st || !st.items.size) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    const now = Date.now();
    if (!force) {
      if (st.blockedStamp !== undefined) {
        // A file that could not be parsed: tried again only once it has changed.
        if (this.kindStamp(p.folder, kind) === st.blockedStamp) return this.backoff(key, kind, st);
      } else if (st.retryAt > now) {
        return this.schedule(key, kind);
      }
    }
    const items = [...st.items.values()];
    try {
      this.writeKind(kind, p.folder, items);
      for (const i of items) {
        const k = itemKey(i.fileName, i.modelId);
        if (st.items.get(k) === i) st.items.delete(k);
      }
      st.failures = 0;
      st.retryAt = 0;
      st.blockedStamp = undefined;
    } catch (e) {
      if (e instanceof FolderGone) {
        st.items.clear();
      } else {
        st.blockedStamp = e instanceof Blocked ? this.kindStamp(p.folder, kind) : undefined;
        st.failures++;
        st.retryAt = now + Math.min(this.retryMs * 2 ** (st.failures - 1), this.maxRetryMs);
        this.report(p.folder, e instanceof Error ? e.message : String(e));
        this.schedule(key, kind);
      }
    }
    this.indexes.delete(key);
    if (!KINDS.some((k) => p.kinds[k].items.size)) this.pending.delete(key);
  }

  /** Still blocked: look again after a growing wait (cheap: a stat). */
  private backoff(key: string, kind: Kind, st: KindState): void {
    st.failures++;
    st.retryAt = Date.now() + Math.min(this.retryMs * 2 ** (st.failures - 1), this.maxRetryMs);
    this.schedule(key, kind);
  }

  private fallbackFile(folder: string, kind: Kind): string {
    const hash = createHash('sha1').update(folderKey(folder)).digest('hex');
    return join(this.opts.fallbackDir, 'phototool-tags', `${hash}${kind === 'tags' ? '' : '.vectors'}.json`);
  }

  private folderFile(folder: string, kind: Kind): string {
    return join(folder, NAMES[kind]);
  }

  private kindStamp(folder: string, kind: Kind): string {
    return `${stampOf(this.fallbackFile(folder, kind))}|${stampOf(this.folderFile(folder, kind))}`;
  }

  private loadFrom(path: string, kind: Kind): Loaded {
    let text: string;
    try {
      text = this.opts.readFile ? this.opts.readFile(path) : readFileSync(path, 'utf8');
    } catch (e) {
      if (GONE_CODES.has(codeOf(e) ?? '')) return { kind: 'none' };
      // Locked by a sync engine, or a cloud file that can't be fetched offline: not "no file", and never written over.
      return { kind: 'unreadable', path, error: `Could not read ${path}: ${(e as Error).message}` };
    }
    try {
      return { kind: 'ok', file: (kind === 'tags' ? parsePhotoTags(text) : parsePhotoVectors(text)) as RawFile };
    } catch (e) {
      return { kind: 'broken', path, error: `${path}: ${(e as Error).message}` };
    }
  }

  /** The folder's file and its fallback merged, or why they can't be used (the worse of the two). */
  private load(folder: string, kind: Kind): { loaded: Loaded; source: AlbumTagsView['source']; hadFallback: boolean } {
    const own = this.loadFrom(this.folderFile(folder, kind), kind);
    const fb = this.loadFrom(this.fallbackFile(folder, kind), kind);
    for (const bad of ['unreadable', 'broken'] as const) {
      if (own.kind === bad) return { loaded: own, source: 'folder', hadFallback: fb.kind !== 'none' };
      if (fb.kind === bad) return { loaded: fb, source: 'fallback', hadFallback: true };
    }
    const ownFile = own.kind === 'ok' ? own.file : undefined;
    const fbFile = fb.kind === 'ok' ? fb.file : undefined;
    if (!ownFile && !fbFile) return { loaded: { kind: 'none' }, source: 'none', hadFallback: false };
    return { loaded: { kind: 'ok', file: mergeFiles(ownFile, fbFile, kind) }, source: fbFile ? 'fallback' : 'folder', hadFallback: !!fbFile };
  }

  private index(folder: string, fresh: boolean): Index {
    const key = folderKey(folder);
    const hit = this.indexes.get(key);
    const now = Date.now();
    if (hit && !fresh) {
      if (hit.status === 'unreadable' ? now < hit.retryAt : now - hit.checkedAt < RECHECK_MS) return hit;
    }
    const stamp = KINDS.map((k) => this.kindStamp(folder, k)).join('|');
    if (hit && hit.stamp === stamp && hit.status !== 'unreadable') {
      hit.checkedAt = now;
      return hit;
    }
    this.stats.indexBuilds++;
    const tags = this.load(folder, 'tags');
    const vectors = this.load(folder, 'vectors');
    const idx: Index = {
      stamp, checkedAt: now, retryAt: now + this.unreadableRetryMs, status: 'none', source: tags.source,
      results: [], byName: new Map(), byContent: new Map(), byFile: new Map(), fileSizes: new Map(), modelIds: new Set(),
    };
    // A vectors file that can't be read only costs the vectors (the keywords model then redoes those photos)...
    // ...unless it is just unreadable for now: then wait, as for the tags file.
    const worst = tags.loaded.kind === 'unreadable' || vectors.loaded.kind === 'unreadable' ? (tags.loaded.kind === 'unreadable' ? tags.loaded : vectors.loaded) : tags.loaded;
    if (worst.kind === 'unreadable' || worst.kind === 'broken') {
      idx.status = worst.kind;
      idx.error = worst.error;
    } else if (tags.loaded.kind === 'ok') {
      idx.status = 'ok';
      const vecs = new Map<string, { contentKey: string; fileKey?: string; data: string }>();
      if (vectors.loaded.kind === 'ok') {
        for (const [name, entry] of Object.entries(vectors.loaded.file.photos)) {
          for (const [id, v] of Object.entries(modelsOf(entry) ?? {})) {
            if (isPlainObject(v) && typeof v.contentKey === 'string' && typeof v.data === 'string') vecs.set(itemKey(name, id), v as { contentKey: string; fileKey?: string; data: string });
          }
        }
      }
      for (const r of resultsOf(tags.loaded.file as never) as AlbumResult[]) {
        const k = itemKey(r.fileName, r.modelId);
        const v = vecs.get(k);
        if (v && (v.contentKey === r.contentKey || (!!r.fileKey && v.fileKey === r.fileKey))) {
          const e = decodeVector(v.data);
          if (e) r.embedding = e;
        }
        idx.results.push(r);
        idx.byName.set(k, r);
        idx.modelIds.add(r.modelId);
        const ck = `${r.contentKey}\0${r.modelId}`;
        idx.byContent.set(ck, [...(idx.byContent.get(ck) ?? []), r]);
        if (r.fileKey) {
          const fk = `${r.fileKey}\0${r.modelId}`;
          idx.byFile.set(fk, [...(idx.byFile.get(fk) ?? []), r]);
          const sizes = idx.fileSizes.get(r.modelId) ?? new Set<number | '?'>();
          sizes.add(fileKeySize(r.fileKey) ?? '?');
          idx.fileSizes.set(r.modelId, sizes);
        }
      }
    }
    this.indexes.set(key, idx);
    return idx;
  }

  /** Our temp files left by a crash (and by the first version's names) are removed, once per folder per run. */
  private cleanUp(folder: string): void {
    const key = folderKey(folder);
    if (this.cleaned.has(key)) return;
    this.cleaned.add(key);
    try {
      for (const n of readdirSync(folder)) if (isOurTemp(n)) removeQuietly(join(folder, n));
    } catch {
      /* not listable: nothing to clean */
    }
  }

  /** Applies the items to the merged current content (re-read, so another program's changes are kept) and writes it. */
  private writeKind(kind: Kind, folder: string, items: Item[]): void {
    const { loaded, hadFallback } = this.load(folder, kind);
    if (loaded.kind === 'broken') throw new Blocked(`${loaded.path} can't be read, so it was left alone. Fix or delete it. (${loaded.error})`);
    if (loaded.kind === 'unreadable') throw new WriteFailed(`${loaded.error}; it will be tried again`);
    const file = loaded.kind === 'ok' ? loaded.file : { format: FORMATS[kind], photos: {} };
    for (const { fileName, modelId, result, mode } of items) {
      const name = findName(file.photos, fileName) ?? fileName;
      const old = file.photos[name];
      // An entry under this name that this version can't read is left alone.
      if (old !== undefined && (!isPlainObject(old) || (old.models !== undefined && !isPlainObject(old.models)))) {
        this.report(folder, `The entry for ${name} in ${NAMES[kind]} can't be read, so it was left alone.`);
        continue;
      }
      const entry: Record<string, unknown> = isPlainObject(old) ? { ...old } : {};
      const models: Record<string, unknown> = { ...(modelsOf(old) ?? {}) };
      const was = models[modelId];
      const same = samePicture(was, result);
      if (same && mode === 'keep') {
        // The folder's result for this picture wins; it only learns the file key it lacked.
        if (result.fileKey && isPlainObject(was) && typeof was.fileKey !== 'string') models[modelId] = { ...was, fileKey: result.fileKey };
        else continue;
      } else if (kind === 'tags') {
        // Unknown fields of a result stay while it is about the same picture.
        models[modelId] = { ...(same ? withoutKnown(was as Record<string, unknown>) : {}), ...toStored(result) };
      } else {
        models[modelId] = {
          ...(same ? (was as Record<string, unknown>) : {}), contentKey: result.contentKey,
          ...(result.fileKey ? { fileKey: result.fileKey } : {}), data: encodeVector(result.embedding!), madeAt: result.madeAt,
        };
      }
      entry.models = models;
      file.photos[name] = entry;
    }
    this.writeFile(folder, kind, file, hadFallback);
  }

  private writeFile(folder: string, kind: Kind, file: RawFile, hadFallback: boolean): void {
    const write = this.opts.writeFile ?? ((target: string, t: string) => atomicWrite(target, t, this.opts.rename));
    const serialise = (f: RawFile) => (kind === 'tags' ? serialisePhotoTags(f as never) : serialisePhotoVectors(f as never));
    // Never a local path in the album's own file.
    const { folder: _path, ...forFolder } = file;
    try {
      this.cleanUp(folder);
      write(this.folderFile(folder, kind), serialise(forFolder as RawFile));
      // The folder is writable again: its file now has everything the fallback had.
      if (hadFallback) removeQuietly(this.fallbackFile(folder, kind));
      return;
    } catch (e) {
      if (e instanceof WriteFailed) throw e;
      const code = codeOf(e) ?? '';
      if (GONE_CODES.has(code)) throw new FolderGone();
      if (!FALLBACK_CODES.has(code)) throw new WriteFailed(`Could not write ${this.folderFile(folder, kind)}: ${(e as Error).message}`);
    }
    try {
      mkdirSync(dirname(this.fallbackFile(folder, kind)), { recursive: true });
      write(this.fallbackFile(folder, kind), serialise({ ...forFolder, folder: resolve(folder) } as RawFile));
    } catch (e) {
      throw new WriteFailed(`${folder} is read-only, and the fallback file could not be written either: ${(e as Error).message}`);
    }
  }
}

const KNOWN = ['contentKey', 'fileKey', 'description', 'objects', 'keywords', 'madeAt'];

function withoutKnown(r: Record<string, unknown>): Record<string, unknown> {
  const out = { ...r };
  for (const k of KNOWN) delete out[k];
  return out;
}

/** The readable part of a result, as stored. */
function toStored(r: NewTagResult): TagResult {
  return {
    contentKey: r.contentKey,
    ...(r.fileKey ? { fileKey: r.fileKey } : {}),
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(Array.isArray(r.objects) && r.objects.length ? { objects: r.objects } : {}),
    ...(Array.isArray(r.keywords) && r.keywords.length ? { keywords: r.keywords } : {}),
    ...(r.madeAt ? { madeAt: r.madeAt } : {}),
  };
}
