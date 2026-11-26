// The tagging results live in each album folder (phototool-tags.json and its vectors file, see shared/phototags);
// the catalogue is only a cache of them. `sync` runs as a folder's photos are read: results in the folder come into
// the catalogue (so a moved, copied or reinstalled album shows them without running the models), and done results
// the catalogue has but the folder lacks are written out once. `save` writes each new result as it is made.
// When the folder and the catalogue disagree about the same picture and model, the folder wins.
import { basename, dirname } from 'node:path';
import type { AlbumResult, AlbumTagsStore, NewTagResult } from '../../../shared/phototags';
import type { ModelChoice } from '../../core/tagModels';
import type { Catalog, GalleryPhoto, TagRow } from '../catalog';

export interface AlbumTagsDeps {
  catalog: Catalog;
  store: AlbumTagsStore;
  catalogue: readonly ModelChoice[];
}

const json = (v: unknown) => JSON.stringify(v ?? []);

const sameVector = (a: Float32Array | null | undefined, b: Float32Array | null | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

const fromRow = (r: TagRow): NewTagResult => ({
  contentKey: r.contentKey, description: r.description, objects: r.objects, keywords: r.keywords, embedding: r.embedding,
});

const fromStored = (s: AlbumResult, embedding = s.embedding): NewTagResult => ({
  contentKey: s.contentKey, description: s.description, objects: s.objects, keywords: s.keywords, embedding, madeAt: s.madeAt,
});

export class AlbumTags {
  constructor(private deps: AlbumTagsDeps) {}

  /**
   * These photos were read (a folder is being opened). Returns the content keys whose catalogue rows changed, so the
   * tagging queue can look them up again. Never throws for a file it can't read: that folder is left as it is.
   */
  sync(photos: GalleryPhoto[]): string[] {
    const { catalog, store, catalogue } = this.deps;
    const changed = new Set<string>();
    const partOf = new Map(catalogue.map((m) => [m.id, m.part]));
    const byFolder = new Map<string, GalleryPhoto[]>();
    for (const p of photos) {
      if (!p.contentKey) continue;
      const dir = dirname(p.path);
      byFolder.set(dir, [...(byFolder.get(dir) ?? []), p]);
    }
    for (const [folder, list] of byFolder) {
      const view = store.read(folder);
      // A file that can't be read: nothing comes in, and nothing is written (it would be refused).
      if (view.error) continue;
      const found = new Map<string, AlbumResult[]>();
      for (const r of view.results) {
        const k = `${r.contentKey}\0${r.modelId}`;
        found.set(k, [...(found.get(k) ?? []), r]);
      }
      const ids = [...new Set([...catalogue.map((m) => m.id), ...view.results.map((r) => r.modelId)])];
      const rows = catalog.tagsFor(list.map((p) => p.contentKey!), ids, true);
      for (const p of list) {
        const key = p.contentKey!;
        const name = basename(p.path);
        const cached = rows.get(key) ?? [];
        for (const id of ids) {
          const candidates = found.get(`${key}\0${id}`) ?? [];
          const own = candidates.find((r) => r.fileName.toLowerCase() === name.toLowerCase());
          const s = own ?? candidates[0];
          const c = cached.find((r) => r.modelId === id);
          if (!s) {
            // Migration: made before results were kept in the album folder (or its write was lost).
            if (c?.status === 'done') store.put(folder, name, id, fromRow(c));
            continue;
          }
          let embedding = s.embedding;
          if (partOf.get(id) === 'keywords' && !embedding) {
            // Search by meaning needs the vector: from the catalogue if it has one, else the model makes both again.
            if (c?.status !== 'done' || !c.embedding) continue;
            embedding = c.embedding;
            store.put(folder, name, id, fromStored(s, embedding));
          } else if (!own) {
            // A renamed (or copied) photo: its result under its name now, too.
            store.put(folder, name, id, fromStored(s));
          }
          const differs = !c || c.status !== 'done' || c.description !== (s.description ?? null) || json(c.objects) !== json(s.objects)
            || json(c.keywords) !== json(s.keywords) || (!!embedding && !sameVector(c.embedding, embedding));
          if (!differs) continue;
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

  /** A new done result (failed ones stay in the catalogue only, so they are tried again after a move): for each photo of that picture. */
  save(photos: GalleryPhoto[], row: TagRow): void {
    if (row.status !== 'done') return;
    for (const p of photos) {
      if (p.contentKey !== row.contentKey) continue;
      this.deps.store.put(dirname(p.path), basename(p.path), row.modelId, fromRow(row));
    }
  }
}
