import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { folderStamp, forgetPhotos, infoFor, PhotoInfoWriteError, readFolderInfo, updatePhotoInfo, type FolderInfo, type PhotoInfo, type PhotoInfoOptions } from '../../shared/photoinfo';
import { AlbumTagsStore, type AlbumTagsOptions } from '../../shared/phototags';
import { isIdentityEdit, parseEdit } from '../../shared/core/photoEdit';
import { hashFile, workingFile } from '../../shared/server/media';
import { editFormatFor, renderEdited } from '../../shared/server/photoEditRender';
import { listPlaces, suggestPlaces } from '../../shared/server/places';
import { setResourceRoot } from '../../shared/server/resources';
import { Catalog, type GalleryPhoto } from './catalog';
import { GalleryFolderError, Scanner } from './scanner';
import { MODEL_CATALOGUE, type ModelChoice } from '../core/tagModels';
import { modelRoutes } from './models/routes';
import { readTaggingSettings } from './models/store';
import { workerBackend, type TaggerBackend } from './tagging/backend';
import { AlbumTags } from './tagging/albumTags';
import { NoDescriptionError, TaggingQueue } from './tagging/queue';
import { cpus } from 'node:os';

// The gallery's HTTP API. Bound to 127.0.0.1 by main.ts (or the desktop shell) — never reachable from the network.

export interface GalleryAppOptions {
  /** Where photoinfo files for read-only photo folders are kept (the editor's `<dataDir>/photoinfo`). */
  photoInfoFallbackDir: string;
  /** The built gallery to serve at `/` (production). */
  staticDir?: string;
  /** Development: where the Vite dev server shows the gallery. */
  devWebUrl?: string;
  /** A packaged app's resource folder (see shared/server/resources.ts). Leave it out when running from source. */
  resourceRoot?: string;
  /** Replaces how photoinfo.json is written or renamed. A seam for tests (a read-only or busy folder). */
  photoInfoSeams?: Pick<PhotoInfoOptions, 'writeFile' | 'rename'>;
  /** How long the album folders' tag files wait before they are written (see shared/phototags/store.ts). A seam for tests. */
  albumTagsTiming?: Pick<AlbumTagsOptions, 'debounceMs' | 'maxWaitMs'>;
  /**
   * Photo tagging: `workerFile` is the tagging worker to run (built, or from source in development). The rest are
   * seams for tests and the e2e server: model downloads, the model list, what runs the models, which picture they get.
   */
  tagging?: { fetch?: typeof fetch; catalogue?: readonly ModelChoice[]; backend?: TaggerBackend; workerFile?: string; imageOf?: (p: GalleryPhoto) => Promise<string> };
}

/** What the computer found in a photo, from the models chosen in Settings (no embedding, at most 12 keywords). */
export interface PhotoTags {
  /** off: no model chosen; waiting: not looked at yet by every chosen model; failed: a chosen model couldn't look at it. */
  state: 'off' | 'waiting' | 'done' | 'failed';
  description: string | null;
  keywords: string[];
  objects: { label: string; count: number }[];
  /** True when the description is the chosen descriptions model's own (so Regenerate can replace it); else absent. */
  canRegenerate?: true;
}

/** The most keywords a photo shows. */
export const MAX_KEYWORDS = 12;
/** The most photos a search by meaning finds. */
const SEARCH_MAX = 200;

const cosine = (a: Float32Array, b: Float32Array): number => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

export interface GalleryItem extends GalleryPhoto {
  info: PhotoInfo;
  tags: PhotoTags;
  infoSource: 'folder' | 'fallback' | 'none';
  infoError?: string;
  /** The photo's date with a photoinfo override applied, else the EXIF date. */
  effectiveDate: string | null;
  effectiveLat: number | null;
  effectiveLon: number | null;
}

/** PATCH /api/gallery/info's reply: the updated photo, and with `job` the open folder's stamp around the write. */
export interface GalleryInfoReply extends GalleryItem {
  stamp?: { before: string; after: string };
}

/** Scan results kept in memory per server; asking for an older one is a 404. */
const MAX_JOBS = 4;
/** The most paths one drag-check looks at (a drag takes at most 500 files, see photo-tool/electron/drag.ts). */
const DRAG_MAX = 500;
/** Rendered edits in `<dataDir>/edits` are removed after this long. */
const EDIT_FILE_MAX_AGE_MS = 60 * 60 * 1000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createGalleryApp(dataDir: string, opts: GalleryAppOptions): { app: express.Express; close(): void } {
  if (opts.resourceRoot) setResourceRoot(opts.resourceRoot);
  const catalog = new Catalog(dataDir);
  // Photo tagging: the models run in a worker thread with half the processor's threads.
  // Without a worker file (tests that never choose a model) a model would fail to load and show as not working.
  const backend = opts.tagging?.backend ?? workerBackend(Math.max(1, Math.floor(cpus().length / 2)), opts.tagging?.workerFile ?? '');
  // The tagging results live in each album folder (a read-only one's beside its photoinfo fallback); the catalogue caches them.
  const albumStore = new AlbumTagsStore({ fallbackDir: opts.photoInfoFallbackDir, ...opts.albumTagsTiming });
  const albumTags = new AlbumTags({ catalog, store: albumStore, catalogue: opts.tagging?.catalogue ?? MODEL_CATALOGUE });
  const tagging = new TaggingQueue({
    catalog,
    backend,
    dataDir,
    catalogue: opts.tagging?.catalogue,
    imageOf: opts.tagging?.imageOf ?? (async (p) => catalog.thumbPath(p.key, 'm')),
    albumTags,
  });
  tagging.setSettings({ ...readTaggingSettings(dataDir), paused: false });
  // Tagging starts when the open folder's scan is done (not one cancelled because another folder was opened).
  const scanner = new Scanner(catalog, dataDir, {
    onDone: (job) => {
      // The live list: tag() checks the photo in hand is still on disk, and the items route leaves out deleted ones.
      if (!job.cancelled && jobIds.at(-1) === job.id) tagging.startJob(job.id, () => job.photos);
    },
    // Each photo's results in its album folder reach the catalogue before tagging starts (and are not made again).
    onPhoto: (photo) => {
      try {
        tagging.forget(albumTags.sync([photo]));
      } catch (e) {
        console.warn(`Could not read the saved tags for ${photo.path}:`, e);
      }
    },
  });
  const infoOpts: PhotoInfoOptions = { fallbackDir: opts.photoInfoFallbackDir, ...opts.photoInfoSeams };
  const jobIds: string[] = [];

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Defence in depth for the local-first guarantee: the page may only talk to this server. The one
  // exception: map tiles from OpenStreetMap, as images only (the Map tab, after the user said yes).
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data: https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; script-src 'self' 'unsafe-inline'",
    );
    next();
  });

  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);
  const q = (req: Request, name: string): string => {
    const v = req.query[name];
    return typeof v === 'string' ? v : '';
  };

  const isFolder = (folder: string): boolean => {
    try {
      return statSync(folder).isDirectory();
    } catch {
      return false;
    }
  };

  const requireJob = (id: string) => {
    const job = jobIds.includes(id) ? scanner.get(id) : undefined;
    if (!job) throw new HttpError(404, 'That folder is no longer open. Open it again.');
    return job;
  };

  /** Each photo's tags from the models chosen now, looked up in one go. */
  const tagsOf = (photos: GalleryPhoto[]): ((p: GalleryPhoto) => PhotoTags) => {
    const s = readTaggingSettings(dataDir);
    const chosen = [s.describe, s.keywords].filter((m): m is string => !!m);
    if (!chosen.length) return () => ({ state: 'off', description: null, keywords: [], objects: [] });
    // Until the chosen model of a part has looked at a photo, the other model of that part's results show (kept
    // until replaced); the state stays "waiting".
    const catalogue = opts.tagging?.catalogue ?? MODEL_CATALOGUE;
    const partOf = new Map(catalogue.map((m) => [m.id, m.part]));
    const rows = catalog.tagsFor(photos.map((p) => p.contentKey).filter((k): k is string => !!k), catalogue.map((m) => m.id));
    return (p) => {
      const mine = (p.contentKey && rows.get(p.contentKey)) || [];
      const of = (id: string | null) => (id ? mine.find((r) => r.modelId === id) : undefined);
      const shown = (id: string | null) => {
        const own = of(id);
        if (!id || own) return own;
        return mine.find((r) => r.status === 'done' && r.modelId !== id && partOf.get(r.modelId) === partOf.get(id));
      };
      const d = shown(s.describe);
      const k = shown(s.keywords);
      const got = chosen.map((id) => of(id));
      const state = got.some((r) => !r) ? 'waiting' : got.some((r) => r!.status === 'failed') ? 'failed' : 'done';
      return {
        state,
        description: d?.status === 'done' ? d.description : null,
        keywords: k?.status === 'done' ? [...k.keywords].sort((a, b) => b.score - a.score).slice(0, MAX_KEYWORDS).map((w) => w.label) : [],
        objects: d?.status === 'done' ? d.objects : [],
        ...(d?.status === 'done' && d.modelId === s.describe ? { canRegenerate: true as const } : {}),
      };
    };
  };

  // Each photo folder is read once per call, not once per photo.
  const itemsFor = (photos: GalleryPhoto[]): GalleryItem[] => {
    const folders = new Map<string, FolderInfo>();
    const tags = tagsOf(photos);
    return photos.map((p) => {
      const dir = dirname(p.path);
      let folderInfo = folders.get(dir);
      if (!folderInfo) folders.set(dir, (folderInfo = readFolderInfo(dir, infoOpts)));
      const info = infoFor(folderInfo, basename(p.path)) ?? {};
      const loc = info.location;
      const hasLoc = !!loc && typeof loc.lat === 'number' && typeof loc.lon === 'number';
      const item: GalleryItem = {
        ...p,
        info,
        tags: tags(p),
        infoSource: folderInfo.source,
        effectiveDate: typeof info.date === 'string' ? info.date : p.capturedAt,
        effectiveLat: hasLoc ? loc!.lat : p.gpsLat,
        effectiveLon: hasLoc ? loc!.lon : p.gpsLon,
      };
      if (folderInfo.error) item.infoError = folderInfo.error;
      return item;
    });
  };

  /** Changes whenever any photoinfo.json (or fallback file) of these photos' folders does. */
  const jobStamp = (photos: GalleryPhoto[]): string => {
    const folders = [...new Set(photos.map((p) => dirname(p.path)))].sort();
    return folders.map((f) => `${f}=${folderStamp(f, infoOpts)}`).join('|');
  };

  /** The photos of the folder open now (the last one opened), by path. */
  const openPhotos = (): Map<string, GalleryPhoto> => {
    const last = jobIds.at(-1);
    return new Map(((last && scanner.get(last)?.photos) || []).map((p) => [p.path, p]));
  };

  /** A photo of the open folder, or a 404. */
  const openPhoto = (path: string): GalleryPhoto => {
    const photo = openPhotos().get(path);
    if (!photo) throw new HttpError(404, 'That photo is not in the open folder any more.');
    return photo;
  };

  /** The photo as sharp can read it (a HEIC through its derived JPEG; hashed only when that is needed). */
  const workPathOf = async (photo: GalleryPhoto): Promise<string> => (await workingFile(photo.path, dataDir, () => hashFile(photo.path))).path;

  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'gallery' }));

  app.get('/api/gallery/recent', (_req, res) => res.json(catalog.recentFolders().map((r) => ({ ...r, exists: isFolder(r.folder) }))));

  app.post('/api/gallery/open', wrap((req, res) => {
    const { folder, recursive } = req.body ?? {};
    if (!folder || typeof folder !== 'string') throw new HttpError(400, 'Choose a folder to open');
    let job;
    try {
      job = scanner.open(folder, recursive !== false);
    } catch (e) {
      if (e instanceof GalleryFolderError) throw new HttpError(404, e.message);
      throw e;
    }
    jobIds.push(job.id);
    while (jobIds.length > MAX_JOBS) scanner.forget(jobIds.shift()!);
    // The earlier folder's tagging stops after the photo in hand; its results not written yet are written now.
    tagging.clearJob();
    albumStore.flush();
    res.status(202).json({ jobId: job.id });
  }));

  app.get('/api/gallery/jobs/:id', wrap((req, res) => {
    const job = requireJob(String(req.params.id));
    const since = Math.max(0, Math.floor(Number(q(req, 'since'))) || 0);
    // `done` first: a photo that lands after this line is simply picked up by the next poll.
    const done = job.done;
    res.json({
      total: job.total, processed: job.processed, startedAt: job.startedAt, done, cancelled: job.cancelled, errors: job.errors,
      items: itemsFor(job.photos.slice(since)),
    });
  }));

  // Stops a scan nobody wants any more (the page closed the folder or is opening another).
  app.post('/api/gallery/jobs/:id/cancel', wrap((req, res) => {
    const job = requireJob(String(req.params.id));
    scanner.cancel(job.id);
    res.json({ cancelled: job.cancelled });
  }));

  // The page reloads every photo's info from here, so a photo deleted since the scan drops out of the
  // grid. Its photoinfo.json entry is kept (nothing is written); "Tidy photo info" offers to remove it.
  app.get('/api/gallery/items', wrap((req, res) => {
    res.json(itemsFor(requireJob(q(req, 'job')).photos.filter((p) => existsSync(p.path))));
  }));

  app.get('/api/gallery/thumb', wrap((req, res) => {
    const size = q(req, 'size') || 'm';
    if (size !== 's' && size !== 'm') throw new HttpError(400, 'size must be s or m');
    const photo = catalog.getByKey(q(req, 'key'));
    if (!photo) throw new HttpError(404, 'Unknown photo');
    const file = catalog.thumbPath(photo.key, size);
    if (!existsSync(file)) throw new HttpError(404, 'Thumbnail not found');
    // The key changes whenever the file does, so a thumbnail never goes stale.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('image/jpeg').sendFile(file);
  }));

  // Asked by the desktop app's main process before it drags files out of the window: which of these
  // paths are photos this gallery has catalogued (in the order asked; a HEIC is its own .heic path),
  // and the first one's small thumbnail for the drag icon. POST, because a drag may carry 500 paths.
  app.post('/api/gallery/drag-check', wrap((req, res) => {
    const paths: unknown = req.body?.paths;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new HttpError(400, 'Expected { paths: string[] }');
    const photos = (paths as string[]).slice(0, DRAG_MAX).map((p) => catalog.get(p)).filter((p): p is GalleryPhoto => !!p);
    const icon = photos.length ? catalog.thumbPath(photos[0].key, 's') : null;
    res.json({ paths: photos.map((p) => p.path), icon: icon && existsSync(icon) ? icon : null });
  }));

  // A catalogued photo at full size as PNG, for the desktop app's "Copy to clipboard": Electron can't
  // read every format (HEIC goes through its derived JPEG), and a PNG it always can. Turned upright.
  app.get('/api/gallery/image', wrap(async (req, res) => {
    const photo = catalog.get(q(req, 'path'));
    if (!photo || !existsSync(photo.path)) throw new HttpError(404, 'Unknown photo');
    const work = await workingFile(photo.path, dataDir, () => hashFile(photo.path));
    const png = await sharp(work.path).rotate().png().toBuffer();
    res.setHeader('Cache-Control', 'no-store');
    res.type('image/png').send(png);
  }));

  // The desktop app moved these photos to the Recycle Bin: forget each one that really is gone from
  // disk (its cache row and thumbnails, its place in every open scan, its photoinfo.json entry). A path
  // still on disk, or one never catalogued, is skipped: this never deletes a file, only what is known about it.
  app.post('/api/gallery/removed', wrap((req, res) => {
    const paths: unknown = req.body?.paths;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new HttpError(400, 'Expected { paths: string[] }');
    const removed: string[] = [];
    for (const path of (paths as string[]).slice(0, DRAG_MAX)) {
      const photo = catalog.get(path);
      if (!photo || existsSync(photo.path)) continue;
      catalog.remove(photo.path);
      for (const id of jobIds) {
        const job = scanner.get(id);
        if (!job) continue;
        const at = job.photos.findIndex((p) => p.path === photo.path);
        if (at >= 0) job.photos.splice(at, 1);
      }
      try {
        forgetPhotos(dirname(photo.path), [basename(photo.path)], infoOpts);
      } catch (e) {
        // A photoinfo.json that can't be written keeps the entry; "Tidy photo info" offers it later.
        if (!(e instanceof PhotoInfoWriteError)) throw e;
      }
      removed.push(photo.path);
    }
    res.json({ removed });
  }));

  // Asked by the desktop app's main process before a file action of the right-click menu (copy, show in
  // folder, delete): which of these paths are photos of the folder open now (the last one opened), in
  // the order asked. Stricter than drag-check, which takes any photo ever catalogued (a folder opened in
  // an earlier session too); a folder opened before this one, though its scan is still kept, is not open.
  app.post('/api/gallery/file-check', wrap((req, res) => {
    const paths: unknown = req.body?.paths;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new HttpError(400, 'Expected { paths: string[] }');
    const open = openPhotos();
    res.json({ paths: (paths as string[]).slice(0, DRAG_MAX).filter((p) => open.has(p)) });
  }));

  // Writes a photo with an edit applied into `<dataDir>/edits` and says where. The caller (the desktop
  // app's main process) moves it into place. Files there older than an hour are removed on each call.
  app.post('/api/gallery/edit/render', wrap(async (req, res) => {
    const { path, edit: rawEdit } = req.body ?? {};
    if (typeof path !== 'string') throw new HttpError(400, 'Expected { path, edit }');
    const photo = openPhoto(path);
    const edit = parseEdit(rawEdit);
    if (!edit) throw new HttpError(400, 'That edit is not valid.');
    const dir = join(dataDir, 'edits');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > EDIT_FILE_MAX_AGE_MS) rmSync(file, { force: true });
      } catch {
        // gone or busy: left for the next call
      }
    }
    const format = editFormatFor(photo.path);
    const file = join(dir, `${randomUUID()}.${format === 'jpeg' ? 'jpg' : format}`);
    await renderEdited(await workPathOf(photo), edit, file, format, { keepMetadata: true });
    res.json({ file, format });
  }));

  // Reads these photos again after the desktop app changed them on disk (an edit saved, a file added):
  // new key and thumbnails. Replies with the photos now in the open folder, in the order asked.
  app.post('/api/gallery/refresh', wrap(async (req, res) => {
    const paths: unknown = req.body?.paths;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new HttpError(400, 'Expected { paths: string[] }');
    const last = jobIds.at(-1);
    const out: GalleryPhoto[] = [];
    for (const path of (paths as string[]).slice(0, DRAG_MAX)) {
      const photo = last ? await scanner.refresh(last, path) : null;
      if (photo) tagging.wake();
      if (photo) out.push(photo);
    }
    res.json(itemsFor(out));
  }));

  // A photo of the open folder at full size, upright, as JPEG (the zoomed view).
  app.get('/api/gallery/full', wrap(async (req, res) => {
    const photo = openPhoto(q(req, 'path'));
    if (!existsSync(photo.path)) throw new HttpError(404, 'That photo is not in the open folder any more.');
    const jpeg = await sharp(await workPathOf(photo), { failOn: 'none' }).rotate().jpeg({ quality: 90 }).toBuffer();
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('image/jpeg').send(jpeg);
  }));

  // With `job`, the reply also has that folder's stamp just before and after this write (`stamp`),
  // so the page can tell its own write from another program's change it has not seen yet.
  app.patch('/api/gallery/info', wrap((req, res) => {
    const { path, patch, job: jobId } = req.body ?? {};
    if (typeof path !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Expected { path, patch }');
    const photo = catalog.get(path);
    if (!photo) throw new HttpError(404, 'Unknown photo');
    // An edit must be null or valid; one that changes nothing is stored as no edit.
    let toWrite: Record<string, unknown> = patch;
    if ('edit' in patch && patch.edit !== null) {
      const edit = parseEdit(patch.edit);
      if (!edit) throw new HttpError(400, 'That edit is not valid.');
      toWrite = { ...patch, edit: isIdentityEdit(edit) ? null : edit };
    }
    // The score nudges (Up/Down): a whole number; 0 is stored as no field.
    if ('scoreAdjust' in patch && patch.scoreAdjust !== null) {
      const n = patch.scoreAdjust;
      if (typeof n !== 'number' || !Number.isInteger(n) || Math.abs(n) > 100_000) throw new HttpError(400, 'scoreAdjust must be a whole number.');
      toWrite = { ...toWrite, scoreAdjust: n === 0 ? null : n };
    }
    const job = typeof jobId === 'string' && jobIds.includes(jobId) ? scanner.get(jobId) : undefined;
    const before = job ? jobStamp(job.photos) : undefined;
    // A patch that only removes fields the photo does not have changes nothing: photoinfo.json is not
    // written (or made) for it. Saving to the photo file clears the edit this way after every save.
    const folderInfo = readFolderInfo(dirname(photo.path), infoOpts);
    const current = infoFor(folderInfo, basename(photo.path)) ?? {};
    const noChange = !folderInfo.error && Object.entries(toWrite).every(([field, value]) => (value === null || value === undefined) && !(field in current));
    try {
      if (!noChange) updatePhotoInfo(dirname(photo.path), basename(photo.path), toWrite, infoOpts);
    } catch (e) {
      if (e instanceof PhotoInfoWriteError) throw new HttpError(409, e.message);
      throw e;
    }
    const item: GalleryInfoReply = itemsFor([photo])[0];
    if (job) item.stamp = { before: before!, after: jobStamp(job.photos) };
    res.json(item);
  }));

  app.get('/api/gallery/stamp', wrap((req, res) => {
    res.json({ stamp: jobStamp(requireJob(q(req, 'job')).photos) });
  }));

  app.get('/api/gallery/people', wrap((req, res) => {
    const counts = new Map<string, number>();
    for (const item of itemsFor(requireJob(q(req, 'job')).photos)) {
      const people = item.info.people;
      if (!Array.isArray(people)) continue;
      for (const name of new Set(people.filter((n): n is string => typeof n === 'string' && n !== ''))) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    res.json([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name));
  }));

  /** The lower-cased names in a folder, or undefined when it can't be listed (a drive that is not connected). */
  const namesIn = (folder: string): Set<string> | undefined => {
    try {
      return new Set(readdirSync(folder).map((n) => n.toLowerCase()));
    } catch {
      return undefined;
    }
  };

  // Entries of photoinfo.json whose photo is no longer in the folder, for the open folder's photo folders.
  // A folder that can't be listed is left out: its photos are not known to be gone.
  app.get('/api/gallery/orphans', wrap((req, res) => {
    const job = requireJob(q(req, 'job'));
    const out: { folder: string; fileNames: string[] }[] = [];
    for (const folder of [...new Set(job.photos.map((p) => dirname(p.path)))].sort()) {
      const names = namesIn(folder);
      if (!names) continue;
      const fileNames = Object.keys(readFolderInfo(folder, infoOpts).photos).filter((n) => !names.has(n.toLowerCase())).sort();
      if (fileNames.length) out.push({ folder, fileNames });
    }
    res.json(out);
  }));

  // Removes entries for photos that are gone. Each name is checked again here, so a photo that came back
  // since the list was made (or a name that was never an orphan) is refused and nothing is written.
  app.post('/api/gallery/forget', wrap((req, res) => {
    const { folder, fileNames } = req.body ?? {};
    if (typeof folder !== 'string' || !Array.isArray(fileNames) || fileNames.length === 0 || !fileNames.every((n) => typeof n === 'string' && n !== '')) {
      throw new HttpError(400, 'Expected { folder, fileNames }');
    }
    const known = jobIds.some((id) => scanner.get(id)?.photos.some((p) => resolve(dirname(p.path)) === resolve(folder)));
    if (!known) throw new HttpError(404, 'That folder is no longer open. Open it again.');
    const names = namesIn(folder);
    if (!names) throw new HttpError(400, `Can't look in ${folder}, so nothing was removed.`);
    const present = (fileNames as string[]).filter((n) => /[\\/]/.test(n) || names.has(n.toLowerCase()));
    if (present.length) throw new HttpError(400, `${present.slice(0, 3).join(', ')}${present.length > 3 ? '…' : ''} ${present.length === 1 ? 'is' : 'are'} still in the folder, so nothing was removed.`);
    try {
      res.json({ removed: forgetPhotos(folder, fileNames as string[], infoOpts) });
    } catch (e) {
      if (e instanceof PhotoInfoWriteError) throw new HttpError(409, e.message);
      throw e;
    }
  }));

  const models = modelRoutes(app, dataDir, {
    fetch: opts.tagging?.fetch,
    catalogue: opts.tagging?.catalogue,
    onSettings: (s) => tagging.setSettings(s),
    onModelsChanged: () => tagging.refresh(),
    tagging: () => {
      const st = tagging.status();
      return { paused: st.paused, notWorking: st.notWorking };
    },
  });

  // The page closed the folder: stop tagging it.
  app.post('/api/gallery/tagging/close', wrap((req, res) => {
    const job = req.body?.job;
    if (typeof job !== 'string') throw new HttpError(400, 'Send the job.');
    if (jobIds.at(-1) === job) tagging.clearJob();
    albumStore.flush();
    res.status(204).end();
  }));

  app.get('/api/gallery/tagging/status', (_req, res) => res.json(tagging.status()));

  // Search by meaning: the folder's photos whose picture is close to the words (cosine with the keywords model's
  // picture embedding at least its meaningThreshold), best first, at most SEARCH_MAX. Needs 3 letters and a keywords model.
  app.get('/api/gallery/search', wrap(async (req, res) => {
    const job = requireJob(q(req, 'job'));
    const text = q(req, 'q').trim();
    if ((text.match(/\p{L}/gu)?.length ?? 0) < 3) return void res.json({ paths: [] });
    const found = await tagging.embedText(text).catch(() => null);
    const threshold = found?.model.meaningThreshold;
    if (!found || threshold === undefined) return void res.json({ paths: [] });
    const photos = job.photos.filter((p) => p.contentKey && existsSync(p.path));
    const embeddings = catalog.embeddings([...new Set(photos.map((p) => p.contentKey!))], found.model.id);
    const scored: { path: string; score: number }[] = [];
    for (const p of photos) {
      const e = embeddings.get(p.contentKey!);
      if (!e) continue;
      const score = cosine(found.embedding, e);
      if (score >= threshold) scored.push({ path: p.path, score });
    }
    scored.sort((a, b) => b.score - a.score);
    res.json({ paths: scored.slice(0, SEARCH_MAX).map((s) => s.path) });
  }));

  app.post('/api/gallery/tagging/focus', wrap((req, res) => {
    const { job, paths } = req.body ?? {};
    if (typeof job !== 'string' || !Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new HttpError(400, 'Send the job and a list of paths.');
    if (jobIds.at(-1) === job) tagging.focus(paths as string[]);
    res.status(204).end();
  }));

  // Regenerate: the chosen descriptions model writes a new description of one photo of the open folder (only the
  // sentence changes, in this catalogue). Replies with the photo's tags.
  app.post('/api/gallery/tagging/regenerate', wrap(async (req, res) => {
    const { job, path } = req.body ?? {};
    if (typeof job !== 'string' || typeof path !== 'string') throw new HttpError(400, 'Send the job and the photo path.');
    if (jobIds.at(-1) !== job) throw new HttpError(404, 'That folder is no longer open. Open it again.');
    const photo = openPhoto(path);
    if (!existsSync(photo.path)) throw new HttpError(404, 'That photo is not in the open folder any more.');
    try {
      await tagging.regenerate(photo);
    } catch (e) {
      if (e instanceof NoDescriptionError) throw new HttpError(409, e.message);
      throw e;
    }
    res.json(tagsOf([photo])(photo));
  }));

  app.get('/api/places', (_req, res) => res.json(listPlaces()));
  app.post('/api/places/suggest', wrap((req, res) => {
    const pts = Array.isArray(req.body?.points) ? (req.body.points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))) : [];
    res.json(suggestPlaces(pts));
  }));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(opts.staticDir!, 'index.html')));
  } else if (opts.devWebUrl) {
    // Dev mode: this port is only the API; the gallery is served by Vite. Send people there.
    app.get(/^\/(?!api\/).*/, (req, res) => res.redirect(302, opts.devWebUrl + req.originalUrl.slice(1)));
  } else if (opts.staticDir) {
    app.get(/^\/(?!api\/).*/, (_req, res) => res.status(503).type('text').send('Photo Tool has not been built yet. Run `npm run build:photo-tool`.'));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return {
    app,
    close: () => {
      models.stop();
      // The worker is stopped; a photo being looked at is dropped (stop() marks the queue stopped at once,
      // so nothing is written to the catalogue after it is closed).
      void tagging.stop();
      // What the album folders' tag files are still waiting for is written before the catalogue closes.
      albumStore.close();
      catalog.close();
    },
  };
}
