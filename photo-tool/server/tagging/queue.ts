// Background photo tagging for the open folder: once its scan is done, one photo at a time (the selected photo
// first, then the ones on screen, then the rest), with each chosen model, results kept by content key so a
// photo is looked at once. Never blocks anything: the models run in the backend's worker thread.
import { existsSync } from 'node:fs';
import { MODEL_CATALOGUE, findModel, type ModelChoice, type TagPart } from '../../core/tagModels';
import type { Catalog, GalleryPhoto } from '../catalog';
import { verifyModel } from '../models/download';
import { installedModels, modelDir, type TaggingSettings } from '../models/store';
import { BackendLostError, type TaggerBackend } from './backend';

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
  /** Why tagging stopped on its own (a catalogue write failed, say); cleared when it is asked to carry on. */
  problem: string | null;
}

export interface TaggingQueueDeps {
  catalog: Catalog;
  backend: TaggerBackend;
  dataDir: string;
  catalogue?: readonly ModelChoice[];
  /** The picture to look at for a photo (its 1600 px thumbnail). */
  imageOf(photo: GalleryPhoto): Promise<string>;
}

/** Regenerate can't run: no working descriptions model, or it has not described this photo yet. */
export class NoDescriptionError extends Error {}

const PARTS: TagPart[] = ['describe', 'keywords'];
/** Times in a row the backend may lose a part's model before that part counts as not working. */
const MAX_LOSSES = 3;

export class TaggingQueue {
  private settings: TaggingSettings = { describe: null, keywords: null, paused: false };
  private job: { id: string; photos: () => GalleryPhoto[] } | null = null;
  private focusPaths: string[] = [];
  private loaded: Partial<Record<TagPart, string>> = {};
  private loading = new Map<string, Promise<boolean>>();
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
  private problem: string | null = null;
  /** Parts whose model the backend lost during the last photo, and how many times in a row each was lost. */
  private lost = new Set<TagPart>();
  private losses: Partial<Record<TagPart, number>> = {};
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
    // Pause holds until Resume or the next folder.
    this.settings.paused = false;
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
    this.losses = {};
    this.kick();
  }

  status(): TaggingStatus {
    const photos = this.job ? this.job.photos().filter((p) => p.contentKey) : [];
    const active = this.activeModels();
    const models = active.map((m) => m.id);
    // Counted from the catalogue even when the loop is not running (paused), once per photo.
    if (this.job) this.learn(active, photos);
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
      problem: this.problem,
    };
  }

  /**
   * Words as the chosen keywords model sees them, for search by meaning: null when no working keywords model is
   * chosen. Loads the model when tagging has not (paused, or nothing to tag yet).
   */
  async embedText(text: string): Promise<{ model: ModelChoice; embedding: Float32Array } | null> {
    const m = this.activeModels().find((x) => x.part === 'keywords');
    for (let tries = 0; tries < 2; tries++) {
      if (!m || this.stopped || !(await this.loadModel(m))) return null;
      try {
        return { model: m, embedding: await this.deps.backend.embedText(text) };
      } catch (e) {
        if (!(e instanceof BackendLostError)) throw e;
        if (this.loaded.keywords === m.id) delete this.loaded.keywords;
      }
    }
    return null;
  }

  /**
   * Regenerate: the chosen descriptions model writes a new (sampled) description of a photo it has described,
   * replacing only that sentence in the catalogue; its objects are kept. Runs whether tagging is paused or not
   * (loading the model when tagging has not), and waits in the worker's queue behind a photo being tagged.
   * Throws NoDescriptionError when there is no working descriptions model or no description of it to replace.
   */
  async regenerate(photo: GalleryPhoto): Promise<string> {
    const m = this.activeModels().find((x) => x.part === 'describe');
    if (!m) throw new NoDescriptionError('There is no working descriptions model. Choose one in Settings.');
    const key = photo.contentKey;
    const own = key ? this.deps.catalog.tagsFor([key], [m.id]).get(key)?.[0] : undefined;
    if (!key || own?.status !== 'done') throw new NoDescriptionError(`${m.label} has not described this photo yet.`);
    const image = await this.deps.imageOf(photo);
    for (let tries = 0; ; tries++) {
      if (this.stopped) throw new Error('Tagging stopped.');
      if (!(await this.loadModel(m))) throw new NoDescriptionError(`${m.label} would not load. See Settings.`);
      try {
        const text = (await this.deps.backend.caption(image)).trim();
        // Sampling can end at once: saving nothing would hide the sentence (and this button) for good.
        if (!text) throw new Error(`${m.label} wrote an empty description. Try again.`);
        if (!this.deps.catalog.setDescription(key, m.id, text)) throw new NoDescriptionError(`${m.label} has not described this photo yet.`);
        this.stamp++;
        return text;
      } catch (e) {
        // The worker restarted: load the model again and ask once more.
        if (!(e instanceof BackendLostError) || tries >= 1) throw e;
        if (this.loaded.describe === m.id) delete this.loaded.describe;
      }
    }
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
    this.problem = null;
    this.loop = this.run()
      .catch((e: unknown) => {
        // Nothing is thrown at whoever started tagging: the bar shows why it stopped, and it is tried again
        // when asked (a setting, a refresh, another folder).
        this.problem = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.loop = null;
        // The job changed while the last step ran (another folder opened during a model load): start on it.
        if (!this.problem && this.job && this.job !== ran) this.kick();
      });
    const ran = this.job;
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
    for (const m of models) if (await this.loadModel(m)) ok.push(m);
    return ok;
  }

  /** Load a model into the backend unless it is loaded (one load at a time per model, shared by its callers). False: it would not load. */
  private loadModel(m: ModelChoice): Promise<boolean> {
    if (this.loaded[m.part] === m.id) return Promise.resolve(true);
    let p = this.loading.get(m.id);
    if (!p) {
      p = this.deps.backend
        .load(m.part, m, modelDir(this.deps.dataDir, m.id))
        .then(
          () => {
            this.loaded[m.part] = m.id;
            return true;
          },
          async () => {
            delete this.loaded[m.part];
            // A file damaged in place (same size) is found and deleted, so Settings offers Download again.
            await verifyModel(this.deps.dataDir, m).catch(() => []);
            this.broken.add(m.part);
            return false;
          },
        )
        .finally(() => this.loading.delete(m.id));
      this.loading.set(m.id, p);
    }
    return p;
  }

  private async run(): Promise<void> {
    for (;;) {
      const job = this.job;
      if (!job || this.stopped || this.settings.paused) return;
      const models = await this.ensureLoaded(this.activeModels());
      if (this.job !== job) continue;
      if (!models.length) return;
      const photos = job.photos();
      this.learn(models, photos);
      const photo = this.next(models, photos);
      if (!photo) return;
      await this.tag(job, photo, models);
      for (const m of models) {
        if (!this.lost.has(m.part)) {
          delete this.losses[m.part];
          continue;
        }
        // The backend lost the model (its worker restarted): load it again, unless that keeps happening.
        if (this.loaded[m.part] === m.id) delete this.loaded[m.part];
        this.losses[m.part] = (this.losses[m.part] ?? 0) + 1;
        if (this.losses[m.part]! >= MAX_LOSSES) this.broken.add(m.part);
      }
      this.lost.clear();
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
        // Not the photo's fault: the model is loaded again and the photo looked at again.
        if (e instanceof BackendLostError) {
          this.lost.add(m.part);
          continue;
        }
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
