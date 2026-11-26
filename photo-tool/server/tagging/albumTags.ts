// The tagging results live in each album folder (phototool-tags.json and its vectors file, see shared/phototags);
// the catalogue is only a cache of them. `sync` runs as a folder's photos are read: results in the folder come into
// the catalogue (so a moved, copied or reinstalled album shows them without running the models), and done results
// the catalogue has but the folder lacks are written out once. `save` writes each new result as it is made.
// When the folder and the catalogue disagree about the same picture and model, the folder wins.
//
// A result matches a photo by its content key (this computer's thumbnail hash: fast, and finds renamed photos) or by
// its file key (the file's own bytes: the same on every computer). Each sync looks photos up in the folder's index,
// built once per change of its files, so opening a folder costs time in proportion to its photos.
//
// A folder whose file can't be read just now (locked by a sync engine, or offline) is held: its photos are not tagged
// (fresh output would only compete with what the file holds) until it can be read and its results have come in.
import { basename, dirname, resolve } from 'node:path';
import { fileKeyOf, type AlbumResult, type AlbumTagsStore, type NewTagResult, type PutMode } from '../../../shared/phototags';
import type { ModelChoice } from '../../core/tagModels';
import type { Catalog, GalleryPhoto, TagRow } from '../catalog';

export interface AlbumTagsDeps {
  catalog: Catalog;
  store: AlbumTagsStore;
  catalogue: readonly ModelChoice[];
  /** The longest a folder's photos are held back for a file that can't be read (it may never be). Default 10 min. */
  maxHoldMs?: number;
  /** A seam for tests. */
  now?: () => number;
}

const json = (v: unknown) => JSON.stringify(v ?? []);

const sameVector = (a: Float32Array | null | undefined, b: Float32Array | null | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

const fromStored = (s: AlbumResult, embedding = s.embedding): NewTagResult => ({
  contentKey: s.contentKey, fileKey: s.fileKey, description: s.description, objects: s.objects, keywords: s.keywords, embedding, madeAt: s.madeAt,
});

const folderKey = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

export class AlbumTags {
  /** File keys worked out this run, by path (with the size and time they were for). */
  private fileKeys = new Map<string, { size: number; mtimeMs: number; key: string | undefined }>();
  /** Photos of folders whose file could not be read just now, by folder then path. */
  private deferred = new Map<string, Map<string, GalleryPhoto>>();
  /** When each held folder was first found unreadable. */
  private heldSince = new Map<string, number>();

  constructor(private deps: AlbumTagsDeps) {}

  /** The photo file's key: read from the file once while its size and time stay the same (kept in the catalogue). */
  fileKeyOf(p: GalleryPhoto): string | undefined {
    const hit = this.fileKeys.get(p.path);
    if (hit && hit.size === p.size && hit.mtimeMs === p.mtimeMs) return hit.key;
    const kept = this.deps.catalog.fileKey(p.path, p.size, p.mtimeMs);
    let key: string | undefined;
    if (kept !== undefined) {
      key = kept ?? undefined;
    } else {
      key = fileKeyOf(p.path);
      // A file that can't be read now is not remembered as such: tried again next run.
      if (key) this.deps.catalog.putFileKey(p.path, p.size, p.mtimeMs, key);
    }
    this.fileKeys.set(p.path, { size: p.size, mtimeMs: p.mtimeMs, key });
    return key;
  }

  /**
   * These photos were read (a folder is being opened). Returns the content keys whose catalogue rows changed, so the
   * tagging queue can look them up again. A folder whose file can't be read is held (see `holds`) or, when it is
   * broken, left as it is.
   */
  sync(photos: GalleryPhoto[]): string[] {
    const { catalog, store, catalogue } = this.deps;
    const changed = new Set<string>();
    const partOf = new Map(catalogue.map((m) => [m.id, m.part]));
    const byFolder = new Map<string, GalleryPhoto[]>();
    for (const p of photos) {
      if (!p.contentKey) continue;
      const dir = dirname(p.path);
      const list = byFolder.get(dir);
      if (list) list.push(p);
      else byFolder.set(dir, [p]);
    }
    for (const [folder, list] of byFolder) {
      const view = store.lookup(folder);
      const fk = folderKey(folder);
      if (view.status === 'unreadable') {
        const held = this.deferred.get(fk) ?? new Map<string, GalleryPhoto>();
        for (const p of list) held.set(p.path, p);
        this.deferred.set(fk, held);
        if (!this.heldSince.has(fk)) this.heldSince.set(fk, this.now());
        continue;
      }
      const held = this.deferred.get(fk);
      if (held) {
        for (const p of list) held.delete(p.path);
        if (!held.size) this.deferred.delete(fk);
      }
      if (!this.deferred.has(fk)) this.heldSince.delete(fk);
      // A file that can't be parsed: nothing comes in, and nothing is written (it would be refused).
      if (view.status === 'broken') continue;
      const ids = [...new Set([...catalogue.map((m) => m.id), ...view.modelIds])];
      const rows = catalog.tagsFor(list.map((p) => p.contentKey!), ids, true);
      for (const p of list) {
        const key = p.contentKey!;
        const name = basename(p.path);
        const cached = rows.get(key) ?? [];
        const ref = { fileName: name, contentKey: key, size: p.size, fileKey: () => this.fileKeyOf(p) };
        for (const id of ids) {
          const s = view.find(id, ref);
          const c = cached.find((r) => r.modelId === id);
          if (!s) {
            // Migration: made before results were kept in the album folder (or its write was lost).
            if (c?.status === 'done') store.put(folder, name, id, this.resultOf(p, c));
            continue;
          }
          let embedding = s.embedding;
          const own = s.fileName.toLowerCase() === name.toLowerCase();
          if (partOf.get(id) === 'keywords' && !embedding) {
            // Search by meaning needs the vector: from the catalogue if it has one, else the model makes both again.
            if (c?.status !== 'done' || !c.embedding) continue;
            embedding = c.embedding;
            store.put(folder, name, id, { ...fromStored(s, embedding), fileKey: s.fileKey ?? this.fileKeyOf(p) });
          } else if (!own) {
            // A renamed (or copied) photo: its result under its name now, too.
            store.put(folder, name, id, { ...fromStored(s), fileKey: this.fileKeyOf(p) });
          }
          const differs = !c || c.status !== 'done' || c.description !== (s.description ?? null) || json(c.objects) !== json(s.objects)
            || json(c.keywords) !== json(s.keywords) || (!!embedding && !sameVector(c.embedding, embedding));
          if (!differs) continue;
          // Kept under this computer's content key: the folder's (another computer's, maybe) is only a hint.
          catalog.putTags({
            contentKey: key, modelId: id, status: 'done', description: s.description ?? null, objects: s.objects ?? [], keywords: s.keywords ?? [],
            embedding: embedding ?? null, error: null,
          });
          changed.add(key);
        }
      }
    }
    return [...changed];
  }

  /** True while the photo's folder file could not be read: don't tag it yet. */
  holds(photo: GalleryPhoto): boolean {
    const fk = folderKey(dirname(photo.path));
    if (!this.deferred.get(fk)?.has(photo.path)) return false;
    // Not for ever: a file that stays unreadable (no permission) must not stop tagging. Its results then stay in the
    // catalogue, and the file is still never written over.
    return this.now() - (this.heldSince.get(fk) ?? 0) <= (this.deps.maxHoldMs ?? 600_000);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  hasDeferred(): boolean {
    return this.deferred.size > 0;
  }

  /** Tries the held folders again; returns the content keys whose rows changed. */
  retryDeferred(): string[] {
    const out: string[] = [];
    for (const held of [...this.deferred.values()]) out.push(...this.sync([...held.values()]));
    return out;
  }

  /**
   * A new done result (failed ones stay in the catalogue only, so they are tried again after a move), for each photo
   * of that picture. 'keep' (tagging): the folder's result for the same picture stays. 'replace': Regenerate.
   */
  save(photos: GalleryPhoto[], row: TagRow, mode: PutMode = 'keep'): void {
    if (row.status !== 'done') return;
    for (const p of photos) {
      if (p.contentKey !== row.contentKey) continue;
      this.deps.store.put(dirname(p.path), basename(p.path), row.modelId, this.resultOf(p, row), mode);
    }
  }

  private resultOf(p: GalleryPhoto, r: TagRow): NewTagResult {
    return { contentKey: r.contentKey, fileKey: this.fileKeyOf(p), description: r.description, objects: r.objects, keywords: r.keywords, embedding: r.embedding };
  }
}
