// Background photo tagging for the open folder: once its scan is done, one photo at a time (the selected photo
// first, then the ones on screen, then the rest), with each chosen model, results kept by content key so a
// photo is looked at once. Never blocks anything: the models run in the backend's worker thread.
import { existsSync } from 'node:fs';
import { MODEL_CATALOGUE, findModel, type ModelChoice, type TagPart } from '../../../core/tagModels';
import type { Catalog, GalleryPhoto } from '../catalog';
import { installedModels, modelDir, type TaggingSettings } from '../models/store';
import type { TaggerBackend } from './backend';

export interface TaggingStatus {
  job: string | null;
  /** Photos of the job (with a content key). */
  total: number;
  /** Photos every working chosen model has looked at. */
  done: number;
  /** Photos a working chosen model couldn't look at. */
  failed: number;
  paused: boolean;
  running: boolean;
  /** Chosen parts whose model is damaged or would not load. */
  notWorking: TagPart[];
  /** Bumps whenever a photo's tags change. */
  stamp: number;
}

export interface TaggingQueueDeps {
  catalog: Catalog;
  backend: TaggerBackend;
  dataDir: string;
  catalogue?: readonly ModelChoice[];
  /** The picture to look at for a photo (its 1600 px thumbnail). */
  imageOf(photo: GalleryPhoto): Promise<string>;
}

const PARTS: TagPart[] = ['describe', 'keywords'];

export class TaggingQueue {
  private settings: TaggingSettings = { describe: null, keywords: null, paused: false };
  private job: { id: string; photos: () => GalleryPhoto[] } | null = null;
  private focusPaths: string[] = [];
  private loaded: Partial<Record<TagPart, string>> = {};
  private broken = new Set<TagPart>();
  /** Content keys with a row (done or failed), and the failed ones, per model id. */
  private seen = new Map<string, Set<string>>();
  private failedKeys = new Map<string, Set<string>>();
  /** Content keys already asked of the catalogue, per model id (with a row or not): asked once. */
  private looked = new Map<string, Set<string>>();
  /**
   * Paths of this job's photos found gone (deleted since the scan): never picked again in this job. Kept by path,
   * not content key, since another photo with the same picture (a copy here, or in another folder) still needs tags.
   */
  private gone = new Set<string>();
  /** Photos before this index in the job's list need nothing more from the current models. */
  private cursor = 0;
  private stamp = 0;
  private loop: Promise<void> | null = null;
  private stopped = false;
  private readonly catalogue: readonly ModelChoice[];

  constructor(private deps: TaggingQueueDeps) {
    this.catalogue = deps.catalogue ?? MODEL_CATALOGUE;
  }

  /** The open folder's scan is done: tag its photos. Replaces any earlier job. */
  startJob(jobId: string, photos: () => GalleryPhoto[]): void {
    // The focus the page sent while the scan ran is kept.
    if (this.job?.id !== jobId) this.gone.clear();
    this.job = { id: jobId, photos };
    this.cursor = 0;
    this.kick();
  }

  /** The folder was closed or another one is being opened: stop after the photo in hand. */
  clearJob(): void {
    this.job = null;
    this.focusPaths = [];
    this.gone.clear();
  }

  /** Paths to look at first, in order (the selected photo, then the ones on screen). */
  focus(paths: string[]): void {
    this.focusPaths = paths.slice(0, 1000);
  }

  setSettings(s: TaggingSettings): void {
    this.settings = { ...s };
    this.cursor = 0;
    this.refresh();
  }

  /** A photo was added or changed (an edit saved into it): carry on if there is new work. */
  wake(): void {
    this.cursor = 0;
    this.kick();
  }

  /** Models were downloaded or removed: look at them again (a re-downloaded model may work now). */
  refresh(): void {
    this.broken.clear();
    this.kick();
  }

  status(): TaggingStatus {
    const photos = this.job ? this.job.photos().filter((p) => p.contentKey) : [];
    const models = this.activeModels().map((m) => m.id);
    let done = 0;
    let failed = 0;
    if (models.length) {
      for (const p of photos) {
        if (this.gone.has(p.path)) done++;
        else if (models.some((id) => this.failedKeys.get(id)?.has(p.contentKey!))) failed++;
        else if (models.every((id) => this.seen.get(id)?.has(p.contentKey!))) done++;
      }
    }
    return {
      job: this.job?.id ?? null,
      total: photos.length,
      done,
      failed,
      paused: this.settings.paused,
      running: this.loop !== null,
      notWorking: PARTS.filter((p) => this.broken.has(p)),
      stamp: this.stamp,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.job = null;
    await this.loop;
    await this.deps.backend.close();
  }

  /** The chosen models that are installed whole and not broken. */
  private activeModels(): ModelChoice[] {
    const installed = new Map(installedModels(this.deps.dataDir, this.catalogue).map((i) => [i.id, i]));
    const out: ModelChoice[] = [];
    for (const part of PARTS) {
      const id = this.settings[part];
      const m = id ? findModel(id, this.catalogue) : undefined;
      if (!m || m.part !== part || this.broken.has(part)) continue;
      const inst = installed.get(m.id);
      if (!inst) continue;
      if (!inst.ok) {
        this.broken.add(part);
        continue;
      }
      out.push(m);
    }
    return out;
  }

  private kick(): void {
    if (this.loop || this.stopped || !this.job || this.settings.paused) return;
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  /** What has been looked at for these models, from the catalogue (once per model). */
  private learn(models: ModelChoice[], photos: GalleryPhoto[]): void {
    const keys = photos.map((p) => p.contentKey).filter((k): k is string => !!k);
    for (const m of models) {
      const seen = this.seen.get(m.id) ?? new Set<string>();
      const failed = this.failedKeys.get(m.id) ?? new Set<string>();
      const looked = this.looked.get(m.id) ?? new Set<string>();
      this.looked.set(m.id, looked);
      const unknown = keys.filter((k) => !looked.has(k));
      for (const k of unknown) looked.add(k);
      if (!unknown.length) {
        this.seen.set(m.id, seen);
        this.failedKeys.set(m.id, failed);
        continue;
      }
      for (const [k, rows] of this.deps.catalog.tagsFor(unknown, [m.id])) {
        seen.add(k);
        if (rows[0]?.status === 'failed') failed.add(k);
      }
      this.seen.set(m.id, seen);
      this.failedKeys.set(m.id, failed);
    }
  }

  private next(models: ModelChoice[], photos: GalleryPhoto[]): GalleryPhoto | undefined {
    const todo = (p: GalleryPhoto) => !!p.contentKey && !this.gone.has(p.path) && models.some((m) => !this.seen.get(m.id)?.has(p.contentKey!));
    const byPath = new Map(photos.map((p) => [p.path, p]));
    for (const path of this.focusPaths) {
      const p = byPath.get(path);
      if (p && todo(p)) return p;
    }
    // Photos are only appended to (or replaced in place by a refresh, which resets the cursor).
    while (this.cursor < photos.length && !todo(photos[this.cursor])) this.cursor++;
    return photos[this.cursor];
  }

  private async ensureLoaded(models: ModelChoice[]): Promise<ModelChoice[]> {
    const ok: ModelChoice[] = [];
    for (const m of models) {
      if (this.loaded[m.part] !== m.id) {
        try {
          await this.deps.backend.load(m.part, m, modelDir(this.deps.dataDir, m.id));
          this.loaded[m.part] = m.id;
        } catch {
          this.broken.add(m.part);
          delete this.loaded[m.part];
          continue;
        }
      }
      ok.push(m);
    }
    return ok;
  }

  private async run(): Promise<void> {
    for (;;) {
      const job = this.job;
      if (!job || this.stopped || this.settings.paused) return;
      const models = await this.ensureLoaded(this.activeModels());
      if (!models.length || this.job !== job) return;
      const photos = job.photos();
      this.learn(models, photos);
      const photo = this.next(models, photos);
      if (!photo) return;
      await this.tag(job, photo, models);
    }
  }

  private async tag(job: { id: string; photos: () => GalleryPhoto[] }, photo: GalleryPhoto, models: ModelChoice[]): Promise<void> {
    const key = photo.contentKey!;
    if (!existsSync(photo.path)) {
      // Deleted since the scan: never picked again in this job.
      this.gone.add(photo.path);
      return;
    }
    const results:{ m: ModelChoice; row: Parameters<Catalog['putTags']>[0] }[] = [];
    let image: string | null = null;
    try {
      image = await this.deps.imageOf(photo);
    } catch {
      // Reported per model below.
    }
    for (const m of models) {
      if (this.seen.get(m.id)?.has(key)) continue;
      const base = { contentKey: key, modelId: m.id, description: null, keywords: [], objects: [], embedding: null, error: null };
      try {
        if (!image) throw new Error("Couldn't read the photo.");
        if (m.part === 'describe') {
          const d = await this.deps.backend.describe(image);
          results.push({ m, row: { ...base, status: 'done', description: d.description, objects: d.objects } });
        } else {
          const k = await this.deps.backend.keywords(image);
          results.push({ m, row: { ...base, status: 'done', keywords: k.keywords, embedding: k.embedding } });
        }
      } catch (e) {
        results.push({ m, row: { ...base, status: 'failed', error: e instanceof Error ? e.message : String(e) } });
      }
      if (this.job !== job || this.stopped) break;
    }
    // A photo deleted, or a folder closed, while it was being looked at: keep nothing.
    if (this.job !== job || this.stopped || !existsSync(photo.path) || !job.photos().some((p) => p.path === photo.path)) {
      if (this.job === job && !this.stopped) {
        // Gone from this folder: never pick it again in this job.
        this.gone.add(photo.path);
      }
      return;
    }
    for (const { m, row } of results) {
      this.deps.catalog.putTags(row);
      this.seen.get(m.id)!.add(key);
      if (row.status === 'failed') this.failedKeys.get(m.id)!.add(key);
    }
    this.stamp++;
  }
}
