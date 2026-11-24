# Gallery Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate desktop program, Photobook Gallery, for picking from thousands of photos in a folder: a fast grid, sorting and filtering, a details panel that edits `photoinfo.json`, a full-screen viewer with one-key starring, and real file drags out to the editor, Explorer or anything else.

**Architecture:** One Electron build with two entry points. Launched with `--gallery`, the same executable becomes Photobook Gallery: its own name, user-data folder, single-instance lock, window and local server (`createGalleryApp`), and its own small SQLite cache of thumbnails and analysis keyed by path, size and mtime. It shares the image pipeline (`src/server/media.ts`, `heic.ts`), the pure curation code (`src/core/curation.ts`, `cleanup.ts`), place names, and `src/photoinfo`. It shares no database or book data with the editor. The only link between the programs is `photoinfo.json` (and its shared read-only fallback folder) plus ordinary file drags.

**Tech Stack:** TypeScript, React 19, Vite (second HTML entry), Express 5, node:sqlite, sharp, libheif-js, exifr, Electron 45 (`webContents.startDrag`), electron-builder (NSIS, deb, AppImage), vitest, Playwright.

**Spec:** [docs/superpowers/specs/2026-11-23-gallery-and-photo-info-design.md](../specs/2026-11-23-gallery-and-photo-info-design.md), Part 2 and "The photo info file". Part 1 is done and merged (main 27b366c).

## Global Constraints

- Original photo files are never written, renamed or moved. The only file the gallery writes beside photos is `photoinfo.json`, and only through `src/photoinfo` (`updatePhotoInfo`, plus the `forgetPhotos` added in Task 5).
- File name `photoinfo.json`, format `"photoinfo/1"`, photos keyed by file name. Unknown fields and entries for missing files are preserved on every write.
- Read-only folders use **the editor's** fallback folder so a star set in the gallery reaches the editor: `<editor dataDir>/photoinfo`, where the editor dataDir is `dataLayout({ productName: 'Photobook Studio', ... }).dataDir` (packaged `<appData>/Photobook Studio/data`, source run `<appData>/Photobook Studio Dev/data`, `PHOTOBOOK_DATA_DIR` respected). The interface says when a folder's info is kept there.
- Gallery data (cache DB, thumbnails, recent folders, window state) lives under its own `dataLayout({ productName: 'Photobook Gallery', ... })`; nothing is written to the editor's database.
- Fully offline: no new network access. `tests/core.test.ts` URL guard stays green; the gallery window gets the same `hardenSession`/`hardenContents` treatment and server binds `127.0.0.1` only.
- `src/core` stays free of node, react, express, sharp, server and web imports (existing architecture test); new pure gallery logic goes in `src/core/gallery*.ts`.
- Supported formats are exactly `SUPPORTED_EXTENSIONS` from `src/server/media.ts`.
- Keys in the viewer: Left/Right move, **S** star/unstar, **I** details, **Esc** close.
- Sorts: date taken (default), interesting, main colour, file name.
- Filters (combinable): starred / not starred, date range, low quality (blurry, dark, bright, low resolution, by `cleanupSuggestions` rules), near-duplicates, portrait / landscape, has location, has people, subfolder, text search over description and notes.
- Windows and Linux only. No web (browser-backend) version of the gallery.
- `npm run typecheck` and `npm test` pass at the end of every task.
- Commits: `git -c user.name="SWS-Chipkin" -c user.email="sws-dev@chipkin.com" commit ...` with trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit photos/, data/, trial-output/, dist/, .superpowers/.

## Review Focus

1. **A folder of several thousand photos.** Grid scrolls smoothly (virtualized) and reopening the folder is near-instant because nothing is re-analysed. Pinned by Task 1 (cache-hit test) and Task 4 (virtual window test).
2. **Both programs writing the same `photoinfo.json`.** A description saved in the gallery after the editor starred a photo keeps the star, and vice versa; the gallery picks up the editor's change within a few seconds. Pinned by Task 2 (external write preserved) and Task 4 (stamp poll).
3. **Read-only folder in the gallery.** Edits go to the editor's fallback folder, the editor's `PhotoInfoIndex` sees them, and the gallery shows that the info is kept elsewhere. Pinned by Task 2.
4. **Files changing under the gallery.** A photo replaced on disk (new mtime/size) is re-analysed; a deleted photo disappears from the grid on refresh but its `photoinfo.json` entry is kept; a recent folder that no longer exists (drive unplugged) shows a clear message and keeps its cache. Pinned by Tasks 1 and 2.
5. **Dragging out a HEIC.** The drag carries the original `.heic` path, never the derived JPEG or a thumbnail, and only paths of photos the gallery has catalogued are accepted by the main process. Pinned by Task 7.

## Builder calls made in this plan (spec "Left to the builder")

- One Electron build, two entry points (`--gallery`), rather than two builds: one installer, one sharp/libheif copy, separate name/data/lock so they run independently.
- Thumbnails: the editor's sizes (400 px grid, 1600 px preview/viewer), JPEG, under `<gallery dataDir>/thumbs/<key>_{s,m}.jpg`, where `key` is sha1 of `path|size|mtimeMs`.
- "Interesting" score (0–1): `0.45·quality + 0.2·colourVariety + 0.2·bestOfBurst + 0.15·exposureOk`, where `quality` is `scorePhotos(...).quality` normalised over the folder, `colourVariety` is the spread of the 3×3 `colorGrid`, `bestOfBurst` is 1 for a near-duplicate group's keeper or a photo in no group and 0 for the others, `exposureOk` is 1 minus the dark/bright flags. No faces.
- Main colour: the `avgColor` hue in 8 buckets of 45° starting at red (red, orange, yellow, green, cyan, blue, purple, pink), plus `neutral` when saturation < 0.15; sorted in that order, then by lightness.
- Place names: the bundled world-atlas is country level only. The location editor offers country search (sets `name`), keeps `lat`/`lon` from the camera or typed, and accepts any typed name ("Chesterman Beach, Tofino"). City-level search is out of scope.
- No rename command in the gallery (the spec's "renames inside the gallery update the entry" has nothing to apply to yet). Orphaned entries are offered for tidying (Task 5).
- Linux: the deb gets a second desktop entry; the AppImage opens the gallery from the editor's File menu ("Open Gallery") or `--gallery`.

---

### Task 1: Gallery catalog and folder scan (server side, no UI)

**Files:**
- Create: `src/gallery/server/catalog.ts`, `src/gallery/server/scanner.ts`
- Modify: `src/server/media.ts` (`readMetadata` gains `camera`)
- Test: `tests/gallery-catalog.test.ts`, `tests/media.test.ts` (or the existing test that covers `readMetadata`)

**Interfaces:**
- Consumes: `scanFolder(folder, recursive)` (`src/server/importer.ts`), `isSupported`, `workingFile`, `orientedSize`, `readMetadata`, `analyze`, `makeThumbnails`-equivalent sizes (`THUMB_SIZES`) from `src/server/media.ts`; `estimateRemaining` from `src/web/eta.ts` is web-side, so the job only reports `startedAt`/`processed`/`total`.
- Produces:
  ```ts
  // src/server/media.ts
  readMetadata(originalPath: string): Promise<{ capturedAt: string | null; gpsLat: number | null; gpsLon: number | null; camera: string | null }>
  // src/gallery/server/catalog.ts
  export interface GalleryPhoto {
    path: string; folder: string; fileName: string; relDir: string; // relDir: '' or subfolder path relative to the opened root, '/' separators
    size: number; mtimeMs: number; width: number; height: number; format: string;
    capturedAt: string | null; gpsLat: number | null; gpsLon: number | null; camera: string | null;
    analysis: PhotoAnalysis | null; key: string; // sha1(path|size|mtimeMs)
  }
  export class Catalog {
    constructor(dataDir: string)              // <dataDir>/gallery.sqlite, <dataDir>/thumbs, <dataDir>/derived
    lookup(path: string, size: number, mtimeMs: number): GalleryPhoto | null
    put(photo: GalleryPhoto): void
    thumbPath(key: string, size: 's' | 'm'): string
    recentFolders(): { folder: string; recursive: boolean; openedAt: string }[]   // newest first, max 12
    touchRecent(folder: string, recursive: boolean): void
    close(): void
  }
  // src/gallery/server/scanner.ts
  export interface ScanJob { id: string; root: string; recursive: boolean; total: number; processed: number; startedAt: number;
    done: boolean; errors: { path: string; message: string }[]; photos: GalleryPhoto[] }
  export class Scanner {
    constructor(catalog: Catalog, dataDir: string, opts?: { concurrency?: number })   // default 4
    open(root: string, recursive: boolean): ScanJob   // throws GalleryFolderError if root is not a readable folder
    get(id: string): ScanJob | undefined
    wait(id: string): Promise<ScanJob>
  }
  export class GalleryFolderError extends Error {}
  ```

- [ ] **Step 1: Failing tests** in `tests/gallery-catalog.test.ts`, using a temp copy of `fixtures/generated/trip` and a temp data dir:
  - `open` on the trip folder: `wait` gives `total === processed === 20`, every photo has `analysis`, `width > 0`, and both thumbnails exist; the HEIC photo's `path` ends in `.heic` and `format` is `heif`.
  - Reopening the same folder with an injected spy on `analyze` calls it 0 times (cache hit by path+size+mtime).
  - Touching one file's mtime and reopening re-analyses exactly that one.
  - A file deleted between scans is absent from the second job's `photos`.
  - `open('<nonexistent>')` throws `GalleryFolderError`.
  - `recursive: true` on a folder with a `sub/` subfolder gives `relDir === 'sub'` for those photos; `recursive: false` excludes them.
  - Nothing is written inside the photo folder (directory listing before and after is equal).
  - `recentFolders()` after two opens lists the latest first.
- [ ] **Step 2:** Run `npx vitest run tests/gallery-catalog.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Add `camera` to `readMetadata` (exifr `Make` + `Model`, trimmed, Model alone when it already starts with Make; `null` when absent). Update the importer call site so it ignores the new field. Test: the EXIF fixture's camera is read, a PNG gives `null`.
- [ ] **Step 4:** Implement `Catalog` (node:sqlite, one `photos` table keyed by path with the fields above and `analysis` JSON, one `recent` table) and `Scanner` (worker pool like `Importer`; per file: `fileStat` → `lookup` hit returns cached row, else `workingFile` (HEIC derived under the gallery dataDir) → `orientedSize` → `readMetadata` → `analyze` → thumbnails at `THUMB_SIZES` to `thumbPath(key, …)` → `put`). Per-file failures go to `errors`, never abort the job. `analyze` is injectable for the spy test.
- [ ] **Step 5:** Run the test file, then `npm test` and `npm run typecheck` — PASS.
- [ ] **Step 6: Commit** "Gallery: catalog and folder scan with cached analysis".

### Task 2: Gallery HTTP server

**Files:**
- Create: `src/gallery/server/app.ts`, `src/gallery/server/main.ts` (dev entry like `src/server/main.ts`, port `PHOTOBOOK_GALLERY_PORT` or 5176)
- Test: `tests/gallery-server.test.ts`

**Interfaces:**
- Consumes: Task 1 `Catalog`, `Scanner`; `readFolderInfo`, `infoFor`, `updatePhotoInfo`, `folderStamp`, `PhotoInfoWriteError` from `src/photoinfo`; `listPlaces`/`suggestPlaces` from `src/server/places.ts`; `setResourceRoot` from `src/server/resources.ts`.
- Produces:
  ```ts
  export interface GalleryAppOptions { photoInfoFallbackDir: string; staticDir?: string; devWebUrl?: string; resourceRoot?: string }
  export function createGalleryApp(dataDir: string, opts: GalleryAppOptions): { app: express.Express; close(): void }
  // JSON shape returned for each photo:
  export interface GalleryItem extends GalleryPhoto { info: PhotoInfo; infoSource: 'folder' | 'fallback' | 'none'; infoError?: string;
    effectiveDate: string | null; effectiveLat: number | null; effectiveLon: number | null }  // overrides applied
  ```
  Routes (all JSON, CSP `default-src 'self'` like the editor):
  - `GET /api/health` → `{ ok: true, app: 'gallery' }`
  - `GET /api/gallery/recent` → `recentFolders()` plus `exists: boolean` per folder
  - `POST /api/gallery/open {folder, recursive}` → `{ jobId }`; 404 with message when the folder is missing
  - `GET /api/gallery/jobs/:id?since=n` → `{ total, processed, startedAt, done, errors, items: GalleryItem[] }` where `items` are the photos finished after the first `n` (so the grid fills while the scan runs; `ScanJob.photos` is in completion order)
  - `GET /api/gallery/items?job=:id` → `GalleryItem[]` re-read with current photo info
  - `GET /api/gallery/thumb?key=…&size=s|m` → the JPEG (key must be in the catalog, else 404)
  - `PATCH /api/gallery/info {path, patch: Partial<PhotoInfo>}` → updated `GalleryItem`; 409 with the `PhotoInfoWriteError` message; 404 if `path` is not catalogued
  - `GET /api/gallery/stamp?job=:id` → `{ stamp }` combining `folderStamp` of every folder in the job
  - `GET /api/gallery/people?job=:id` → names used in those folders, most used first
  - `GET /api/places` and `POST /api/places/suggest` (same shapes as the editor's)

- [ ] **Step 1: Failing tests** (listen on port 0 like `tests/photoinfo-server.test.ts`), temp copy of the trip fixtures:
  - open → poll job until done → 20 items, each `infoSource: 'none'`; concatenating the `items` of successive `since=` polls gives each photo exactly once.
  - `PATCH` `{star:true, description:'x'}` writes the folder's `photoinfo.json`; next `items` shows both; the file's other entries and an unknown top-level field written beforehand are preserved.
  - External write test: after the gallery reads, write `{star:true}` for photo A with `updatePhotoInfo` directly (as the editor would), then `PATCH` A `{notes:'n'}` → file has both `star` and `notes`.
  - `stamp` changes after an external write.
  - Read-only folder (via the `writeFile` seam in `PhotoInfoOptions`, as the existing photoinfo tests do): `PATCH` succeeds with `infoSource: 'fallback'`, the file appears under `photoInfoFallbackDir`, and `new PhotoInfoIndex({fallbackDir: same}).apply(...)` sees the star.
  - `date` and `location` overrides change `effectiveDate`/`effectiveLat`/`effectiveLon` but not `capturedAt`/`gpsLat`.
  - `people` returns names across items, most used first.
  - Thumb and info routes 404 for uncatalogued keys/paths (e.g. `C:\Windows\win.ini`).
  - Opening a missing folder returns 404 with a message; recent list marks it `exists: false` and keeps it.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `createGalleryApp`; resolve photo info once per folder per request (as `PhotoInfoIndex.applyAll` does); serve `staticDir` with SPA fallback to `gallery.html`.
- [ ] **Step 4:** Run the file, `npm test`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** "Gallery: local server with photo info editing".

### Task 3: Desktop entry point and window

**Files:**
- Modify: `electron/config.ts`, `electron/main.ts`, `electron/server-host.ts`, `electron/preload.ts`, `src/shared/desktopApi.ts`, `scripts/desktop/build.mjs`, `scripts/desktop/dev.mjs`, `vite.config.ts`
- Create: `src/gallery/web/index.html`, `src/gallery/web/main.tsx`, `src/gallery/web/GalleryApp.tsx` (shell only: title bar and "Open folder" button)
- Test: `tests/electron-shell.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // electron/config.ts
  export type AppMode = 'editor' | 'gallery'
  export function parseMode(argv: string[]): { mode: AppMode; folder: string | null }   // '--gallery' [folder]
  export const GALLERY_PRODUCT_NAME = 'Photobook Gallery'
  // server-host 'start' message gains: kind: 'editor' | 'gallery', photoInfoFallbackDir?: string
  // src/shared/desktopApi.ts (gallery window only)
  startDrag(paths: string[]): void
  openGallery(): Promise<void>        // editor window: launches the gallery program
  ```
- Behaviour: in gallery mode `main.ts` sets name and userData from `dataLayout({ productName: GALLERY_PRODUCT_NAME, ... })` **before** `requestSingleInstanceLock()`, so the editor and gallery each have one instance and run side by side. A second `--gallery <folder>` launch focuses the gallery and opens that folder. The server host is told `kind: 'gallery'` and the editor's `<dataDir>/photoinfo` as `photoInfoFallbackDir`. The window loads `/gallery.html`, keeps its own `window-state.json`, and gets `hardenSession`/`hardenContents`. The editor's File menu gets "Open Gallery", which spawns `process.execPath` with the app path (when not packaged) and `--gallery`, detached. `startDrag` IPC is registered in Task 7.

- [ ] **Step 1: Failing tests:** `parseMode([])` → editor; `parseMode(['--gallery'])` → gallery, folder null; `parseMode(['--gallery','D:\\Pics'])` → that folder; `--self-test` args still parse; `dataLayout` for the gallery name gives `<appData>/Photobook Gallery/...` packaged and `... Dev/...` from source; the gallery fallback dir equals the editor layout's `dataDir + '/photoinfo'`.
- [ ] **Step 2:** Run `npx vitest run tests/electron-shell.test.ts` — FAIL.
- [ ] **Step 3:** Implement; add `src/gallery/web/index.html` as a second Vite input emitted as `gallery.html` (same CSP meta as the editor), sharing `styles.css` and `fonts.css`; `build.mjs` copies nothing new beyond the web build; `dev.mjs` forwards `--gallery` and starts the gallery dev server.
- [ ] **Step 4:** Run tests, `npm test`, `npm run typecheck`; `npm run desktop:build`, then `npx electron dist/desktop/app --gallery` opens the gallery shell while the editor (`npm run start:desktop`) runs at the same time. Record both in the report.
- [ ] **Step 5: Commit** "Desktop: --gallery entry point with its own window and data".

### Task 4: Open a folder, grid, progress, star from the grid

**Files:**
- Create: `src/gallery/web/api.ts`, `src/gallery/web/store.ts` (zustand), `src/gallery/web/components/{FolderBar,Grid,Tile,Progress,Toasts}.tsx`, `src/web/virtualGrid.ts`
- Modify: `src/gallery/web/GalleryApp.tsx`, `src/web/components/HoverPreview.tsx` (accept a plain `{src, title, takenAt}` instead of `PhotoAsset`; editor call site adapted), `src/web/styles.css` (gallery section)
- Test: `tests/virtual-grid.test.ts`, `tests/gallery-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/web/virtualGrid.ts (pure)
  export function gridWindow(o: { count: number; width: number; tile: number; gap: number; scrollTop: number; viewport: number; overscanRows?: number }):
    { cols: number; rowHeight: number; firstIndex: number; lastIndex: number; totalHeight: number; offsetTop: number }
  // src/gallery/web/store.ts
  interface GalleryState { job: string | null; root: string | null; items: GalleryItem[]; progress: { total: number; processed: number; startedAt: number } | null;
    selected: string | null; thumbSize: number;   // px, 96–320, persisted in localStorage 'gallery.thumbSize'
    open(folder: string, recursive: boolean): Promise<void>; setStar(path: string, star: boolean): Promise<boolean>; refreshInfo(): Promise<void>; ... }
  ```
- Behaviour: start screen lists recent folders (missing ones greyed, "Not found — is the drive connected?") and an Open folder button (`desktop.pickFolder`) with an "Include subfolders" checkbox. While scanning, a progress bar shows `processed/total` and time left via `estimateRemaining`/`formatRemaining`; the grid fills as items arrive (poll `jobs/:id?since=<items so far>` every 500 ms until done). The grid renders only `gridWindow`'s rows. Tile: thumbnail, star badge, hover star button; click selects; double-click opens the viewer (Task 7). Hover preview after 400 ms using the 1600 px thumb. A slider sets thumbnail size. The store polls `/stamp` every 3 s and calls `refreshInfo` when it changes. Star errors show the server message as an error toast.

- [ ] **Step 1: Failing tests:** `gridWindow` — 3,000 items, width 1000, tile 160, gap 6 → `cols` 6, `lastIndex - firstIndex` bounded by visible rows + overscan (≤ 60 items at viewport 800), `totalHeight` = rows × (rowHeight+gap) − gap, scrolling to the bottom gives `lastIndex === 2999`; width smaller than one tile → 1 column. Store test (fetch mocked): `setStar` 409 leaves the item unchanged, returns false, and adds an error toast; a changed stamp triggers exactly one `refreshInfo`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests, `npm test`, `npm run typecheck`. Add `tests/e2e/gallery.spec.ts` (Playwright project starting `tsx src/gallery/server/main.ts` against a built `dist/web`, port 5186, data dir `test-results/e2e-gallery`): open a temp copy of `fixtures/generated/trip` via the API, see 20 tiles, star one with the tile button, and find `"star": true` in the folder's `photoinfo.json`. Run `npx playwright test`.
- [ ] **Step 5: Commit** "Gallery: folder opening, virtual grid and starring".

### Task 5: Details panel and editing

**Files:**
- Create: `src/gallery/web/components/{Details,PeopleInput,LocationInput}.tsx`
- Modify: `src/photoinfo/store.ts` (add `forgetPhotos`), `src/photoinfo/index.ts`, `src/gallery/server/app.ts` (tidy routes), gallery store
- Test: `tests/photoinfo.test.ts`, `tests/gallery-server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/photoinfo/store.ts — same atomic write, fallback and retry rules as updatePhotoInfo
  export function forgetPhotos(folder: string, fileNames: string[], opts: PhotoInfoOptions): number   // entries removed
  // routes
  GET  /api/gallery/orphans?job=:id  → { folder: string; fileNames: string[] }[]   // entries whose file is not in the folder
  POST /api/gallery/forget {folder, fileNames} → { removed }                      // fileNames must be orphans of that folder
  ```
- Behaviour: a right-hand panel for the selected photo shows file name, date and time taken (override marked "changed"), camera, pixel size and file size, location (country name from `suggestPlaces` when there is GPS), and editable fields: people (chips; suggestions from `/people`; Enter or comma adds), date (`datetime-local`; clear restores the camera's), location (country search from `/api/places` sets `name`; lat/lon fields; free-text name), description, notes. Each field saves on blur/Enter through `PATCH /info`, with "Saved" feedback, or the 409 message as an error toast and the field kept so nothing typed is lost. When `infoSource` is `fallback` the panel says "This folder can't be written; info is kept in Photobook's own folder". A folder menu item "Tidy photo info…" lists orphaned entries and asks before removing them.

- [ ] **Step 1: Failing tests:** `forgetPhotos` removes only the named entries, keeps unknown top-level fields and other entries, works through the fallback for a read-only folder, and returns 0 without writing when none match. Server: `orphans` lists an entry for a deleted file; `forget` removes it; `forget` with a name whose file still exists is rejected (400) and nothing is written.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests, `npm test`, `npm run typecheck`.
- [ ] **Step 5: Commit** "Gallery: details panel, editing and tidying orphaned entries".

### Task 6: Sorting, filtering, interesting score, main colour

**Files:**
- Create: `src/core/gallerySort.ts`, `src/gallery/web/components/FilterBar.tsx`
- Modify: gallery store, `Grid.tsx`
- Test: `tests/gallery-sort.test.ts`

**Interfaces:**
- Produces (pure, no node imports):
  ```ts
  export type GallerySortKey = 'date' | 'interesting' | 'colour' | 'name'
  export interface GalleryFilter { starred?: 'yes' | 'no'; from?: string; to?: string; lowQuality?: boolean; nearDuplicates?: boolean;
    orientation?: 'portrait' | 'landscape'; hasLocation?: boolean; hasPeople?: boolean; relDir?: string; text?: string }
  export interface GalleryFacts { interesting: number; colour: { bucket: ColourBucket; lightness: number };
    flags: PhotoFlags; groupId: string | null; isKeeper: boolean }
  export type ColourBucket = 'red'|'orange'|'yellow'|'green'|'cyan'|'blue'|'purple'|'pink'|'neutral'
  export function galleryFacts(items: GalleryItemLike[]): Map<string, GalleryFacts>     // keyed by path; builds PhotoAsset-shaped input for cleanupSuggestions/groupSimilar/scorePhotos
  export function colourBucket(rgb: [number, number, number]): { bucket: ColourBucket; lightness: number }
  export function sortItems<T extends GalleryItemLike>(items: T[], key: GallerySortKey, facts: Map<string, GalleryFacts>): T[]
  export function filterItems<T extends GalleryItemLike>(items: T[], f: GalleryFilter, facts: Map<string, GalleryFacts>): T[]
  ```
  `GalleryItemLike` is the subset of `GalleryItem` these need (path, fileName, relDir, width, height, size, effectiveDate, effectiveLat, info, analysis); define it in this file so `src/core` doesn't import the gallery server.
- Behaviour: weights and buckets as in "Builder calls" above. Date sort uses `effectiveDate`, undated last, ties by file name. Photos without analysis yet sort after analysed ones for interesting/colour and are excluded by the low-quality filter only once analysed. Near-duplicates filter shows every photo in a group of 2+. Text search is case-insensitive over description and notes. The bar shows the count ("312 of 2,140"), a Clear button, and remembers sort/filter per session.

- [ ] **Step 1: Failing tests:** `colourBucket([220,40,40])` → red, `([40,90,220])` → blue, `([128,128,128])` → neutral. A burst of 3 near-identical items: one `isKeeper`, all share `groupId`, keeper's `interesting` > others'. A blurry item (low sharpness in a set of ≥5) gets `flags.blurry` and is included by `lowQuality`. `sortItems(..., 'date')` puts undated last. Combined filter `starred:'yes', orientation:'portrait', text:'beach'` returns only matches. `relDir: 'sub'` matches only that subfolder. Facts for 3,000 synthetic items (`fakeAsset`-style) compute in under 1 s.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; compute facts once per item list change (memo), not per render.
- [ ] **Step 4:** Tests, `npm test`, `npm run typecheck` (architecture test covers the new core file).
- [ ] **Step 5: Commit** "Gallery: sorting, filters, interesting score and main colour".

### Task 7: Full-screen viewer and dragging out

**Files:**
- Create: `src/gallery/web/components/Viewer.tsx`, `electron/drag.ts`
- Modify: `electron/main.ts` (register `gallery:start-drag`), `electron/preload.ts`, `src/shared/desktopApi.ts`, `src/gallery/server/app.ts` (`GET /api/gallery/drag-check`), `Tile.tsx`, `Grid.tsx`
- Test: `tests/gallery-drag.test.ts`, `tests/gallery-viewer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // electron/drag.ts (pure, testable)
  export function dragFiles(requested: string[], catalogued: (p: string) => boolean, exists: (p: string) => boolean): string[]   // keeps order, drops anything not catalogued or missing
  // viewer helper (in Viewer.tsx or a small pure module)
  export function viewerStep(index: number, count: number, key: string): { index: number; action?: 'star' | 'details' | 'close' }
  ```
- Behaviour: the viewer opens on the selected photo (double-click, Enter or Space), fills the window, and steps through the grid's **current filtered, sorted** list. Left/Right move (stop at the ends), **S** toggles the star with a large on-screen mark that fades, **I** toggles a details overlay, **Esc** closes and selects the last viewed photo in the grid (scrolled into view). It shows the 1600 px image and preloads the next and previous two. Dragging a tile (or every selected tile when the dragged one is selected; Ctrl/Shift-click extends selection in the grid) calls `desktop.startDrag(paths)` on `dragstart` with default prevented. The main process asks the gallery server which paths are catalogued (`drag-check`), filters with `dragFiles`, and calls `event.sender.startDrag({ files, icon })` with the first photo's small thumbnail as the icon. Paths are the originals (a HEIC drags as `.heic`).

- [ ] **Step 1: Failing tests:** `dragFiles` keeps catalogued existing paths in order, drops an uncatalogued path and a missing one, returns `[]` for none. `viewerStep`: ArrowRight at the last index stays, ArrowLeft at 0 stays, `s`/`S` → star, `i` → details, Escape → close, other keys no-op. Server `drag-check` returns the catalogued subset, and for the HEIC fixture returns the `.heic` original path.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests, `npm test`, `npm run typecheck`. Extend `tests/e2e/gallery.spec.ts`: open the viewer on tile 1, press ArrowRight twice and S, Esc; the third photo in the grid order is starred in `photoinfo.json`. Run `npx playwright test`.
- [ ] **Step 5: Commit** "Gallery: full-screen viewer with one-key starring and file drags".

### Task 8: Installer, self-test and docs

**Files:**
- Modify: `electron-builder.config.cjs`, `electron/installer.nsh`, `electron/selfTest.ts`, `electron/config.ts` (gallery self-test args), `README.md`, `docs/handoff.md`, `docs/plan.md`
- Create: `electron/linux/photobook-gallery.desktop` (deb only)
- Test: `tests/electron-shell.test.ts`, `tests/desktop-docs.test.ts`

**Interfaces:**
- Behaviour: the Windows NSIS installer creates a second Start-menu shortcut (and desktop shortcut) "Photobook Gallery" pointing to the same exe with `--gallery` and the gallery icon index, removed on uninstall (`customInstall`/`customUnInstall` in `installer.nsh`). The deb installs `photobook-gallery.desktop` (`Exec=photobook-studio --gallery %F`). `--self-test <photos> --self-test-out <dir> --gallery` runs the gallery: open the photos folder, wait for the scan, set one star, check it in `photoinfo.json` in a temp copy, and apply the same failure rules as the editor's self-test (console errors, blocked or off-host requests, server not stopping). README gets a "Photobook Gallery" section: opening folders, keys, filters, where info is kept, dragging into the editor. `docs/handoff.md` and `docs/plan.md` updated.

- [ ] **Step 1: Failing tests:** `parseSelfTest` with `--gallery` returns `mode: 'gallery'`; `desktop-docs` test checks README mentions the gallery keys (S, I, Esc) and `photoinfo.json`; a config test asserts `installer.nsh` contains a `Photobook Gallery.lnk` create and delete.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npx playwright test`; `npm run dist:dir`, then run both self-tests (editor and `--gallery`) on `fixtures/generated/trip` and record `result.json` outcomes in the report. Building the full NSIS installer (`npm run dist`) and installing it is a human check; note it in the report.
- [ ] **Step 5: Commit** "Gallery: installer shortcut, self-test and docs".
