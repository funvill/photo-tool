# Server and data formats

This section covers Photo Tool's local HTTP server and everything it stores or exchanges: the server app and its security model, every HTTP route, the SQLite catalogue (`gallery.sqlite`), the folder walker and scanner, thumbnails and decoded images (including HEIC), the media format registry, the photo edit model and how an edit is rendered, the `photoinfo.json` sidecar, the `phototool-tags.json` and `phototool-tags.vectors.json` sidecars, and the server's part in file actions (move to trash, reveal, copy, drag).

The internals of photo tagging (the model worker, the queue's scheduling, model download and verification) are covered in another section. Their HTTP routes and their data files are listed here.

Main sources: `photo-tool/server/app.ts`, `photo-tool/server/catalog.ts`, `photo-tool/server/scanner.ts`, `photo-tool/server/walk.ts`, `photo-tool/server/main.ts`, `photo-tool/server/dirs.ts`, `shared/server/media.ts`, `shared/server/heic.ts`, `shared/server/mediaHandlers/*`, `shared/server/photoEditRender.ts`, `shared/core/mediaFormats.ts`, `shared/core/photoEdit.ts`, `shared/photoinfo/*`, `shared/phototags/*`, `photo-tool/server/tagging/albumTags.ts`. Tests used as evidence: `photo-tool/tests/gallery-server.test.ts`, `gallery-catalog.test.ts`, `gallery-edit-server.test.ts`, `gallery-drag.test.ts`, `gallery-file-actions.test.ts`, `gallery-scanner-exif.test.ts`, `gallery-tags-store.test.ts`, `gallery-album-tags.test.ts`, `gallery-tagging-app.test.ts`, and `shared/tests/photoinfo.test.ts`, `phototags.test.ts`, `photo-edit.test.ts`, `photo-edit-render.test.ts`, `media-formats.test.ts`, `heic.test.ts`, `dev-data.test.ts`.

### Design principles

- **Local-first.** The server listens on `127.0.0.1` only. The page may load nothing from other hosts except OpenStreetMap map tiles, as images (enforced by a Content-Security-Policy header).
- **Originals are only read.** The server never writes to, renames or deletes a photo file. The desktop shell (Electron main process) moves files to the Recycle Bin and moves rendered edits into place, and only after asking the server which paths it may touch.
- **The truth lives beside the photos; the catalogue is a cache.** What people type about a photo is kept in `photoinfo.json` in the photo's folder. What the tagging models produced is kept in `phototool-tags.json` and `phototool-tags.vectors.json` in the photo's folder. `gallery.sqlite`, the thumbnails and the decoded copies can all be deleted; they are rebuilt by the next scan and by reading the sidecars.
- **Read-only folders still work.** When a photo folder cannot be written, the sidecars go to a shared fallback folder (`PHOTOINFO_FALLBACK_DIR`). The Photobook Editor uses the same fallback folder, so a star set in Photo Tool reaches the editor.
- **Unknown fields survive.** Every sidecar keeps fields and entries it does not understand, at every level, on every write.
- **Files are never half-written.** Sidecars, thumbnails, decoded HEIC copies and rendered edits are written to a temporary file and renamed into place.

## The server app

### Creating the app

`createGalleryApp(dataDir: string, opts: GalleryAppOptions): { app: express.Express; close(): void }` (`photo-tool/server/app.ts`) builds an Express 5 app. It is used in two ways:

1. **Run from source** (`photo-tool/server/main.ts`, `npm run dev:photo-tool`): a plain Node process that calls `app.listen(port, '127.0.0.1')`.
2. **Desktop app** (`photo-tool/electron/server-host.ts`): the same app, run inside an Electron utility process by `shared/electron/serverHost.ts`. The main process sends `{ type: 'start', dataDir, photoInfoFallbackDir, port, fallbackToAny?, resourceRoot?, devWebUrl? }` and receives `{ type: 'ready', port }` or `{ type: 'error', error }`. It sends `{ type: 'stop' }` before quitting, so the database is closed properly. `port: 0` means any free port. With `fallbackToAny`, a remembered port that is busy (`EADDRINUSE`) or refused (`EACCES`) is replaced by any free port. The server always binds to `127.0.0.1`.

`GalleryAppOptions`:

| Option | Type | Meaning |
|---|---|---|
| `photoInfoFallbackDir` | string, required | Where sidecars of read-only photo folders are kept (shared with the Photobook Editor). |
| `staticDir` | string, optional | The built page to serve at `/` (production). |
| `devWebUrl` | string, optional | Development: the Vite dev server URL. Non-API GETs are redirected there. |
| `resourceRoot` | string, optional | A packaged app's resource folder (see "Resource files" below). Leave it out when running from source. |
| `photoInfoSeams` | `{ writeFile?, rename? }` | Test seam: replaces how `photoinfo.json` is written or renamed (to simulate a read-only or busy folder). |
| `albumTagsTiming` | `{ debounceMs?, maxWaitMs?, retryMs?, maxRetryMs? }` | Test seam: timings of the tags sidecar writer. |
| `tagging` | `{ fetch?, catalogue?, backend?, workerFile?, imageOf? }` | Tagging: `workerFile` is the tagging worker script. The rest are test seams (model download fetch, model list, model runner, which picture the models get). |

On creation the app:

1. Calls `setResourceRoot(opts.resourceRoot)` when given.
2. Opens the `Catalog` (creates `<dataDir>/thumbs`, `<dataDir>/derived` and `<dataDir>/gallery.sqlite`).
3. Creates the tagging backend: a worker thread using `max(1, floor(cpus().length / 2))` threads, unless a test backend is given.
4. Creates the `AlbumTagsStore` (tags sidecar writer), with `fallbackDir = photoInfoFallbackDir`.
5. Creates `AlbumTags` (sync between sidecars and catalogue) and the `TaggingQueue`. The queue's default `imageOf` is the photo's 1600 px thumbnail (`thumbs/<key>_m.jpg`). When a tagging pass ends or pauses, the queue calls `albumStore.flush()`.
6. Loads the tagging settings from `<dataDir>/tagging.json`, forcing `paused: false`.
7. Creates the `Scanner` with two hooks:
   - `onPhoto(photo)`: called as each photo is read. It runs `albumTags.sync([photo])` and tells the queue to forget the content keys whose rows changed. An exception is logged as a warning, never thrown.
   - `onDone(job)`: when a scan ends, and it was not cancelled, and it is still the last job opened, the tagging queue starts on that job's live photo list.

`close()` stops model downloads, stops the tagging queue (a photo in hand is dropped; nothing is written to the catalogue after this), calls `albumStore.close()` (writes every waiting sidecar change, ignoring back-off) and closes the catalogue. `main.ts` calls it on `SIGINT` and `SIGTERM` after `server.close()`, then exits with code 0.

### Middleware and errors

- `x-powered-by` is disabled.
- `express.json({ limit: '1mb' })`. Only `application/json` bodies are parsed; others leave `req.body` undefined.
- Every response carries this exact header:

  `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data: https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; script-src 'self' 'unsafe-inline'`

- Route handlers that can fail are wrapped so a thrown error or a rejected promise reaches one error handler. An `HttpError(status, message)` becomes that status. Anything else becomes **500** and is logged with `console.error`. The body is always `{ "error": "<message>" }`. This includes malformed JSON and bodies over 1 MB (rejected by `express.json`), which come out as 500 with the parser's message rather than 400.
- An unknown `/api/...` path gets Express's default 404 (HTML `Cannot GET ...`), not JSON.
- The model routes (`/api/gallery/models...`, `PUT /api/gallery/tagging/settings`) are not wrapped; they send their own `{ error }` replies.
- Query parameters are read with `q(req, name)`: the value when it is a single string, else `''`.

### Static page

After the API routes:

| Situation | Behaviour |
|---|---|
| `staticDir` given and exists | `express.static(staticDir, { index: false })`, then every GET whose path does not start with `/api/` gets `staticDir/index.html` (single-page fallback). |
| `devWebUrl` given (and no existing `staticDir`) | Every non-`/api/` GET is redirected (302) to `devWebUrl + originalUrl without its leading slash`. |
| `staticDir` given but missing | Every non-`/api/` GET returns 503, `text/plain`: ``Photo Tool has not been built yet. Run `npm run build:photo-tool`.`` |

`main.ts` passes `staticDir = webDir('photo-tool')` in production (`NODE_ENV=production` or the `--production` argument), else `devWebUrl = http://127.0.0.1:<PHOTO_TOOL_WEB_PORT>/`. The desktop host passes `staticDir = <resourceRoot>/web` when packaged, else the dev URL.

### Ports and environment (run from source)

| Variable | Default | Meaning |
|---|---|---|
| `PHOTO_TOOL_PORT` | `5176` | API port. |
| `PHOTO_TOOL_WEB_PORT` | `5175` | Vite dev server port (development only). |
| `NODE_ENV=production` or `--production` | off | Serve the built page instead of redirecting to Vite. |
| `PHOTO_TOOL_DATA_DIR` | | The data dir, used as given. |
| `PHOTO_TOOL_PROFILE_DIR` | | When only this is set, the data dir is `<profile>-data`. |
| `PHOTOINFO_FALLBACK_DIR` | | The shared fallback folder for read-only photo folders. |
| `PHOTO_TOOL_FAKE_TAGGING=1` | off | End-to-end tests only: fake tagging models served from memory (`photo-tool/tests/support/fakeTagging`), with 40 ms delays. |
| `PHOTOBOOK_RESOURCE_ROOT` | | A packaged resource folder (see below). |

### Data dir

`resolveDirs(env, root)` (`photo-tool/server/dirs.ts`), when run from source, where `root` is the project folder (the nearest folder above the started script, or above the working directory, that holds `node_modules/@fontsource`):

- `dataDir` = `PHOTO_TOOL_DATA_DIR` (resolved), else `<PHOTO_TOOL_PROFILE_DIR>-data`, else `<root>/data/photo-tool`.
- `photoInfoFallbackDir` = `PHOTOINFO_FALLBACK_DIR` (resolved), else `<root>/data/photoinfo-shared`.

Before opening, `carryOverDevDataOrQuit` (`shared/server/devData.ts`) moves the old one-folder layout once: `./data/gallery` is renamed to `./data/photo-tool`, and `./data/photoinfo` to `./data/photoinfo-shared`. A part is skipped when any of its variables is set (`PHOTO_TOOL_DATA_DIR`/`PHOTO_TOOL_PROFILE_DIR`; `PHOTOINFO_FALLBACK_DIR`). Nothing is copied, merged or deleted. If the new folder exists already, the old one is left and a warning names it. If a rename fails, the process prints the error and exits with code 1.

In the desktop app (`shared/electron/config.ts`, env prefix `PHOTO_TOOL`):

- `dataDir` = `PHOTO_TOOL_DATA_DIR`, else `<appData>/<productName>/data`. From source the folder name gets a ` Dev` suffix. With only `PHOTO_TOOL_PROFILE_DIR` set, it is `<profile>-data`. A self-test uses `<out>/data`.
- `photoInfoFallbackDir` = `PHOTOINFO_FALLBACK_DIR`, else `<appData>/Photo Tools Shared/photoinfo` (`Photo Tools Shared Dev` from source). A self-test uses `<out>/photoinfo-shared`.

Contents of the data dir:

| Path | What | Kind |
|---|---|---|
| `gallery.sqlite` (+ `-wal`, `-shm`) | The catalogue. | Cache |
| `thumbs/<key>_s.jpg`, `thumbs/<key>_m.jpg` | Thumbnails, 400 px and 1600 px. | Cache |
| `derived/<sha256>.jpg` | Decoded JPEG copies of HEIC photos. | Cache |
| `edits/<uuid>.<jpg/png/webp>` | Rendered edits waiting to be moved into place by the desktop shell; swept after 1 hour. | Temporary |
| `tagging.json` | Chosen tagging models: `{ "describe": string/null, "keywords": string/null, "paused": boolean }` (pretty-printed, written as `tagging.json.tmp` and then renamed). `paused` is always written as `false`. | Settings |
| `models/<id>/...` | Downloaded tagging models. | Downloads |

The photo folders themselves hold the sources of truth: `photoinfo.json`, `phototool-tags.json` and `phototool-tags.vectors.json`.

### Resource files

`shared/server/resources.ts` says where run-time files are. Photo Tool's server needs:

| File | From source | With a resource root |
|---|---|---|
| Built page | `<project>/dist/photo-tool/web` | `<root>/web` |
| World atlas (for `/api/places`) | `<project>/node_modules/world-atlas/countries-10m.json` | `<root>/world-atlas/countries-10m.json` |
| libheif (HEIC decoder) | `<project>/node_modules/libheif-js/libheif-wasm/libheif-bundle.js` | `<root>/libheif/libheif-bundle.js` |

The resource root comes from `setResourceRoot()` (the `resourceRoot` option), else `PHOTOBOOK_RESOURCE_ROOT`. The desktop host checks that `web/index.html`, `world-atlas/countries-10m.json` and `libheif/libheif-bundle.js` exist, and fails at start with `App files are missing:` followed by the list.

### Security

The server's protections, in full:

1. **Bound to `127.0.0.1` only.** It is never reachable from the network.
2. **CSP header** on every response (above).
3. **Per-route gates** that limit which paths a route will touch (below).
4. **It never writes photo files.** The only files it writes are in the data dir, the `photoinfo.json`/`phototool-tags*.json` sidecars (and their temp files) in photo folders, and the fallback folder.

There is **no auth token, no session, and no `Origin` or `Host` header check.** Any local process can call the API.

Gates by route:

| Gate | Routes |
|---|---|
| None: any folder path | `POST /api/gallery/open` (any readable directory). |
| Any photo ever catalogued (a row in `photos`, from any session) | `GET /thumb` (by key), `GET /image`, `POST /drag-check`, `PATCH /info`, `POST /removed` (and only when the file is gone from disk). |
| The open folder only (the last job opened) | `GET /full`, `POST /edit/render`, `POST /file-check`, `POST /refresh` (and only inside the job's root, or directly in it for a non-recursive job), `POST /tagging/regenerate`, `POST /tagging/focus` and `POST /tagging/close` (ignored for another job). |
| Any of the 4 kept jobs | `GET /jobs/:id`, `POST /jobs/:id/cancel`, `GET /items`, `GET /stamp`, `GET /people`, `GET /orphans`, `GET /search`, `POST /forget` (the folder must hold a photo of a kept job). |

All route paths in the table are under `/api/gallery`.

`POST /forget` also refuses any file name containing `/` or `\`, so it cannot reach outside the named folder. The desktop shell adds its own gate for file actions: it calls `POST /api/gallery/file-check` first and then acts only on paths that are files (see "File actions").

## HTTP API

All bodies are JSON. "Job" means a scan job id returned by `POST /api/gallery/open`. The server keeps the last **4** jobs (`MAX_JOBS`); asking for an older one gives **404** `That folder is no longer open. Open it again.` "Open folder" means the last job opened.

### Shared types

```ts
interface GalleryPhoto {            // a catalogue row
  path: string;                     // absolute path of the photo file
  folder: string;                   // the job's root (the folder that was opened)
  fileName: string;                 // basename
  relDir: string;                   // '' for the root, else subfolder relative to it with '/' separators
  size: number;                     // bytes
  mtimeMs: number;                  // integer (rounded) modification time in ms
  width: number; height: number;    // after EXIF orientation is applied
  format: string;                   // media format id: 'jpeg' | 'png' | 'webp' | 'heif'
  capturedAt: string | null;        // EXIF wall-clock 'YYYY-MM-DDTHH:MM:SS', no zone
  gpsLat: number | null; gpsLon: number | null;
  camera: string | null;            // "Make Model"
  exif: PhotoExif | null;           // null only for rows cached before EXIF was read
  analysis: PhotoAnalysis | null;
  key: string;                      // sha1(path|size|mtimeMs), names the thumbnails
  contentKey: string | null;        // sha1 of the 1600 px thumbnail's pixels
}

interface PhotoExif { lens?: string; focalLength?: number; focalLength35?: number; aperture?: number;
  exposureTime?: number; iso?: number; exposureBias?: number; flash?: boolean; }

interface PhotoAnalysis {
  sharpness: number;            // variance of the Laplacian, 2 decimals
  meanLuma: number;             // 0..1, 3 decimals
  clippedShadows: number;       // fraction of pixels <= 8, 3 decimals
  clippedHighlights: number;    // fraction of pixels >= 247, 3 decimals
  dHash: string;                // 16 hex chars
  saliencyX: number; saliencyY: number;  // 0..1, 3 decimals
  avgColor?: [number, number, number];
  colorGrid?: number[];         // 27 numbers: a 3x3 grid of RGB, row-major
  transparent?: boolean;
}

interface PhotoTags {
  state: 'off' | 'waiting' | 'done' | 'failed';
  description: string | null;
  keywords: string[];                         // at most 12, best score first
  objects: { label: string; count: number }[];
  canRegenerate?: true;
}

interface GalleryItem extends GalleryPhoto {
  info: PhotoInfo;                            // the photo's photoinfo.json entry, {} when none
  tags: PhotoTags;
  infoSource: 'folder' | 'fallback' | 'none'; // where the folder's photoinfo came from
  infoError?: string;                         // the folder's photoinfo could not be read or parsed
  effectiveDate: string | null;               // info.date when it is a string, else capturedAt
  effectiveLat: number | null;                // info.location.lat when lat and lon are both numbers, else gpsLat
  effectiveLon: number | null;
}
```

**`itemsFor(photos)`** builds `GalleryItem`s. It reads each photo folder's `photoinfo.json` (or fallback) once per call, and looks up tags for all photos in one query. The entry is found by exact file name, else case-insensitively.

**`tagsOf(photos)`**, the `tags` field, works like this:

- With no model chosen in `tagging.json`, every photo gets `{ state: 'off', description: null, keywords: [], objects: [] }`.
- Otherwise it reads the catalogue's tag rows for the photos' content keys and all catalogue models.
  - For each chosen part (describe, keywords), the shown row is the chosen model's own row. If there is none yet, it is any `done` row of another model of the same part (the old model's results stay visible until the new one has looked).
  - `state` is `waiting` if a chosen model has no row, else `failed` if any chosen model's row failed, else `done`.
  - `description` and `objects` come from the describe row when it is `done`.
  - `keywords` come from the keywords row when it is `done`: sorted by score descending, the first 12 (`MAX_KEYWORDS`), labels only.
  - `canRegenerate: true` appears when the shown description is the chosen describe model's own.
  - Embeddings are never sent.

### Route table

| Method and path | Input | Success | Errors |
|---|---|---|---|
| `GET /api/health` | | 200 `{ ok: true, app: 'gallery' }` | |
| `GET /api/gallery/recent` | | 200 `[{ folder, recursive, openedAt, exists }]`: up to 12, newest first; `exists` = the path is a directory now | |
| `POST /api/gallery/open` | `{ folder: string, recursive?: boolean }` (`recursive` defaults to true; only `false` turns it off) | 202 `{ jobId }` | 400 `Choose a folder to open` (missing or not a string); 404 `Not a readable folder: <folder>` |
| `GET /api/gallery/jobs/:id?since=n` | `since`: integer ≥ 0, default 0 (non-numbers give 0, fractions are floored) | 200 `{ total, processed, startedAt, done, cancelled, errors: [{path, message}], items: GalleryItem[] }`; `items` are `job.photos.slice(since)` | 404 job not kept |
| `POST /api/gallery/jobs/:id/cancel` | | 200 `{ cancelled: boolean }` | 404 |
| `GET /api/gallery/items?job=` | | 200 `GalleryItem[]`: every photo of the job whose file still exists | 404 |
| `GET /api/gallery/thumb?key=&size=` | `size`: `s` or `m`, default `m` | 200 `image/jpeg` file, `Cache-Control: private, max-age=31536000, immutable` | 400 `size must be s or m`; 404 `Unknown photo` (no row with that key); 404 `Thumbnail not found` |
| `POST /api/gallery/drag-check` | `{ paths: string[] }` | 200 `{ paths: string[], icon: string/null }` | 400 `Expected { paths: string[] }` |
| `GET /api/gallery/image?path=` | | 200 `image/png`: full size, upright; `Cache-Control: no-store` | 404 `Unknown photo` (not catalogued or not on disk) |
| `POST /api/gallery/removed` | `{ paths: string[] }` | 200 `{ removed: string[] }` | 400 `Expected { paths: string[] }` |
| `POST /api/gallery/file-check` | `{ paths: string[] }` | 200 `{ paths: string[] }` | 400 `Expected { paths: string[] }` |
| `POST /api/gallery/edit/render` | `{ path: string, edit: PhotoEdit }` | 200 `{ file: string, format: 'jpeg'/'png'/'webp' }` | 400 `Expected { path, edit }`; 404 `That photo is not in the open folder any more.`; 400 `That edit is not valid.` |
| `POST /api/gallery/refresh` | `{ paths: string[] }` | 200 `GalleryItem[]`: the photos read again, in the order asked | 400 `Expected { paths: string[] }` |
| `GET /api/gallery/full?path=` | | 200 `image/jpeg`, quality 90, upright; `Cache-Control: private, max-age=3600` | 404 `That photo is not in the open folder any more.` |
| `PATCH /api/gallery/info` | `{ path: string, patch: object, job?: string }` | 200 `GalleryItem` plus `stamp?: { before, after }` | 400 `Expected { path, patch }`; 404 `Unknown photo`; 400 `That edit is not valid.`; 400 `scoreAdjust must be a whole number.`; 409 photoinfo write error |
| `GET /api/gallery/stamp?job=` | | 200 `{ stamp: string }` | 404 |
| `GET /api/gallery/people?job=` | | 200 `string[]` | 404 |
| `GET /api/gallery/orphans?job=` | | 200 `[{ folder, fileNames: string[] }]` | 404 |
| `POST /api/gallery/forget` | `{ folder: string, fileNames: string[] }` (at least one; non-empty strings) | 200 `{ removed: number }` | 400 `Expected { folder, fileNames }`; 404 folder not open; 400 `Can't look in <folder>, so nothing was removed.`; 400 `<names> is/are still in the folder, so nothing was removed.`; 409 write error |
| `GET /api/gallery/models` | | 200 `{ catalogue: ModelChoice[], installed: [{id, bytes, ok}], settings: {describe, keywords, paused}, notWorking: ('describe'/'keywords')[], downloading: {id, received, total}/null, error: string/null }` | |
| `POST /api/gallery/models/:id/download` | | 202 `{ id }` | 404 `No such model.`; 409 `Another model is downloading. Wait for it, or cancel it.` |
| `POST /api/gallery/models/download/cancel` | | 204 | |
| `DELETE /api/gallery/models/:id` | | 204 | 404 `No such model.` |
| `PUT /api/gallery/tagging/settings` | `{ describe: string/null, keywords: string/null, paused: boolean }` | 200 the settings | 400 `Choose a downloaded model of the right kind, or Off.` |
| `POST /api/gallery/tagging/close` | `{ job: string }` | 204 | 400 `Send the job.` |
| `GET /api/gallery/tagging/status` | | 200 `TaggingStatus` | |
| `GET /api/gallery/search?job=&q=` | | 200 `{ paths: string[] }` | 404 |
| `POST /api/gallery/tagging/focus` | `{ job: string, paths: string[] }` | 204 | 400 `Send the job and a list of paths.` |
| `POST /api/gallery/tagging/regenerate` | `{ job: string, path: string }` | 200 `PhotoTags` | 400 `Send the job and the photo path.`; 404 `That folder is no longer open. Open it again.`; 404 `That photo is not in the open folder any more.`; 409 (see below); 500 backend failure |
| `GET /api/places` | | 200 `[{ id, name }]`, sorted by name | |
| `POST /api/places/suggest` | `{ points: [lon, lat][] }` | 200 `[{ id, name, photos }]`, most photos first | |

### Route details

**`POST /api/gallery/open`**

1. `scanner.open(folder, recursive)` resolves the path and checks that it is a directory. If not, it returns 404 `Not a readable folder: <folder as given>`.
2. Every scan still running is marked cancelled.
3. A new job is made and recorded in the recent list (`touchRecent`), and the scan starts in the background.
4. The job id is appended to `jobIds`. The oldest ids are dropped from the scanner's memory while there are more than 4.
5. The tagging queue's job is cleared (it stops after the photo in hand).
6. `albumStore.flush()` writes waiting sidecar changes, and `albumStore.invalidate()` drops the cached sidecar indexes, so another computer's changes are seen.
7. The reply is 202.

A missing folder that was opened before stays in the recent list, with `exists: false` (test: "404s a missing folder with a message and keeps it in the recent list as missing").

**`GET /api/gallery/jobs/:id`**: `done` is read before the items are built, so a photo that lands after that line is picked up by the next poll. The page polls with `since` = the number of items already received, until `done`, then polls once more (test: "opens a folder and pages the items with since=n, each photo exactly once"). This route does not filter out deleted files; `/items` does.

**`job.photos` order** is completion order (4 workers in parallel), not the walker's sorted order. It is normally only appended to. However, `/removed` splices entries out, and `/refresh` replaces an entry in place or appends one. A page paging with `since` while either happens can miss or repeat a photo. The page reloads all items with `/items` after changes.

**`POST /api/gallery/jobs/:id/cancel`**: each scan worker finishes the photo in hand and takes no other. The job keeps the photos read so far and ends with `done: true, cancelled: true`. A finished job is left as it is.

**`GET /api/gallery/items`**: all photos of the job whose file exists (`existsSync`). A photo deleted since the scan drops out, but its `photoinfo.json` entry is kept (nothing is written); `/orphans` and `/forget` offer to remove it.

**`GET /api/gallery/thumb`**: looks up the row by `key` (any catalogued photo). The key changes whenever the file changes, so the reply may be cached for good.

**`POST /api/gallery/drag-check`** (desktop shell, before dragging files out):

- Takes the first 500 paths (`DRAG_MAX`).
- Keeps those with a catalogue row (exact path match), in the order asked. A HEIC is its own `.heic` path, never the derived JPEG.
- `icon` is the first kept photo's `thumbs/<key>_s.jpg` path if that file exists, else null.
- Any photo ever catalogued passes, including ones from folders opened in earlier sessions.

**`GET /api/gallery/image`** (desktop shell, "Copy image"): any catalogued photo that exists on disk. It gets the working file (the HEIC's derived JPEG when needed), applies `sharp(...).rotate()` and returns PNG. It is rendered on every request.

**`POST /api/gallery/removed`** (desktop shell, after moving files to the Recycle Bin). For each of the first 500 paths:

- It skips the path when it has no catalogue row, or when the file still exists. This route never deletes a file, only what is known about it.
- Otherwise it:
  1. deletes the catalogue row and both thumbnails;
  2. splices the photo out of every kept job;
  3. removes its entry from the folder's `photoinfo.json` (`forgetPhotos`). A `PhotoInfoWriteError` is swallowed; the entry stays and `/orphans` will offer it later.

It replies with the paths it forgot.

**`POST /api/gallery/file-check`** (desktop shell, before copy, show in folder, delete, save edit): the first 500 paths that are photos of the open folder (exact path match), in the order asked. It is stricter than drag-check: a folder opened before the current one is refused, even though its scan is still kept (test: "file-check passes only photos of the folder open now, in the order asked").

**`POST /api/gallery/edit/render`**:

1. Requires a photo of the open folder.
2. `parseEdit(edit)` must succeed.
3. Creates `<dataDir>/edits`, and deletes every file there whose mtime is more than 1 hour old (`EDIT_FILE_MAX_AGE_MS = 3 600 000`). Files that are gone or busy are skipped.
4. Format = `editFormatFor(photo.path)`: `jpeg`, `png` or `webp`; a HEIC gives `jpeg`.
5. File = `<dataDir>/edits/<randomUUID>.<jpg|png|webp>`.
6. Renders with `renderEdited(workingFile, edit, file, format, { keepMetadata: true })`.
7. Replies `{ file, format }`.

The caller moves the file into place.

**`POST /api/gallery/refresh`**: for each of the first 500 paths, `scanner.refresh(lastJobId, path)` re-reads the photo, ignoring the cache. It returns null, and the path is left out of the reply, when:

- the path is not inside the job's root (by `path.relative`: empty, starting with `..`, or absolute);
- the job is not recursive and the path is in a subfolder;
- it is not a supported format;
- it is not a regular file.

A re-read photo replaces its entry in the job, or is appended if new. It wakes the tagging queue and triggers `onPhoto` (sidecar sync). Tests: "re-reads a changed photo: new key and size", "appends a new file inside the folder", "skips paths outside the folder, non-photos, and subfolders of a non-recursive job".

**`GET /api/gallery/full`**: a photo of the open folder that exists on disk. Returns `sharp(workingFile, { failOn: 'none' }).rotate().jpeg({ quality: 90 })`. It is rendered on every request; there is no server cache, only the HTTP `max-age=3600`.

**`PATCH /api/gallery/info`**:

1. `path` must be a string, and `patch` a non-array object. `path` must be catalogued (any session); it need not be in the open folder.
2. `edit` field: if present and not null, `parseEdit` must succeed (else 400). An identity edit (one that changes nothing) is stored as `null`, that is, the field is removed.
3. `scoreAdjust` field: if present and not null, it must be an integer with absolute value ≤ 100 000 (else 400). `0` is stored as `null` (removed).
4. Other fields pass through unvalidated. `null` (or `undefined`) removes a field; any other value replaces it.
5. **No-op check**: if the folder's photoinfo has no read error, and every field in the patch is null/undefined and absent from the photo's current entry, nothing is written. In particular, no `photoinfo.json` is created. Saving an edit into the photo file uses this to clear the edit after every save without touching the folder.
6. Otherwise `updatePhotoInfo(dir, fileName, patch)`. A `PhotoInfoWriteError` becomes **409** with its message.
7. With `job` (a kept job id), the reply's `stamp.before` and `stamp.after` are the job's folder stamp just before and after the write. The page can then tell its own write from another program's change.

Tests: "PATCH writes photoinfo.json beside the photo and keeps other entries and unknown fields", "keeps a star written by the editor between the gallery read and its own PATCH", "answers 409 with the write error when the file cannot be read", "stores an identity edit as a removal", "writes nothing for a removal of an edit the photo does not have", "stores a whole number, and 0 or null as no field".

**`GET /api/gallery/stamp`**: the job stamp is the sorted set of the job's photo folders, joined as `<folder>=<folderStamp(folder)>` with `|` between folders. `folderStamp` is described under `photoinfo.json`. It changes whenever any of those folders' `photoinfo.json` or fallback file changes. The page polls it to notice other programs' changes.

**`GET /api/gallery/people`**: over all photos of the job (deleted ones included), counts each distinct non-empty string in `info.people` once per photo. It returns the names sorted by count descending, then by `localeCompare`.

**`GET /api/gallery/orphans`**: for each photo folder of the job (sorted), it lists the folder. A folder that cannot be listed is skipped, because its photos are not known to be gone. It returns the `photoinfo.json` entry names whose file is not in the folder (compared case-insensitively), sorted. Folders with none are omitted.

**`POST /api/gallery/forget`**:

1. `folder` must equal the resolved parent of some photo in any kept job.
2. The folder is listed again. Any name that contains `/` or `\`, or that is still present (case-insensitive), refuses the whole request with 400: up to 3 names, then `…`, and "is" or "are".
3. Otherwise `forgetPhotos(folder, fileNames)`, which returns the number of entries removed (0 writes nothing).

**`GET /api/gallery/search`** (search by meaning):

1. Needs at least 3 letters (Unicode `\p{L}`) in the trimmed `q`; otherwise it returns `{ paths: [] }`.
2. Asks the tagging queue to embed the text with the chosen keywords model. If there is no working keywords model, or the model has no `meaningThreshold`, or the embedding fails, it returns `{ paths: [] }`.
3. Takes the job's photos with a content key whose file exists, and reads their picture embeddings for that model from the catalogue.
4. Scores each by cosine similarity (dot product over the common length divided by the product of the norms; 0 when either norm is 0).
5. Keeps scores ≥ `meaningThreshold` (0.27 and 0.24 for the two shipped keywords models, `photo-tool/core/tagModels.ts`), best first, at most 200 (`SEARCH_MAX`).

**Tagging routes** (behaviour in the tagging section):

- `POST /tagging/close` clears the queue's job if `job` is the open one, and always flushes the sidecars.
- `POST /tagging/focus` sets the queue's priority paths (first 1000) if `job` is the open one; otherwise it is ignored.
- `POST /tagging/regenerate` requires `job` to be the open job and the photo to exist. It returns 409 with one of:
  - `There is no working descriptions model. Choose one in Settings.`
  - `<label> has not described this photo yet.`
  - `<label> would not load. See Settings.`

  An empty caption is a 500 `<label> wrote an empty description. Try again.`
- `GET /tagging/status` returns `{ job, total, done, failed, paused, running, notWorking, stamp, problem }` (`TaggingStatus`, `photo-tool/server/tagging/queue.ts`).

**Model routes** (`photo-tool/server/models/routes.ts`):

- Only one download runs at a time.
- `PUT /tagging/settings` accepts, for each part, `null` or the id of an installed model of that part. Anything else, or a non-boolean `paused`, gives 400.
- Settings are saved with `paused: false`; Pause lives only in memory.
- Deleting the chosen model of a part sets that part to `null`.

**Places routes**:

- `/api/places` lists country and territory outlines from the bundled world atlas.
- `/api/places/suggest` keeps only points that are pairs of finite numbers, and takes the first 2000. For each point it finds the place whose outline contains it, else the nearest outline vertex within 0.1 degrees (about 10 km). It counts points per place, most first (`shared/server/placesLogic.ts`).

## The catalogue: `gallery.sqlite`

`<dataDir>/gallery.sqlite`, opened with Node's built-in `node:sqlite` (`DatabaseSync`, synchronous) by `Catalog` (`photo-tool/server/catalog.ts`). It belongs to Photo Tool only and is never the editor's database.

On open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

WAL with `synchronous = NORMAL` means a commit is not flushed to disk on its own. Opening an album then imports thousands of rows from its tags sidecar in well under a second. A power cut can lose at most the last commits of this cache, which the sidecars and a rescan rebuild.

### Schema

```sql
CREATE TABLE IF NOT EXISTS photos (
  path        TEXT PRIMARY KEY,
  folder      TEXT NOT NULL,      -- the root of the scan that last read it
  file_name   TEXT NOT NULL,
  rel_dir     TEXT NOT NULL,      -- '' or 'sub/dir' relative to folder
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,   -- rounded to whole ms
  width       INTEGER NOT NULL,   -- oriented
  height      INTEGER NOT NULL,
  format      TEXT NOT NULL,      -- media format id
  captured_at TEXT,
  gps_lat     REAL,
  gps_lon     REAL,
  camera      TEXT,
  exif        TEXT,               -- JSON PhotoExif, added by migration
  analysis    TEXT,               -- JSON PhotoAnalysis
  key         TEXT NOT NULL UNIQUE,
  content_key TEXT                -- added by migration
);

CREATE TABLE IF NOT EXISTS recent (
  folder    TEXT PRIMARY KEY,
  recursive INTEGER NOT NULL,     -- 0/1
  opened_at TEXT NOT NULL,        -- ISO 8601 UTC
  seq       INTEGER NOT NULL      -- increasing open counter
);

CREATE TABLE IF NOT EXISTS tags (
  content_key TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  status      TEXT NOT NULL,      -- 'done' | 'failed'
  description TEXT,
  keywords    TEXT,               -- JSON [{label, score}]
  objects     TEXT,               -- JSON [{label, count}]
  embedding   BLOB,               -- raw float32 values, platform byte order
  error       TEXT,
  made_at     INTEGER NOT NULL,   -- Date.now() at write
  PRIMARY KEY (content_key, model_id)
);

CREATE TABLE IF NOT EXISTS file_keys (
  path      TEXT PRIMARY KEY,
  size      INTEGER NOT NULL,
  mtime_ms  REAL NOT NULL,
  file_key  TEXT                  -- 'fk1:<size>:<sha1>'; nullable but only ever written with a key
);
```

There are no secondary indexes beyond the primary keys and the `UNIQUE(key)` constraint, and no schema version number.

### Migrations

The migrations are two column checks run on every open, using `PRAGMA table_info(photos)`:

- No `exif` column: `ALTER TABLE photos ADD COLUMN exif TEXT`. Rows read before EXIF was kept get it on their next scan.
- No `content_key` column: `ALTER TABLE photos ADD COLUMN content_key TEXT`. The content key is worked out on the next scan.

The `tags` and `file_keys` tables are created with `IF NOT EXISTS`. Test: "opens a cache made without the exif column and adds it".

### Operations

| Method | SQL / behaviour |
|---|---|
| `get(path)` | `SELECT * FROM photos WHERE path = ?` |
| `getByKey(key)` | `... WHERE key = ?` |
| `lookup(path, size, mtimeMs)` | `get`, and only if both `size` and `mtimeMs` are equal (the cache hit test) |
| `put(photo)` | `INSERT OR REPLACE` of every column; `exif`/`analysis` as JSON, or NULL |
| `remove(path)` | Deletes the row and both thumbnail files (missing files are fine). Never touches the photo. |
| `putTags(row)` | `INSERT OR REPLACE` into `tags`; `keywords`/`objects` JSON-encoded; `embedding` as the Float32Array's bytes; `made_at = Date.now()` |
| `setDescription(ck, model, text)` | `UPDATE tags SET description, made_at WHERE ... AND status = 'done'`; returns false when nothing changed (no row, or a failed row) |
| `tagsFor(cks, modelIds, withEmbedding=false)` | Rows for these models and keys, in batches of 500 keys (`IN_BATCH`); the embedding is selected as NULL unless asked for |
| `embeddings(cks, modelId)` | `tagsFor(..., true)`, keeping keys with an embedding |
| `fileKey(path, size, mtimeMs)` | The stored file key if size and mtime match: a string, null, or undefined when there is no matching row |
| `putFileKey(...)` | `INSERT OR REPLACE` |
| `thumbPath(key, size)` | `<dataDir>/thumbs/<key>_<s|m>.jpg` |
| `recentFolders()` | `ORDER BY seq DESC LIMIT 12` → `{ folder, recursive: boolean, openedAt }` |
| `touchRecent(folder, recursive)` | `seq = max(seq)+1`; `INSERT OR REPLACE`; then `DELETE WHERE seq <= next - 12` (keeps 12, `RECENT_MAX`) |

### What is a cache and what is a source of truth

| Data | Status |
|---|---|
| `photos` rows, thumbnails, `derived/` | Cache. A row is valid while path, size and mtime match. A row for a file that changed is overwritten on its next scan. Rows and thumbnails of deleted or changed files are not pruned, except through `/removed` (`Catalog.remove`); old thumbnails (under the old key) stay on disk. |
| `recent` | The only copy of the recent-folders list (a convenience, not photo data). |
| `tags` rows with `status = 'done'` | Cache of the tags sidecars (see `AlbumTags.sync`). When the catalogue and the sidecar disagree about the same picture and model, the sidecar wins. Embeddings are also written to the vectors sidecar. |
| `tags` rows with `status = 'failed'` | Catalogue only (never written to sidecars). After a move to another computer, the photo is tried again. |
| `file_keys` | Cache of file fingerprints, so a later run does not read the photo again while its size and mtime stay the same (test: "a later run (a new AlbumTags) does not read the photo file again while it is unchanged"). |

## Keys

| Key | Formula | Changes when | Used for |
|---|---|---|---|
| **Photo key** (`key`) | `sha1("<path>|<size>|<mtimeMs>")` as hex, where `mtimeMs` is `Math.round(stat.mtimeMs)` | the path, the size or the mtime changes | Thumbnail file names; the `/thumb` URL (so it can be cached as immutable) |
| **Content key** (`contentKey`) | `sha1` of the raw pixel bytes of the 1600 px thumbnail as decoded by sharp: `sharp(thumbs/<key>_m.jpg).removeAlpha().raw().toBuffer()` (8-bit RGB, row-major) | the picture changes | Matching tag results to pictures on this computer; the same after a rename, a move or a metadata-only rewrite |
| **File key** (`fileKey`) | `"fk1:<size>:" + sha1("<size>\0" + first 16 KiB + last 16 KiB)` as hex. The tail is read only when size > 16 KiB, and is `min(16 KiB, size − 16 KiB)` bytes ending at end of file. | any byte in the head or tail changes, or the size changes | Matching tag results on another computer |
| **Content hash** | `sha256` of the whole original file, streamed | the file changes | Naming the decoded HEIC copy `derived/<sha256>.jpg`; only worked out when a handler needs it |

The content key depends on how this computer's sharp/libvips build decoded and encoded the thumbnail. It can therefore differ between computers, and is only a hint across machines (test: "the content key depends on how this computer encoded the thumbnail"). The file key depends on the file's bytes only. It is the same for a copy under another name, folder or modified time, and it reads at most 32 KiB (`shared/phototags/fileKey.ts`). `fileKeySize(key)` parses the size back out of `fk1:<size>:`.

## The walker

`listPhotos(root, recursive, readdir?)` (`photo-tool/server/walk.ts`) returns `{ files: string[], errors: {path, message}[] }`:

1. The root is read with `readdir(root, { withFileTypes: true })`. If that fails, it throws `GalleryFolderError("Can't read the folder <root>: <message>")`.
2. For each entry, in directory order:
   - A name starting with `.` is skipped (dotfiles and dot-folders).
   - A directory, when `recursive`, is read and walked depth-first. A subfolder that cannot be read (for example "System Volume Information" on a drive root) is added to `errors` and skipped; the walk continues.
   - A regular file is included when `isSupported(path)` is true. Symbolic links are neither files nor directories to `Dirent`, so they are skipped.
3. The result is sorted by full path with `a.localeCompare(b, undefined, { numeric: true })` (numeric order: `IMG_2` before `IMG_10`).

`isSupported(name)` (`shared/core/mediaFormats.ts`): the extension (last dot of the base name, lower-cased; a name like `.jpg` has no extension) is in the registry, and the base name does not start with `._` (macOS AppleDouble files).

Tests: "walks (supported files, no dotfiles, numeric order) and throws GalleryFolderError for an unreadable root", "skips a subfolder it may not read, reports it, and still reads the rest", "includes subfolders only when recursive".

**Stacks and RAW.** The walker and scanner do no pairing of any kind. No RAW format is registered (`MediaKind` allows `'raw'`, but no entry uses it), so RAW files are not listed at all, and there is no RAW+JPEG stacking. The grid's "stacks" are bursts of near-identical shots. They are grouped in the page from the analysis data (`groupId`, from `shared/core/curation.ts` via `photo-tool/core/gallerySort.ts`, folded by `photo-tool/core/galleryStacks.ts`), and are covered in the page section.

## The scanner

`Scanner` (`photo-tool/server/scanner.ts`), constructed with `(catalog, dataDir, { concurrency = 4, analyze?, readdir?, onDone?, onPhoto? })`.

```ts
interface ScanJob {
  id: string;               // randomUUID
  root: string;             // resolved folder
  recursive: boolean;
  total: number;            // files found by the walker
  processed: number;        // files finished (read or failed)
  startedAt: number;        // Date.now()
  done: boolean;
  cancelled: boolean;
  errors: { path: string; message: string }[];
  photos: GalleryPhoto[];   // completion order
}
```

### `open(root, recursive)`

1. Resolves `root` and checks that it is a directory. If not, it throws `GalleryFolderError("Not a readable folder: <root>")`.
2. Marks every running scan `cancelled`, including scans already forgotten.
3. Creates the job, records it as recent, starts `run(job)` without waiting, and returns the job.

### `run(job)`

```
{files, errors} = listPhotos(root, recursive)
job.errors += errors; job.total = files.length
next = 0
start `concurrency` workers, each:
  while next < files.length and not job.cancelled:
    file = files[next++]
    try   photo = readPhoto(job, file); onPhoto(photo); job.photos.push(photo)
    catch job.errors.push({path: file, message})
    job.processed++
(a failure of the walk itself is pushed as an error for the root)
job.done = true; onDone(job)
```

Files are taken in walker order, but finish in any order.

**In-flight sharing.** `readPhoto` keeps a map of photos being read now, by path. A second scan (for example the same folder opened twice) waits for the first read instead of reading the file again. It then takes a copy with its own `folder` and `relDir`, and writes the row again if those differ. Test: "a second open of the same folder cancels the first, and no photo is analysed twice".

### `scanOne(job, path, fresh = false)`

1. `fileStat(path)` gives `{ size, mtimeMs: Math.round(mtimeMs) }`.
2. **Cache hit**: `catalog.lookup(path, size, mtimeMs)` returns a row (skipped when `fresh`), and both thumbnails exist on disk. The scanner then:
   1. Takes the row with this job's `folder` and `relDir`.
   2. If `contentKey` is missing, works it out from the existing 1600 px thumbnail. A failure leaves it for next time.
   3. If `exif` is missing, calls `readMetadata(path)`. If the file could be read (`read: true`), it sets `exif` and `camera`. If not, the row is kept as it was and the read is tried again on the next scan (test: "keeps the cached row when the file cannot be read, and fills exif in once it can").
   4. Writes the row back only if something was upgraded, or `folder`/`relDir` changed.
3. **Cache miss** (or missing thumbnails, or `fresh`). The scanner then:
   1. `work = workingFile(path, dataDir, () => hashFile(path))`: the original, or the decoded HEIC copy.
   2. Runs these three in parallel:
      - `orientedSize(work.path)`: sharp metadata; width and height are swapped when EXIF orientation ≥ 5; throws `Could not read image dimensions` when either is 0.
      - `readMetadata(path)`: always reads the original.
      - `analyze(work.path)`.
   3. `key = photoKey(path, size, mtimeMs)`.
   4. Writes both thumbnails in parallel (`writeJpegThumb`).
   5. `format` comes from the extension's registry entry when the work file is a decoded copy; otherwise it is sharp's metadata format.
   6. `contentKey` comes from the new 1600 px thumbnail.
   7. `catalog.put(photo)`.

### Change detection and rescans

There is no file watcher. Change detection works like this:

- **On every open**: each file's path, size and rounded mtime are compared with its catalogue row. A match with thumbnails present is a hit; otherwise the file is read again. A file deleted between scans is not listed by the walker, so it is not in the job (test: "leaves out a file deleted between scans"). Its row stays in the catalogue.
- **`/items`** filters out files that no longer exist.
- **`/refresh`** re-reads named paths after the desktop shell changed them (an edit saved over a photo, a Save-as copy).
- **`/stamp`** detects changes to `photoinfo.json` by stat (mtime and size).
- The tags sidecars are re-checked by stat at most once a second during lookups, and re-read on every folder open (`invalidate`).

Tests: "reuses cached analysis when path, size and mtime are unchanged", "re-analyses only a file whose mtime changed".

### `refresh(jobId, path)`

Described under `POST /api/gallery/refresh`. It calls `scanOne(..., fresh = true)` and then `onPhoto`.

### EXIF reading

`readMetadata(originalPath)` (`shared/server/media.ts`):

1. Reads the whole file into memory (exifr is given bytes, not a path, because a path leaves file handles open, which Node 26.13+ treats as an error). A read failure returns everything null, `exif: {}`, `read: false`.
2. `exifr.parse(data, { reviveValues: false, pick: [DateTimeOriginal, CreateDate, DateTimeDigitized, ModifyDate, DateTime, Make, Model, LensModel, LensMake, FocalLength, FocalLengthIn35mmFormat, FNumber, ExposureTime, ISO, ExposureBiasValue, Flash] })`. A failure means no EXIF, which is fine.
3. `capturedAt`: the first of DateTimeOriginal, CreateDate, DateTimeDigitized, ModifyDate, DateTime that parses.
   - A string must match `^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})`, with a year other than `0000`. It becomes `YYYY-MM-DDTHH:MM:SS`, with no time zone.
   - A `Date` value is formatted from its local fields.
4. `camera`: trims Make and Model. With no Make, it is the Model or null. With no Model, it is the Make. If the Model starts with the Make (case-insensitive), it is the Model alone; else `"Make Model"`.
5. `exif` (`exifFromTags`):
   - `lens`: LensModel, prefixed with `LensMake + ' '` unless the model already starts with the make.
   - `focalLength`, `focalLength35`, `aperture` (FNumber), `exposureTime`: kept only when positive finite numbers.
   - `iso`: the first element if it is an array; kept only when positive.
   - `exposureBias`: any finite number.
   - `flash`: from a number, `(Flash & 1) === 1`; from a string, whether it starts with `Flash fired`.
   - Missing or nonsense values are left out.
6. GPS: `exifr.gps(data)`. Latitude and longitude are kept only when both are finite. A failure means no GPS.

### Image analysis

`analyze(workPath)` (`shared/server/media.ts`) runs once per photo per scan miss. The image is rotated upright, flattened on white, resized to fit inside 256×256 and converted to greyscale.

- **`sharpness`**: the variance of the 4-neighbour Laplacian `4c − l − r − u − d` over the interior pixels, rounded to 2 decimals.
- **`meanLuma`**: the mean of pixel/255, 3 decimals.
- **`clippedShadows`**: the fraction of pixels ≤ 8, 3 decimals.
- **`clippedHighlights`**: the fraction of pixels ≥ 247, 3 decimals.
- **Saliency**: for each interior pixel, the gradient `g = |r−l| + |d−u|`, weighted by `e = g² · exp(−(nx²+ny²)/(2·0.3²))`, where `nx = x/w − 0.5` and `ny = y/h − 0.5`. `saliencyX` and `saliencyY` are the e-weighted means of `x/w` and `y/h`, 3 decimals; both are 0.5 when the total weight is 0.
- **`dHash`**: the image is rotated, flattened, greyscaled and resized to exactly 9×8 (`fit: fill`). For each row and x = 0..7, the bit is `1` if `p[x] < p[x+1]`. The 64 bits become 16 hex digits (4 bits per digit, in order).
- **`avgColor`**: the image resized to 1×1 (RGB). **`colorGrid`**: the image resized to 3×3, the first 27 bytes, row-major RGB. Both are flattened on white.
- **`transparent`**: false without an alpha channel. Otherwise the image is resized to fit inside 256×256, and it is true if more than `w·h/200` pixels (0.5%) have alpha < 250.

## Thumbnails, full and working images

### Sizes and formats

`THUMB_SIZES = { s: 400, m: 1600 }` (longest side in px). `writeJpegThumb(workPath, size, outFile)`:

```
sharp(workPath, { failOn: 'none' })
  .rotate()                                   // EXIF orientation
  .resize(N, N, { fit: 'inside', withoutEnlargement: true })
  .flatten({ background: '#ffffff' })         // transparency onto white
  .jpeg({ quality: s ? 78 : 84, mozjpeg: true })
  .toFile(`${outFile}.${uuid}.tmp`)
rename(tmp, outFile)   // on failure, ignored if outFile exists (two writers at once)
rm(tmp, force)
```

Gallery thumbnails are always opaque JPEG. The editor's WebP thumbnails for cutouts (`makeThumbnails`, `existingThumb`) are not used by Photo Tool.

| Image | Route | Format | Server caching | HTTP caching |
|---|---|---|---|---|
| Small thumbnail (400 px) | `/thumb?size=s` | JPEG q78 mozjpeg | File in `thumbs/` | `private, max-age=31536000, immutable` |
| Medium thumbnail (1600 px) | `/thumb?size=m` | JPEG q84 mozjpeg | File in `thumbs/` | same |
| Full (zoom) | `/full` | JPEG q90, upright | None (rendered every time) | `private, max-age=3600` |
| Full for the clipboard | `/image` | PNG, upright | None | `no-store` |
| Decoded HEIC | (internal) | JPEG q95 with ICC | File in `derived/`, never removed | |

**In memory.** The server keeps no image cache in memory. On Windows, `sharp.cache({ files: 0 })` is set for the whole process, because libvips would otherwise keep files open, and an open file on Windows cannot be moved, renamed or deleted (that would lock the user's originals and the thumbnails). The page's own image cache is described in the page section.

### The working file

`workingFile(originalPath, dataDir, contentHash)` returns `{ path, derived }`. `path` is the file sharp should decode. `derived` is the decoded copy's path, or null when `path` is the original. It looks up the format's handler and calls `working()`, or `preview()` when there is no `working()`, with `{ derivedDir: <dataDir>/derived, contentHash }`. `contentHash` is called lazily, so a JPEG is never hashed. A file with no handler is returned as is.

### The media format registry

`shared/core/mediaFormats.ts` is the single table of formats. A guard test (`shared/tests/media-formats-guard.test.ts`) fails if an image-extension list or regex appears anywhere else.

```ts
type MediaKind = 'image' | 'raw' | 'video';
type SaveFormat = 'jpeg' | 'png' | 'webp';
interface MediaCapabilities { editInPlace: boolean; alpha: boolean; saveAs: SaveFormat; animated: boolean; }
interface MediaFormat { id: string; extensions: readonly string[]; mime: string; kind: MediaKind; label: string; capabilities: MediaCapabilities; }
```

| id | Extensions (first is the default) | MIME | Kind | Label | editInPlace | alpha | saveAs | animated | Handler |
|---|---|---|---|---|---|---|---|---|---|
| `jpeg` | `.jpg`, `.jpeg` | image/jpeg | image | JPEG | yes | no | jpeg | no | `sharpHandler('jpeg')` |
| `png` | `.png` | image/png | image | PNG | yes | yes | png | no | `sharpHandler('png')` |
| `webp` | `.webp` | image/webp | image | WEBP | yes | yes | webp | no | `sharpHandler('webp')` |
| `heif` | `.heic`, `.heif` | image/heic | image | HEIC | **no** (only as a copy) | no | jpeg | no | `heifHandler` |

The `id` equals sharp's `metadata().format` name, which the catalogue stores. Helpers:

- `extensionOf(name)`: lower case, with the dot; `''` for none or for a dot-file.
- `formatOf(name)`, `formatById(id)`.
- `SUPPORTED_EXTENSIONS`.
- `isSupported(name)`.
- `acceptAttribute()`: every MIME type and extension, comma-joined, for file inputs.

### Media handlers

`shared/server/mediaHandlers/index.ts`:

```ts
interface HandlerContext { derivedDir: string; contentHash(): Promise<string>; }
interface MediaHandler {
  id: string;
  preview(file, ctx): Promise<string | Buffer>;  // fast, good enough for thumbnails
  working?(file, ctx): Promise<string>;          // full quality; defaults to preview()
  image(file): Promise<Sharp>;                   // upright, decoded in memory, no cache
}
```

- `handlerFor(file)` looks the handler up by extension.
- `workingPath` throws when a handler's preview gives bytes and it has no `working()`.
- At module load, a format without a handler, or a handler without a format, throws. "Plug-in" means a module listed here, never code loaded at run time.
- `sharpHandler(id)`: `preview` returns the original path; `image` is `sharp(file, { failOn: 'none' }).rotate()`.

### The HEIC path

`heifHandler.preview(file, ctx)` (also used as the working file):

1. `out = <derivedDir>/<sha256 of original>.jpg`. If it exists, it is returned (cached for good, shared by every copy of the same bytes).
2. **macOS**: `/usr/bin/sips -s format jpeg -s formatOptions 95 <file> --out <out>`.
3. **Windows and Linux**: `heicToJpeg(file, out)` (`shared/server/heic.ts`):
   1. Decodes with libheif + libde265 compiled to WebAssembly (`libheif-js`), in a pool of worker threads. There are at most `min(4, max(1, availableParallelism() − 1))` workers. An idle worker is stopped after 10 s (`IDLE_MS`) to give back the decoder's memory. Workers are `unref`'d, so they never keep the process alive.
   2. The worker decodes the primary image as interleaved 8-bit RGB, with rotation and mirroring from the file already applied. It also copies the raw ICC colour profile when present (≤ 16 MiB).
   3. The pixels are encoded with sharp as JPEG quality 95.
   4. If there is an ICC profile, it is embedded as APP2 `ICC_PROFILE\0` segments straight after the SOI marker. Each chunk is at most 65 519 bytes, with sequence number and count bytes; at most 255 chunks.
   5. The result is written to `<out>.<uuid>.tmp`, then renamed. If the rename fails and `out` already exists, that is fine: the same photo under two names can be converted twice at once, and the first one home wins.
   6. Errors are reported as `Could not open this HEIC photo: <reason>`. A worker that exits or errors fails its job, and the pool carries on.
4. `heifHandler.image(file)` decodes in memory with libheif on every platform, without the colour profile (for small previews).

A HEIC photo's catalogue `format` is `heif` (from the extension, not the derived JPEG). `width` and `height` come from the derived JPEG. Thumbnails, `/full`, `/image`, analysis and edit rendering all read the derived JPEG. EXIF is always read from the original `.heic`.

## The photo edit model

`shared/core/photoEdit.ts` is a pure model, used by both the server (rendering) and the page (preview), so that what you see is what is saved.

```ts
type QuarterTurn = 0 | 90 | 180 | 270;
interface CropRect { x: number; y: number; w: number; h: number; }  // fractions 0..1 of the frame
interface PhotoEdit {
  rotate: QuarterTurn;     // clockwise quarter turns, degrees
  straighten: number;      // extra clockwise turn, degrees, -45..45
  crop: CropRect;
}
const IDENTITY_EDIT = { rotate: 0, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
```

Stored as JSON in `photoinfo.json` under the `edit` field, for example `{"rotate":90,"straighten":-2.5,"crop":{"x":0.1,"y":0.05,"w":0.8,"h":0.9}}`.

Steps, applied to the upright picture (EXIF orientation applied first):

1. Turn clockwise by `rotate`.
2. Turn by `straighten` about the centre, then keep the largest centred rectangle of the step 1 aspect ratio that lies wholly inside the turned picture (the "frame").
3. Cut out `crop`, given as fractions of the frame.

**`parseEdit(raw)`** returns `PhotoEdit | null`:

- Not an object, or `rotate` not one of 0/90/180/270: null.
- `straighten`: optional (default 0). If present it must be a finite number, which is clamped to [−45, 45].
- `crop`: optional (default the full frame). If present it must be an object with finite `x`, `y`, `w`, `h`. Then `w` and `h` are clamped to [0.01, 1], `x` to [0, 1 − w] and `y` to [0, 1 − h].
- Other fields are dropped.

**`isIdentityEdit(e)`**: `rotate === 0`, `straighten === 0`, and the crop is within 1e-4 of `{0, 0, 1, 1}`.

**`straightenScale(w, h, deg)`** = `min(1, min(w / (w·cos + h·sin), h / (w·sin + h·cos)))`, with `|deg|` in radians.

**`editPlan(w, h, e)`** (pixels):

```
t  = turnedSize(w, h, rotate)          // swap for 90/270
k  = straightenScale(t.w, t.h, straighten)
fw = max(1, round(t.w * k)); fh = max(1, round(t.h * k))
left   = clamp(round(crop.x * fw), 0, fw - 1)
top    = clamp(round(crop.y * fh), 0, fh - 1)
width  = clamp(round(crop.w * fw), 1, fw - left)
height = clamp(round(crop.h * fh), 1, fh - top)
→ { rotate, straighten, frame: {w: fw, h: fh}, extract: {left, top, width, height}, out: {w: width, h: height} }
```

**`editFormatFor(path)`** is the format's `saveAs`, or `jpeg` when the format is unknown. So JPEG stays JPEG, PNG stays PNG, WebP stays WebP, and HEIC becomes JPEG.

Other helpers in the same file are used only by the page:

- `editKey`: FNV-1a 32-bit of the rounded numbers, base 36.
- `rotateEditLeft`.
- `ASPECTS`: Free, Original, Square, 4:5, 3:2, 16:9.
- `fitCropToAspect`, `resizeCrop` (the smallest crop the handles can make is 5%).
- `editCss`.

### Rendering an edit on save

`renderEdited(workPath, edit, outFile, format, { keepMetadata })` (`shared/server/photoEditRender.ts`). Each step is a separate sharp pipeline, joined by lossless PNG buffers (`png({ compressionLevel: 0 })`), because sharp applies `rotate` and `extract` in a fixed order within one pipeline.

1. `upright = sharp(workPath, { failOn: 'none' }).autoOrient()`, as a lossless buffer.
2. `plan = editPlan(upright.width, upright.height, edit)`.
3. `step = sharp(upright).rotate(plan.rotate)`.
4. If `straighten ≠ 0`: `step = sharp(step).rotate(straighten, { background: '#000000' })`. This enlarges the canvas; the corners are black and are cut away in the next step.
5. `frameLeft = max(0, round((canvasW − frame.w)/2))`, and likewise `frameTop`.
6. Extract `left = min(frameLeft + extract.left, canvasW − 1)` and `top` likewise; `width = min(extract.width, canvasW − left)` and `height` likewise.
7. With `keepMetadata`, every step uses `keepExif()`, and the output gets `withMetadata({ orientation: 1 })`. The EXIF block is kept and the orientation is set upright.
8. Encoding: PNG default, WebP quality 95, or JPEG quality 95.
9. The file is written to `<outFile>.<uuid>.tmp` and renamed. The temp file is always removed. The function returns the written `{ width, height }`.

The server always calls it with `keepMetadata: true` from `/edit/render`.

## `photoinfo.json`

`photoinfo.json` holds what people say about their photos. It is shared, byte for byte, with the Photobook Editor (`shared/photoinfo/format.ts`, `shared/photoinfo/store.ts`).

### Location

- `<photo folder>/photoinfo.json`: one file per folder, covering the photos directly in that folder. A recursive scan reads one file per subfolder.
- Read-only folder fallback: `<PHOTOINFO_FALLBACK_DIR>/<sha1(normalised folder)>.json`. The normalised folder is `path.resolve(folder)`, lower-cased on Windows. The hash is hex.

### Shape

```ts
const PHOTOINFO_NAME = 'photoinfo.json';
const PHOTOINFO_FORMAT = 'photoinfo/1';

interface PhotoInfoFile {
  format: string;                        // 'photoinfo/1'; defaults to it when missing on read
  photos: Record<string, PhotoInfo>;     // keyed by file name only (no path); defaults to {} when missing
  folder?: string;                       // only in fallback files: the resolved folder path
  [extra: string]: unknown;              // kept
}

interface PhotoInfo {
  star?: boolean;                        // favourite
  people?: string[];                     // names
  date?: string;                         // ISO local date-time; overrides the EXIF date (effectiveDate)
  location?: { lat: number; lon: number; name?: string };  // overrides GPS (effectiveLat/Lon) when lat and lon are numbers
  description?: string;
  notes?: string;
  hidden?: boolean;                      // Photo Tool: hidden from the grid (H)
  edit?: PhotoEdit;                      // Photo Tool: an edit not yet saved into the file (never an identity edit)
  scoreAdjust?: number;                  // Photo Tool: integer nudge to the photo score (Up/Down); never 0
  [extra: string]: unknown;              // kept untouched on every write
}
```

The TypeScript interface declares only the first six fields. `hidden`, `edit` and `scoreAdjust` are written by Photo Tool through the same `PATCH /api/gallery/info` route. Every field is typed or set by people; none is generated. The server validates only `edit` and `scoreAdjust`; other fields are stored as sent.

Example:

```json
{
  "format": "photoinfo/1",
  "photos": {
    "IMG_0042.jpg": {
      "star": true,
      "people": ["Ana", "Ben"],
      "location": { "lat": 49.28, "lon": -123.12, "name": "Vancouver" },
      "edit": { "rotate": 0, "straighten": 1.5, "crop": { "x": 0, "y": 0.1, "w": 1, "h": 0.8 } },
      "myOtherTool": { "kept": true }
    }
  }
}
```

### Parsing

`parsePhotoInfo(text)`:

1. A leading BOM (U+FEFF) is stripped.
2. It must be valid JSON whose top level is a plain object. `photos`, if present, must be a plain object, and each entry must be a plain object. Otherwise it throws `PhotoInfoParseError` with one of: `Not valid JSON: …`, `Expected a JSON object at the top level`, `"photos" must be an object keyed by file name`, `The entry for "<name>" must be an object`.
3. A missing or non-string `format` is taken as `photoinfo/1`. There is no version check on read.

`serialisePhotoInfo` writes `JSON.stringify(file, null, 2) + '\n'`: pretty-printed, two-space indent, with a trailing newline, so the file diffs and hand-edits well.

### Reading

`readFolderInfo(folder, opts)` returns `{ photos, source: 'folder'|'fallback'|'none', error?, stamp }`:

1. **The fallback file wins whole when it exists.** It is only ever written from a load that already included the folder's own file, so it holds the full merged content.
2. Otherwise the folder's own file is read.
3. `ENOENT` or `ENOTDIR` means "none". Any other read error, or a parse error, gives `photos: {}` with `error` set, and the item carries `infoError`.

`infoFor(info, fileName)` looks the entry up by exact key, then case-insensitively.

### Writing

`updatePhotoInfo(folder, fileName, patch, opts)` is a read-merge-write of one entry:

1. **Re-read** the current content (fallback first, as above). This keeps changes another program (the editor) wrote since this program last read, and only the patched entry changes. If the current file is broken (unreadable or unparseable), it throws `PhotoInfoWriteError("<photoinfo.json in <folder> | The saved photo info for <folder> (<path>)> can't be read. Fix or delete it. (<error>)")`. A broken file is never overwritten. The route turns this into 409.
2. The entry key is the existing key that matches case-insensitively, else `fileName`.
3. For each patch field: `null` or `undefined` deletes it; anything else replaces it. This is a shallow merge per field (`people` and `location` are replaced whole).
4. An entry left empty is deleted from `photos`.
5. The whole file is written with `writeFolderInfo`.

`writeFolderInfo(folder, file, opts)`:

1. Atomic write to `<folder>/photoinfo.json`:
   1. Write the text (UTF-8) to `<folder>/.photoinfo.json.<pid>.<8 hex>.tmp`. There is no fsync. A failure here removes the temp file and is rethrown as is (its error code tells a read-only folder apart).
   2. Rename the temp file over the target. If the rename fails with `EPERM`, `EBUSY` or `EACCES` (the target is held open by OneDrive, Dropbox or an antivirus), it is retried after 50, 100, 150 and 200 ms (`RENAME_RETRY_MS`, about half a second in all, using a synchronous sleep). It then fails with `PhotoInfoWriteError("photoinfo.json in <dir> is in use by another program; try again.")`. Any other rename error gives `PhotoInfoWriteError("Could not write <target>: …")`. The temp file is removed. **A busy file is never sent to the fallback**, because the folder is writable.
2. On success, the fallback file (if any) is deleted: the folder is writable again.
3. If the write threw a plain error with code `EACCES`, `EPERM` or `EROFS` (the folder is read-only), the fallback directory is created, and `{ ...file, folder: resolve(folder) }` is written atomically to the fallback file. If that fails: `PhotoInfoWriteError("Could not write the fallback file either: …")`.
4. Any other error code gives `PhotoInfoWriteError("Could not write <folder>/photoinfo.json: …")`. In particular, a missing folder is never created and does not fall back (test: "update does not create a missing photo folder").

`forgetPhotos(folder, fileNames, opts)` removes the named entries (each matched case-insensitively), keeping other entries and unknown fields. It returns the count, and writes nothing when the count is 0. It uses the same re-read, broken-file and fallback rules.

`folderStamp(folder, opts)` is a stat-only change detector: `fallback:<mtimeMs-size or ->|folder:<mtimeMs-size or ->`, or `none` when neither file exists. A change to either file changes the stamp.

Tests (`shared/tests/photoinfo.test.ts`): "keeps unknown fields and entries", "null deletes a field and empty entries go", "two writers do not lose each other's changes", "broken file is never overwritten", "case-insensitive lookup reuses the key", "read-only folder falls back", "a later successful folder write removes the fallback file", "other write errors are not swallowed into the fallback", "a busy photoinfo.json (rename refused) is retried, not sent to the fallback", "a photoinfo.json that stays busy gives a clear error, no fallback and no temp file", "no temp files left behind".

## The tags sidecars: `phototool-tags.json` and `phototool-tags.vectors.json`

These hold only generated data: what the tagging models said about each photo, and the keywords model's picture embeddings. They can be deleted and made again. `photoinfo.json` stays for what people type. The format is defined in `shared/phototags/format.ts`, the writer in `shared/phototags/store.ts`, and the catalogue sync in `photo-tool/server/tagging/albumTags.ts`.

### Location

| File | Folder copy | Fallback copy (read-only folder) |
|---|---|---|
| Tags | `<photo folder>/phototool-tags.json` | `<PHOTOINFO_FALLBACK_DIR>/phototool-tags/<sha1(normalised folder)>.json` |
| Vectors | `<photo folder>/phototool-tags.vectors.json` | `<PHOTOINFO_FALLBACK_DIR>/phototool-tags/<sha1(normalised folder)>.vectors.json` |

The normalised folder is the same as for photoinfo: `resolve(folder)`, lower-cased on Windows. The fallback files are in a subfolder, so they never collide with photoinfo fallback files (test: "never writes the photoinfo fallback files").

### Shapes

```ts
const PHOTOTAGS_NAME = 'phototool-tags.json';
const PHOTOTAGS_FORMAT = 'phototool-tags/1';
const PHOTOVECTORS_NAME = 'phototool-tags.vectors.json';
const PHOTOVECTORS_FORMAT = 'phototool-vectors/1';

interface PhotoTagsFile {
  format: 'phototool-tags/1';
  photos: Record<string /* file name, no path */, PhotoTagsEntry | unknown>;  // unreadable entries kept as they are
  folder?: string;                 // fallback copy only: resolved folder path. Never in the album's own file.
  [extra: string]: unknown;
}
interface PhotoTagsEntry {
  models: Record<string /* model id */, TagResult>;
  [extra: string]: unknown;
}
interface TagResult {
  contentKey: string;              // required; a result without a string contentKey is skipped on read (kept in the file)
  fileKey?: string;                // 'fk1:<size>:<sha1>'
  description?: string;            // describe models
  objects?: { label: string; count: number }[];   // describe models; omitted when empty
  keywords?: { label: string; score: number }[];  // keywords models; omitted when empty
  madeAt?: string;                 // ISO time it was made
  [extra: string]: unknown;        // kept while the result is for the same picture
}

interface PhotoVectorsFile {
  format: 'phototool-vectors/1';
  photos: Record<string, { models: Record<string, VectorEntry>; [extra: string]: unknown } | unknown>;
  folder?: string;                 // fallback copy only
  [extra: string]: unknown;
}
interface VectorEntry {
  contentKey: string;
  fileKey?: string;
  madeAt?: string;
  data: string;                    // base64 of the float32 values, little-endian
  [extra: string]: unknown;
}
```

Example tags file:

```json
{
  "format": "phototool-tags/1",
  "photos": {
    "IMG_0042.jpg": {
      "models": {
        "<describe model id>": {
          "contentKey": "3f9a…",
          "fileKey": "fk1:4183021:9b1c…",
          "description": "A dog running on a beach.",
          "objects": [{ "label": "dog", "count": 1 }],
          "madeAt": "2026-11-20T10:04:11.512Z"
        },
        "<keywords model id>": {
          "contentKey": "3f9a…",
          "fileKey": "fk1:4183021:9b1c…",
          "keywords": [{ "label": "beach", "score": 0.31 }],
          "madeAt": "2026-11-20T10:04:13.002Z"
        }
      }
    }
  }
}
```

**Serialisation.** The tags file is pretty-printed (`JSON.stringify(f, null, 2) + '\n'`). The vectors file is one line (`JSON.stringify(f) + '\n'`). `encodeVector` writes each float as 4 little-endian bytes and base64-encodes the result. `decodeVector` returns null for an empty buffer or a length that is not a multiple of 4.

**Versioning.** On parse (shared by both files):

1. A BOM is stripped.
2. It must be valid JSON, with a plain-object top level.
3. If `format` is present and differs from this version's string, it throws `PhotoTagsParseError('<name> is "<format>", made by a newer Photo Tool; this one reads "<expected>"')`. Another version's file is treated as broken, and so it is never rewritten in this version's shape.
4. A missing `format` is accepted.
5. `photos` must be a plain object (default `{}`).

**Reading results** (`resultsOf`):

- Entries without a `models` object are skipped, but kept in the file.
- Results without a non-empty string `contentKey` are skipped.
- Known fields of the wrong type are dropped from what is read: a non-string `fileKey` or `description`; non-array or malformed `objects`/`keywords` items are filtered out.

A vector is attached to a result only when it is under the same file name and model, and its `contentKey` matches or both carry the same `fileKey` (test: "a vector whose content key does not match its result is not given to it").

### Matching a result to a photo

`AlbumTagsStore.lookup(folder)` builds an index once per change of the folder's two files. The change is detected by a stat stamp, re-checked at most every 1 s (`RECHECK_MS`), and forced on folder open by `invalidate()`. The index maps:

- `byName`: `(lower-cased fileName, modelId)`;
- `byContent`: `(contentKey, modelId)`;
- `byFile`: `(fileKey, modelId)`;
- `fileSizes`: per model, the set of file sizes its file keys are for (`?` when a key has another shape).

`find(modelId, photo)`, where `photo = { fileName, contentKey, size, fileKey: () => string | undefined }`:

1. If the folder is unreadable, it returns nothing.
2. **A result waiting to be written** for this name and model, with the same content key, wins (it is the newest), together with its waiting vector or the old matching one.
3. The result under the photo's own name, if its content key matches.
4. Any result for this content key under another name (a renamed or copied photo).
5. **Another computer**: only if this model has file-keyed results for a file of this photo's size (or of unknown size), work out the photo's file key (this reads the file, or the cached `file_keys` row). Return the result under its own name if its file key matches, else any result with that file key.

Step 5 means a fully tagged album opens without reading any photo file (test: "a folder fully tagged here … syncs without working out a single file key"). A result whose content key and file key both differ from the photo's (the file was replaced or edited) is never used (test: "a result made from another picture (the file was replaced) is not given to the photo").

### Sync between sidecars and catalogue (`AlbumTags.sync`)

This runs for each photo as it is read (the scanner's `onPhoto` hook) and for photos held earlier. It groups photos with a content key by folder. For each folder:

1. **Unreadable** sidecar (locked by a sync engine, or a cloud file that is offline): the folder's photos are **held**. Nothing is imported and they are not tagged, because fresh output would only compete with what the file holds.
   - The hold lasts until the file can be read, or for at most 10 minutes (`maxHoldMs = 600 000`) from the first failure.
   - After that, tagging goes ahead; results stay in the catalogue and the file is still never written over.
   - The queue retries held folders (`retryDeferred`).
2. **Broken** sidecar (unparseable, or a newer format): nothing is imported and nothing is written.
3. Otherwise, for each photo and each model id (the catalogue's models plus every model id present in the file):
   - **No sidecar result, but a `done` catalogue row**: **migration**. The catalogue result is put into the sidecar (mode `keep`), with the photo's file key. Rows made before results were kept in album folders are written out once this way. Failed rows are never written.
   - **Sidecar result for a keywords model without a vector**: if the catalogue has a `done` row with an embedding, that embedding is used, and the result is put back to the sidecar with the vector and a file key. Otherwise the photo is left for the model to redo.
   - **Sidecar result found under another name** (renamed or copied): it is also put under the photo's current name, with the photo's file key.
   - If the sidecar result differs from the catalogue row (description, objects JSON, keywords JSON, or embedding), or the row is missing or failed, the catalogue row is overwritten (`putTags`). It is stored under **this computer's content key**, as `status: 'done'`. The sidecar wins. The changed content keys are returned, and the tagging queue forgets what it knew about them.

`AlbumTags.save(photos, row, mode)` is called by the tagging queue for each new `done` result (mode `keep`) and for Regenerate (mode `replace`). It puts the result to the sidecar of every open photo with that content key.

File keys are worked out lazily (`fileKeyOf`). They are memoised in memory per path, size and mtime, and kept in the catalogue's `file_keys` table. A file that cannot be read is not remembered, so it is tried again next run.

### Writing: merge rules

`put(folder, fileName, modelId, result, mode = 'keep')` queues an item in memory, keyed by `(lower-cased fileName, modelId)`, separately for the tags file and (when the result has a non-empty embedding) the vectors file. `madeAt` defaults to now (ISO). A queued `replace` is not undone by a later `keep` for the same picture.

When a file is written (`writeKind`):

1. Re-load and merge the folder copy and the fallback copy (below). If the result is broken, the write is `Blocked`: it is not retried until the file's stamp changes. If it is unreadable, the write fails and is retried later. **A file that cannot be read or parsed is never written over.**
2. For each queued item:
   1. The entry name is the existing name that matches case-insensitively, else `fileName`.
   2. An existing entry that is not an object, or whose `models` is present but not an object, is left alone and reported: `The entry for <name> in <file> can't be read, so it was left alone.`
   3. "Same picture" means the existing result has the same `contentKey`, or the new result has a `fileKey` equal to the existing `fileKey`.
   4. **Same picture and mode `keep`: the folder's result wins.** It only gains the new `fileKey` if it lacked one; otherwise nothing changes.
   5. Otherwise, in the tags file the result is replaced. If it is the same picture (a Regenerate), its unknown fields are kept and its known fields (`contentKey`, `fileKey`, `description`, `objects`, `keywords`, `madeAt`) are replaced. If it is a different picture, it is replaced whole.
   6. In the vectors file: `{ ...(same picture ? old : {}), contentKey, fileKey?, data: base64, madeAt }`.
   7. Other entries, other models, unknown top-level and entry fields are kept.
3. Write (below).

### Writing: timing, debounce and back-off

Each folder has two independent queues, one per file. Constants (`AlbumTagsOptions` defaults):

| Name | Default | Meaning |
|---|---|---|
| `debounceMs` | 60 000 | Write once results have stopped coming for this long. |
| `maxWaitMs` | 300 000 | ...or at the latest this long after the first waiting result. |
| `retryMs` | 30 000 | First wait after a failed write. |
| `maxRetryMs` | 600 000 | The wait doubles up to this. |
| `unreadableRetryMs` | 10 000 | How long an unreadable folder's index is trusted before reading again. |
| `RECHECK_MS` | 1 000 | How often a cached index is re-statted during lookups. |
| rename retries | 50, 150 ms | For a busy target (`EPERM`, `EBUSY`, `EACCES`). |

- **Schedule.** Due = `min(now + debounceMs, firstAt + maxWaitMs)`. After a failure, due = `retryAt`. Timers are `unref`'d, so they never keep the process alive.
- **Failure.** `failures++`, then `retryAt = now + min(retryMs · 2^(failures−1), maxRetryMs)`. The error is reported with `console.warn("Photo Tool could not save tags for <folder>: <message>")`, once per distinct message. A blocked (unparseable) file is re-checked by stat on each back-off and written only once its stamp changes.
- **Folder gone** (`ENOENT`/`ENOTDIR` on write: deleted, or a drive that is not connected): the queued results for that file are dropped quietly. The folder is never created and there is no fallback.
- **`flush(folder?)`** writes now, except files waiting out a back-off or blocked. It is called when a tagging pass ends or pauses, when a folder is opened (`/open`), and on `/tagging/close`.
- **`close()`** writes everything, ignoring back-off, and stops the timers. After `close()`, any `put` is written at once.
- After a write attempt, the folder's index is dropped, so it is rebuilt from disk.

Tests: "a photo every 10 s for 20 minutes is written about every 5 minutes, not after every photo", "once results stop coming, they are written a minute later", "later results do not retry at once; the tail is retried on its own, with a growing wait", "a broken tags file is not read again until it changes".

### Writing: atomic write and the fallback

`atomicWrite(target, text)`:

1. Write to `<dir>/~$<file name>.<8 hex>.tmp` (`~$` and `.tmp` are names OneDrive and Dropbox skip). Then `fsync` and close.
2. Rename over the target, retrying a busy target at 50 and 150 ms, then failing (`<target> is in use by another program, or marked read-only`). The temp file is removed.
3. A rename failure never goes to the fallback, because the folder is writable.

Before the first write to a folder in a run, our leftover temp files are deleted. They match `^(~\$|\.)phototool-tags(\.vectors)?\.json\.[0-9a-f.]+\.tmp$`, case-insensitive, which also covers the first version's dot-prefixed names.

`writeFile(folder, kind, file, hadFallback)`:

1. The top-level `folder` field is stripped: **the album's own file never carries a local path.**
2. It writes to the folder. On success, if a fallback existed, the fallback is deleted (the folder copy now has everything).
3. If the error code is `EACCES`, `EPERM` or `EROFS`, it creates `<fallbackDir>/phototool-tags/` and writes `{ ...file, folder: resolve(folder) }` there. If that fails: `<folder> is read-only, and the fallback file could not be written either: …`.
4. `ENOENT` or `ENOTDIR` means the folder is gone (drop quietly). Any other code: `Could not write <path>: …`.

**Merge on read** (`mergeFiles`): both copies are loaded. If either is unreadable or broken, that state wins: the folder copy is checked first, then the fallback, unreadable before broken. Otherwise they are merged **entry by entry**:

- Top-level fields: fallback fields (minus `folder`), overridden by folder fields.
- An entry only in the fallback is added.
- For an entry in both, if either side's entry cannot be read, the folder's entry is kept. Otherwise, per model, the fallback result is taken when the folder lacks that model, or when **both have a `madeAt` and the fallback's is later** (newer wins). Otherwise the folder's result is kept.
- Entry-level fields: the fallback's fields, overridden by the folder's.

So nothing another device wrote to the folder meanwhile is lost, and the fallback is removed after the first successful folder write. This differs from `photoinfo.json`, where the fallback file wins whole.

Tests: "a read-only folder falls back to the shared fallback folder, and back again once writable", "merges entry by entry: what another device wrote to the folder meanwhile is kept, a newer fallback entry wins", "a file that could not be read is never written over", "the temp file has a name sync engines skip (~$... .tmp), and old leftovers are cleaned up on the next write".

### Matching on another computer

When an album is copied to another computer (or the app is reinstalled):

1. Opening the folder reads the sidecar.
2. For each photo, the result is first looked up by content key. On another computer this usually misses, because the thumbnail encoding differs.
3. It is then looked up by file key, which only works if a result of that model exists for a file of the same size.
4. A match is imported into the catalogue under this computer's content key, so the photo is not tagged again (test: "a moved or reinstalled album shows its tags at once, and its photos are not tagged again").
5. The entry in the file keeps its original content key, and the file is not rewritten for it (test: "a result made on another computer (other content key) is found by the file key; its key in the file is left as it was").

## File actions (server's part)

The desktop shell (`photo-tool/electron/gallery.ts`, `fileActions.ts`, `drag.ts`, `editActions.ts`) does all file operations. It calls the server on `http://127.0.0.1:<port>` with these timeouts:

| Constant | Value |
|---|---|
| `DRAG_CHECK_TIMEOUT_MS` | 3 s |
| `FILE_CHECK_TIMEOUT_MS` | 3 s |
| `REMOVED_TIMEOUT_MS` | 10 s |
| `IMAGE_TIMEOUT_MS` | 60 s |
| `EDIT_TIMEOUT_MS` | 120 s |
| `REFRESH_TIMEOUT_MS` | 60 s |

The page's request is first trimmed to non-empty strings, at most 500 (`MAX_DRAG_FILES`).

| Action | Server calls | Notes |
|---|---|---|
| **Move to Recycle Bin / Trash** | `POST /file-check`, then (shell: native confirm; `shell.trashItem` per file) `POST /removed` with the trashed paths | The confirm names one file or the count; "Cancel" is the default button; the button says "Recycle Bin" on Windows and "Trash" elsewhere. Files that fail stay put and are reported. If `/removed` fails, the files are still reported as trashed, and `/items` leaves missing files out anyway. A delete is only ever `trashItem`. |
| **Show in folder (reveal)** | `POST /file-check` (one path) | Then `shell.showItemInFolder`. |
| **Copy image** | `POST /file-check`, then `GET /image?path=` (PNG) | The shell puts the PNG on the clipboard only if Electron can decode it. |
| **Copy path** | none | The shell writes the text to the clipboard; at most `500 × 4097` characters. |
| **Drag out** | `POST /drag-check` | Called on pointerdown (prepared; valid for 10 s for exactly the same list in the same order) or on dragstart. The shell keeps catalogued paths that are files. The icon is the first photo's 400 px thumbnail scaled to 128 px on its long side, or a grey 48 px square. Any catalogued photo may be dragged, not only those of the open folder. |
| **Save edit into the photo file** | `POST /file-check`; `POST /edit/render`; (shell: trash the original, move the rendered file into place, across drives by copy-and-rename); `PATCH /info { edit: null }`; `POST /refresh` | Refused for formats with `editInPlace: false` (HEIC: `HEIC photos can only be saved as a copy.`). If the reply's `format` is not `editFormatFor(path)`, the save is abandoned. |
| **Save as** | `POST /file-check`; `POST /edit/render`; (shell: Save dialog, move into place); `POST /refresh` with the new path; if it is in the open folder, `PATCH /info` with `{ edit: null, star, people, date, location, description, notes }` | The default name is `<name>-edited<ext>` (the format's default extension for copy-only formats). A target equal to the original is refused. |

## Constants

| Name | Value | Source |
|---|---|---|
| `MAX_JOBS` | 4 scan jobs kept in memory | `photo-tool/server/app.ts` |
| `DRAG_MAX` | 500 paths per drag-check, file-check, removed, refresh | `app.ts` |
| `EDIT_FILE_MAX_AGE_MS` | 3 600 000 (1 h) | `app.ts` |
| `MAX_KEYWORDS` | 12 | `app.ts` |
| `SEARCH_MAX` | 200 | `app.ts` |
| Search minimum | 3 Unicode letters | `app.ts` |
| `scoreAdjust` bound | integer, abs ≤ 100 000 | `app.ts` |
| JSON body limit | 1 MB | `app.ts` |
| Default ports | API 5176, web 5175 | `photo-tool/server/main.ts` |
| `RECENT_MAX` | 12 | `photo-tool/server/catalog.ts` |
| `IN_BATCH` | 500 keys per SQL `IN` | `catalog.ts` |
| Scanner concurrency | 4 | `photo-tool/server/scanner.ts` |
| `THUMB_SIZES` | s = 400, m = 1600 px | `shared/server/media.ts` |
| Thumbnail JPEG quality | s = 78, m = 84 (mozjpeg) | `media.ts` |
| `/full` JPEG quality | 90 | `app.ts` |
| HEIC derived JPEG quality | 95 (sips and libheif) | `shared/server/mediaHandlers/heic.ts`, `shared/server/heic.ts` |
| HEIC workers | `min(4, max(1, availableParallelism() − 1))`, idle stop 10 s | `heic.ts` |
| Edit render quality | JPEG 95, WebP 95, PNG default | `shared/server/photoEditRender.ts` |
| Straighten range | −45..45° | `shared/core/photoEdit.ts` |
| Parsed crop minimum | 0.01; handles minimum 0.05; identity tolerance 1e-4 | `photoEdit.ts` |
| Analysis render | 256 px greyscale; dHash 9×8; shadows ≤ 8; highlights ≥ 247; saliency σ 0.3; transparency > 0.5% of pixels with alpha < 250 | `media.ts` |
| Tagging threads | `max(1, floor(cpus/2))` | `app.ts` |
| `FILE_KEY_VERSION`, part size | `fk1`, 16 KiB head + 16 KiB tail | `shared/phototags/fileKey.ts` |
| photoinfo rename retries | 50, 100, 150, 200 ms | `shared/photoinfo/store.ts` |
| Tags sidecar timings | debounce 60 s, max wait 5 min, retry 30 s doubling to 10 min, unreadable retry 10 s, recheck 1 s, rename retries 50 and 150 ms | `shared/phototags/store.ts` |
| Hold for an unreadable sidecar | 10 min | `photo-tool/server/tagging/albumTags.ts` |
| Focus paths kept | 1000 | `photo-tool/server/tagging/queue.ts` |
| Place suggestion | first 2000 points, nearest within 0.1° | `shared/server/placesLogic.ts` |

### Open points

1. **The fallback path can leak into a folder's own `photoinfo.json`.** When a read-only folder becomes writable again, `loadForWrite` returns the fallback file, which has a top-level `folder` field holding the absolute local path. `writeFolderInfo` then writes it to `<folder>/photoinfo.json` as an unknown field and keeps it there for good. The tags sidecars strip `folder` explicitly; `photoinfo` does not. This looks like an oversight. No test checks for it.
2. **No auth token and no `Origin`/`Host` check.** The only protections are the `127.0.0.1` bind and the CSP. A DNS-rebinding page or any local process could call the API, for example `GET /image?path=` for any catalogued photo, or `PATCH /info`.
3. **The gates are inconsistent.** `PATCH /info`, `GET /image`, `GET /thumb` and `POST /drag-check` accept any photo ever catalogued, while `/full`, `/edit/render` and `/file-check` require the open folder. This may be intended (drag-check is documented as looser), but `PATCH /info` on a photo outside the open folder is not explained anywhere.
4. **Malformed JSON and bodies over 1 MB return 500, not 400**, because the error handler maps every non-`HttpError` to 500.
5. **`job.photos` is not strictly append-only.** `/removed` splices it and `/refresh` replaces entries in place, while `GET /jobs/:id?since=n` paging assumes it only grows. A photo can be skipped or repeated if either happens while a scan is being paged.
6. **Nothing is pruned from the catalogue.** Rows, thumbnails under old keys after a file changed, rows of files deleted outside the app, and every `derived/<sha256>.jpg` stay forever. There is no clean-up.
7. **Durability differs.** `photoinfo.json` writes do not fsync the temp file; the tags sidecars do.
8. **`photoinfo.json` has no version check.** Unlike the tags sidecars, a file with another `format` value would be read and rewritten (keeping its format string). Fields other than `edit` and `scoreAdjust` are not type-checked on write (for example, a non-boolean `star` is stored as sent).
9. **The catalogue's `tags.embedding` blob is in platform byte order** (the raw `Float32Array` bytes), while the vectors sidecar is explicitly little-endian. This only matters on a big-endian machine.
10. **Two minor inconsistencies.** `GET /people` counts photos whose files were deleted since the scan (it does not filter like `/items`). The `PhotoInfo` interface declares only six fields, although Photo Tool also writes `hidden`, `edit` and `scoreAdjust`.
11. **Symbolic links are skipped by the walker.** This follows from `Dirent.isFile()` and `isDirectory()` being false for links. No test or comment pins it, so it may not be deliberate.
12. **RAW+JPEG stacks do not exist in this code.** The brief mentions them, but no RAW format is registered and the server does no pairing. Stacks are burst groups built in the page.

