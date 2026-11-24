import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { folderStamp, forgetPhotos, infoFor, PhotoInfoWriteError, readFolderInfo, updatePhotoInfo, type FolderInfo, type PhotoInfo, type PhotoInfoOptions } from '../../photoinfo';
import { listPlaces, suggestPlaces } from '../../server/places';
import { setResourceRoot } from '../../server/resources';
import { Catalog, type GalleryPhoto } from './catalog';
import { GalleryFolderError, Scanner } from './scanner';

// The gallery's HTTP API. Bound to 127.0.0.1 by main.ts (or the desktop shell) — never reachable from the network.

export interface GalleryAppOptions {
  /** Where photoinfo files for read-only photo folders are kept (the editor's `<dataDir>/photoinfo`). */
  photoInfoFallbackDir: string;
  /** The built gallery to serve at `/` (production). */
  staticDir?: string;
  /** Development: where the Vite dev server shows the gallery. */
  devWebUrl?: string;
  /** A packaged app's resource folder (see src/server/resources.ts). Leave it out when running from source. */
  resourceRoot?: string;
  /** Replaces how photoinfo.json is written or renamed. A seam for tests (a read-only or busy folder). */
  photoInfoSeams?: Pick<PhotoInfoOptions, 'writeFile' | 'rename'>;
}

export interface GalleryItem extends GalleryPhoto {
  info: PhotoInfo;
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
/** The most paths one drag-check looks at (a drag takes at most 500 files, see electron/drag.ts). */
const DRAG_MAX = 500;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createGalleryApp(dataDir: string, opts: GalleryAppOptions): { app: express.Express; close(): void } {
  if (opts.resourceRoot) setResourceRoot(opts.resourceRoot);
  const catalog = new Catalog(dataDir);
  const scanner = new Scanner(catalog, dataDir);
  const infoOpts: PhotoInfoOptions = { fallbackDir: opts.photoInfoFallbackDir, ...opts.photoInfoSeams };
  const jobIds: string[] = [];

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Defence in depth for the local-first guarantee: the page may only talk to this server.
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; script-src 'self' 'unsafe-inline'",
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

  // Each photo folder is read once per call, not once per photo.
  const itemsFor = (photos: GalleryPhoto[]): GalleryItem[] => {
    const folders = new Map<string, FolderInfo>();
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

  // With `job`, the reply also has that folder's stamp just before and after this write (`stamp`),
  // so the page can tell its own write from another program's change it has not seen yet.
  app.patch('/api/gallery/info', wrap((req, res) => {
    const { path, patch, job: jobId } = req.body ?? {};
    if (typeof path !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Expected { path, patch }');
    const photo = catalog.get(path);
    if (!photo) throw new HttpError(404, 'Unknown photo');
    const job = typeof jobId === 'string' && jobIds.includes(jobId) ? scanner.get(jobId) : undefined;
    const before = job ? jobStamp(job.photos) : undefined;
    try {
      updatePhotoInfo(dirname(photo.path), basename(photo.path), patch, infoOpts);
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

  app.get('/api/places', (_req, res) => res.json(listPlaces()));
  app.post('/api/places/suggest', wrap((req, res) => {
    const pts = Array.isArray(req.body?.points) ? (req.body.points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))) : [];
    res.json(suggestPlaces(pts));
  }));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(opts.staticDir!, 'gallery.html')));
  } else if (opts.devWebUrl) {
    // Dev mode: this port is only the API; the gallery is served by Vite. Send people there.
    app.get(/^\/(?!api\/).*/, (req, res) => res.redirect(302, opts.devWebUrl + req.originalUrl.slice(1)));
  } else if (opts.staticDir) {
    app.get(/^\/(?!api\/).*/, (_req, res) => res.status(503).type('text').send('The gallery has not been built yet. Run `npm run build`.'));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return { app, close: () => catalog.close() };
}
