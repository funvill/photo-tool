# Editor: photo info file, dropped files and draft updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The book editor reads and writes a `photoinfo.json` beside the photos, accepts photos dropped from Explorer, drafts from starred photos, and updates an existing draft without undoing hand edits, plus three small library fixes.

**Architecture:** A Node-only module `src/photoinfo/` owns the file format and safe writes; the gallery program (a later plan) will reuse it unchanged. The Express server overlays photo info onto the photos it returns and writes stars through the module. The draft update is a new pure function in `src/core/` beside the existing generator, driven by fingerprints the generator stores per page so hand edits can be detected without touching every edit action.

**Tech Stack:** TypeScript, React 19, Express 5, `node:sqlite`, sharp, Electron 45, vitest 5, Playwright.

**Spec:** [docs/superpowers/specs/2026-11-23-gallery-and-photo-info-design.md](../specs/2026-11-23-gallery-and-photo-info-design.md). This plan covers the shared file and Part 1 (the editor), spec order of work steps 1–4. The gallery program (steps 5–8) gets its own plan.

## Global Constraints

- Original photo files are never written, renamed or moved. The only file written beside photos is `photoinfo.json`.
- File name exactly `photoinfo.json`; format string exactly `"photoinfo/1"`; photos keyed by file name only (no path).
- Fields: `star` (boolean), `people` (string[]), `date` (ISO local date-time string), `location` (`{ lat: number; lon: number; name?: string }`), `description` (string), `notes` (string). All optional.
- Unknown top-level fields, unknown per-photo fields, and entries for files that do not exist are preserved on every write.
- Writes: re-read the current file, apply only the change, write a temp file in the same folder, rename over the original.
- Read-only folders fall back to `<dataDir>/photoinfo/` (one JSON file per photo folder, keyed by the folder's full path). The gallery will be pointed at the same directory.
- The web version (browser backend, `src/web/backend/browser/`) does not read or write `photoinfo.json` and keeps its stored star.
- Both programs work fully offline; no new network access anywhere (`tests/core.test.ts` URL guard must stay green).
- Update density cap: a page gains photos up to `Math.min(7, preset.maxPerPage)`. *(Plan call: the spec's "up to 7" assumed Steven's dense style; presets with a lower maximum keep theirs.)*
- Every commit authored as `SWS-Chipkin <sws-dev@chipkin.com>` via `git -c user.name="SWS-Chipkin" -c user.email="sws-dev@chipkin.com" commit`, message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is pushed.
- `npm run typecheck` and `npm test` pass at the end of every task.

## Review Focus

1. **Restyling, undo or reopening a book must not mark pages as hand-edited.** Fingerprints cover layout only (which photo, frame geometry, crop, fit, mask, hand-typed text), not fonts, colours or auto-filled text. Test in Task 4.
2. **A `photoinfo.json` broken by hand in Notepad** must not crash the editor and must never be overwritten: the folder's info reads as empty and starring there reports an error. Test in Task 1.
3. **File-name case on Windows** (`IMG_1.JPG` on disk, `img_1.jpg` in the file): lookup falls back to a case-insensitive match, and writes reuse the existing key. Test in Task 1.
4. **Dropping a photo already in the book**, an exact duplicate, an unsupported file (`.mov`, `.txt`), or a folder: no re-import, no silent failure, folders import like the Import button. Test in Task 3.
5. **A starred photo already placed by hand** (on an edited page, or dragged onto an auto page) is not placed a second time by an update. Test in Task 5.

---

### Task 1: The photo info module

**Files:**
- Create: `src/photoinfo/format.ts`, `src/photoinfo/store.ts`, `src/photoinfo/index.ts`
- Test: `tests/photoinfo.test.ts`

**Interfaces:**
- Produces:
  - `export const PHOTOINFO_NAME = 'photoinfo.json'`, `export const PHOTOINFO_FORMAT = 'photoinfo/1'`
  - `export interface PhotoInfo { star?: boolean; people?: string[]; date?: string; location?: { lat: number; lon: number; name?: string }; description?: string; notes?: string; [extra: string]: unknown }`
  - `export interface PhotoInfoFile { format: string; photos: Record<string, PhotoInfo>; [extra: string]: unknown }`
  - `export function parsePhotoInfo(text: string): PhotoInfoFile` — throws `PhotoInfoParseError` on invalid JSON or wrong shape.
  - `export interface PhotoInfoOptions { fallbackDir: string }`
  - `export interface FolderInfo { photos: Record<string, PhotoInfo>; source: 'folder' | 'fallback' | 'none'; error?: string; stamp: string }` — `stamp` changes whenever the backing file changes (mtime + size, or `'none'`).
  - `export function readFolderInfo(folder: string, opts: PhotoInfoOptions): FolderInfo` (sync; never throws; a broken file gives `photos: {}` and `error`)
  - `export function infoFor(info: FolderInfo, fileName: string): PhotoInfo | undefined` (exact key, then case-insensitive)
  - `export function updatePhotoInfo(folder: string, fileName: string, patch: Partial<Record<keyof PhotoInfo, unknown>>, opts: PhotoInfoOptions): PhotoInfo` (sync; a `null` value deletes the field; an entry left with no fields is removed; throws `PhotoInfoWriteError` if the existing file is unreadable)
  - `export function folderStamp(folder: string, opts: PhotoInfoOptions): string` (cheap: stat only)

Fallback file name: `sha1(normalisedFolderPath).json` inside `fallbackDir`, contents a `PhotoInfoFile` plus `"folder": "<full path>"`. Normalise with `path.resolve`, and lower-case on win32. Use the fallback when writing the folder's own file fails with `EACCES`, `EPERM` or `EROFS`. When reading, prefer the folder's own file and fall back if it does not exist and a fallback file does.

- [ ] **Step 1: Write the failing tests** in `tests/photoinfo.test.ts` (temp dirs via `mkdtempSync`):
  - `round-trips every field`: update with each field, then `readFolderInfo` returns them, and the file on disk has `format === 'photoinfo/1'` and pretty-printed (contains `"\n  "`).
  - `keeps unknown fields and entries`: write a file with `{"format":"photoinfo/1","owner":"x","photos":{"gone.jpg":{"star":true},"a.jpg":{"rating":4}}}`, then `updatePhotoInfo(dir,'a.jpg',{star:true})` → `owner === 'x'`, `photos['gone.jpg'].star === true`, `photos['a.jpg']` equals `{ rating: 4, star: true }`.
  - `null deletes a field and empty entries go`: set `{star:true}`, then `{star:null}` → `'a.jpg' in photos === false`.
  - `two writers do not lose each other's changes`: call `updatePhotoInfo` for `a.jpg` then `b.jpg` (each re-reads), both present.
  - `broken file is never overwritten` (Review Focus 2): write `{not json`; `readFolderInfo` gives `photos: {}` and a non-empty `error`; `updatePhotoInfo` throws `PhotoInfoWriteError`; file content is unchanged.
  - `case-insensitive lookup reuses the key` (Review Focus 3): file has `"img_1.jpg"`; `infoFor(info,'IMG_1.JPG')` finds it; `updatePhotoInfo(dir,'IMG_1.JPG',{notes:'x'})` writes under `"img_1.jpg"` and adds no second key.
  - `read-only folder falls back`: stub the folder write to fail with `EPERM` (inject via an optional `opts.fs` writer, or make the dir read-only where the platform allows; skip on win32 if read-only dirs cannot be simulated); `source === 'fallback'`, the fallback file has `folder` set, and a fresh `readFolderInfo` sees the star.
  - `stamp changes after a write`: `folderStamp` before and after an update differ.
  - `no temp files left behind`: after updates, the folder holds only `photoinfo.json`.

- [ ] **Step 2: Run** `npx vitest run tests/photoinfo.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `format.ts` (types, parse, serialise with `JSON.stringify(file, null, 2) + '\n'`), `store.ts` (read, write via `writeFileSync(tmp)` + `renameSync`, temp name `.photoinfo.json.<pid>.<random>.tmp`), `index.ts` re-exports. Node built-ins only.
- [ ] **Step 4: Run** `npx vitest run tests/photoinfo.test.ts` — expect PASS; then `npm run typecheck`.
- [ ] **Step 5: Commit** `Add the photoinfo.json module shared by the editor and gallery`.

### Task 2: The server reads and writes photo info

**Files:**
- Create: `src/server/photoInfoIndex.ts`
- Modify: `src/core/model.ts` (`PhotoAsset`), `src/server/app.ts` (`projectAssets`, the asset `PATCH`, new stamp route, `createApp` options), `src/web/backend/types.ts`, `src/web/api.ts` (or wherever the HTTP backend lives), `src/web/store.ts`
- Test: `tests/photoinfo-server.test.ts`

**Interfaces:**
- Consumes: Task 1's `readFolderInfo`, `infoFor`, `updatePhotoInfo`, `folderStamp`.
- Produces:
  - `PhotoAsset` gains `people?: string[]` and `description?: string`.
  - `createApp(dataDir, { photoInfoFallbackDir?: string, ... })`, defaulting to `join(dataDir, 'photoinfo')`.
  - `class PhotoInfoIndex { constructor(opts: PhotoInfoOptions); apply(asset: PhotoAsset, originalPath: string): PhotoAsset; setStar(originalPath: string, star: boolean): void; stampFor(paths: string[]): string }`. It caches `FolderInfo` per folder and re-reads it when `folderStamp` changes.
  - `GET /api/projects/:id/photoinfo-stamp` → `{ stamp: string }`, the joined stamps of every distinct folder holding one of the book's photos.
  - Backend interface: `photoInfoStamp(projectId: string): Promise<string>`. The browser backend returns a constant `''`.

`apply` rules:
- `favorite = info?.star === true`. The stored column is ignored on this backend.
- `date` overrides `capturedAt`.
- `location` overrides `gpsLat` and `gpsLon`.
- `people` and `description` are copied.

The asset `PATCH` with `favorite` calls `setStar` instead of `store.updateAssetUserFields` for the favourite. A `PhotoInfoWriteError` becomes HTTP 409 with the message `"Can't save the star: photoinfo.json in <folder> can't be read. Fix or delete it."`.

- [ ] **Step 1: Write the failing tests.** Use `createApp` with temp data and photo dirs, and make JPEGs with sharp as `tests/shelf.test.ts` does.
  - `star in the file shows as favourite`: write `photoinfo.json` with `{star:true}` for one photo, import the folder, then `GET assets` shows `favorite: true` for that one only.
  - `PATCH favorite writes the file`: the `PATCH` writes `photos[name].star === true` on disk, and the DB `favorite` column is unchanged (0).
  - `date and location overrides apply`: `capturedAt === '2025-08-12T17:40:00'`, plus `gpsLat` and `gpsLon` from the file. `people` and `description` are present.
  - `stamp changes when the file changes`: read the stamp, edit the file externally, read the stamp again: different. The stamp covers a dropped single file's folder too (seed by importing one file via Task 3's route once it exists; until then via folder import).
  - `broken file → 409`: a `PATCH` against a folder whose `photoinfo.json` is `{bad` returns 409.
- [ ] **Step 2: Run** `npx vitest run tests/photoinfo-server.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `PhotoInfoIndex`. Map `projectAssets` through `index.apply(asset, row.original_path)`, and do the same in the `PATCH` response. Add the stamp route and the backend method. In `store.ts`, while a project is open, poll `api.photoInfoStamp` every 3 s; when the value changes, call `refreshAssets()` (skip while an import job is running).
- [ ] **Step 4: Run** the test file, then `npm test` and `npm run typecheck`. Expect PASS. Existing tests that set `favorite` through `PATCH` now write `photoinfo.json` into their temp photo dirs; update their expectations only where they read the DB column directly.
- [ ] **Step 5: Commit** `Read stars, dates, places and people from photoinfo.json`.

### Task 3: Dropping files into the editor

**Files:**
- Modify: `src/server/importer.ts` (new `startPaths`), `src/server/app.ts` (route), `src/shared/desktopApi.ts`, `electron/preload.ts`, `src/web/backend/types.ts`, the HTTP backend, `src/web/backend/browser/index.ts` and `folders.ts` (web drop via the existing "picks" mechanism), `src/web/store.ts`, `src/web/components/Canvas.tsx`, `src/web/components/Library.tsx`
- Test: `tests/drop-import.test.ts`, `tests/electron-shell.test.ts` (preload surface)

**Interfaces:**
- Produces:
  - `ImportJob` gains `kind: 'import' | 'sync' | 'paths'` and `assetIds: string[]`: for `'paths'`, the asset id for each input file in input order, `''` for a file that failed.
  - `Importer.startPaths(projectId: string, paths: string[]): ImportJob`. A directory path is scanned recursively, as `start` does. An unsupported file gets an `errors` entry `"<name>: not a photo this app can read"`. A file already catalogued with the same size and mtime is linked, not re-imported (existing `importOne` path).
  - `POST /api/projects/:id/import-paths { paths: string[] }` → 202 with the job.
  - `DesktopApi.pathForFile(file: File): string`, implemented in the preload with `webUtils.getPathForFile`.
  - Backend: `importDropped(projectId: string, files: File[], paths: string[] | null): Promise<ImportJob>`. The HTTP backend sends `paths`; the browser backend registers `files` as a pick and imports it like a picked folder.
  - Store: `importDropped(files: File[]): Promise<string[]>`. It resolves to the placed asset ids (non-empty only), then runs `refreshAssets`, and shows a toast for any errors.

**Canvas behaviour:**
- `onDragOver` also accepts `e.dataTransfer.types.includes('Files')`.
- On drop, show a small "Importing…" marker at the drop point while waiting.
- Then place the first id exactly as a library drop does: replace the hit frame, or `addPhotoAt` on empty space. Each further id goes through `addPhotoAt`, offset by 10 mm down and right.
- All of it is one undo step, labelled `Add dropped photos`.
- Dropping onto the library panel only imports.

- [ ] **Step 1: Write the failing tests** in `tests/drop-import.test.ts`, against the server:
  - `imports single files and reports their ids in order`: two JPEGs from different folders give `assetIds.length === 2`, both non-empty, and both in `GET assets`.
  - `already in the book is linked not re-imported` (Review Focus 4): import a folder, then `import-paths` one of its files. `alreadyInLibrary === 1`, `imported === 0`, and the id matches.
  - `unsupported file is reported`: a `.txt` gives `failed === 0`, an `errors[0].error` that matches `/not a photo/`, and `assetIds` `['']`.
  - `a folder path imports the folder`: the folder's photo count is all imported.
  - `exact duplicate in another folder`: `exactDuplicates === 1`, and its id is still returned.

  In `tests/electron-shell.test.ts`, assert that the preload source exposes `pathForFile` and uses `webUtils.getPathForFile`.
- [ ] **Step 2: Run** `npx vitest run tests/drop-import.test.ts tests/electron-shell.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the importer, the route, the preload, the backend methods, the store action, and the Canvas and Library handlers.
- [ ] **Step 4: Run** the tests, then `npm test` and `npm run typecheck`. Expect PASS. Then check by hand in `npm run dev:desktop`: drag a JPEG from Explorer onto a frame, then onto empty space, then a folder onto the library. Record the result in the commit message body.
- [ ] **Step 5: Commit** `Accept photos dropped from Explorer onto pages and the library`.

### Task 4: Page fingerprints and hand-edit detection

**Files:**
- Create: `src/core/draftState.ts`
- Modify: `src/core/model.ts` (`Spread.provenance`), `src/core/generator.ts` (set fingerprints), `src/core/index.ts` (export)
- Test: `tests/draft-state.test.ts`

**Interfaces:**
- Produces:
  - `Spread.provenance` gains `fingerprints?: Partial<Record<PageSide | 'spread', string>>`.
  - `export function pageElements(doc: BookDocument, spread: Spread, side: PageSide | 'spread'): Element[]`. An element belongs to the page its centre lies on, using the same page-width geometry as `pageContentRect` in `book.ts`.
  - `export function fingerprintPage(doc: BookDocument, spread: Spread, side: PageSide | 'spread'): string`. It is a stable hash of the layout fields only:
    - images: `assetId`, `xMm`, `yMm`, `widthMm`, `heightMm`, `rotationDeg`, `crop`, `fit`, `mask`;
    - text: `text`, position and size, but not when `auto` is set;
    - shapes and calendars: position and size.

    Numbers are rounded to 0.01. Fonts, colours, borders and opacity are left out.
  - `export function withFingerprints(doc: BookDocument, spread: Spread): Spread` sets fingerprints for the sides in `spread.layout`.
  - `export function isPageEdited(doc: BookDocument, spread: Spread, side: PageSide | 'spread'): boolean`. The rules:
    - `spread.locked` → true;
    - no `provenance` → true (a page Steven made);
    - `provenance` present but no fingerprint for that side → false (a book drafted before this change);
    - otherwise, whether the stored fingerprint differs from the current one.
  - `export function handPlacedAssetIds(spread: Spread): Set<string>`: image asset ids on the spread that are not in `provenance.assetIds` (all of them when there is no provenance).

`generateDraft` passes each spread it builds through `withFingerprints`. No schema version bump is needed: a missing fingerprint already means "unedited".

- [ ] **Step 1: Write the failing tests**, using `fakeAsset` and a book from `generateDraft`:
  - `a fresh draft is unedited on every page`.
  - `moving, re-cropping, swapping or removing a photo marks only that page edited`. Use the existing command helpers, for example `updateElement` and `setFramePhoto` from `src/core/commands.ts`.
  - `restyling does not mark pages edited` (Review Focus 1): changing the style preset, text styles and border colour keeps `isPageEdited === false`.
  - `auto-filled text does not count`: changing a `toc` text's content keeps it unedited.
  - `old drafts without fingerprints count as unedited`: delete `provenance.fingerprints` and expect false.
  - `locked or provenance-less spreads count as edited`.
  - `handPlacedAssetIds finds a photo dragged onto an auto page`.
- [ ] **Step 2: Run** `npx vitest run tests/draft-state.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `draftState.ts` and the generator hook.
- [ ] **Step 4: Run** the tests and `npm test`. Expect PASS. Existing generator determinism tests must still pass: fingerprints are deterministic.
- [ ] **Step 5: Commit** `Remember which draft pages were changed by hand`.

### Task 5: Updating an existing draft

**Files:**
- Create: `src/core/draftUpdate.ts`
- Modify: `src/core/index.ts`
- Test: `tests/draft-update.test.ts`

**Interfaces:**
- Consumes: Task 4's `isPageEdited`, `handPlacedAssetIds`, `withFingerprints`, `pageElements`. Also existing `curatePool`, `chooseTemplate`, `layoutPage`, `layoutCollage`, `dayKey`, `aspectOf`, `chronological`, `dateRangeOf`, `reconcileCover`, `stylePreset`, `mulberry32`, `newId`.
- Produces:
  - `export function starredPool(assets: PhotoAsset[]): { photos: PhotoAsset[]; fellBack: boolean }`. It returns the usable starred photos (not excluded, not missing, not an exact duplicate), or all usable photos with `fellBack: true` when none are starred.
  - `export interface UpdateReport { added: string[]; removed: string[]; replaced: { removed: string; added: string; spreadIndex: number }[]; relaidPages: { spreadIndex: number; side: PageSide | 'spread' }[]; addedSpreads: number[]; removedSpreads: number; emptiedFrames: { spreadIndex: number; elementId: string }[]; pages: number; notes: string[] }`
  - `export function updateDraft(doc: BookDocument, assets: PhotoAsset[], settings: GenerationSettings): { doc: BookDocument; report: UpdateReport }`
  - `export function relayPage(doc: BookDocument, assets: PhotoAsset[], spreadIndex: number, side: PageSide | 'spread', settings: GenerationSettings): BookDocument`. It lays out the photos currently on that page afresh, adds them to `provenance.assetIds`, and sets new fingerprints.

**Algorithm for `updateDraft`** (each case is a test below):
1. `wanted` = `starredPool(assets).photos` ids. `placed` = every image asset id on every spread. An *auto page* is a page side where `isPageEdited` is false.
2. **Removals.** For each auto-placed photo (in `provenance.assetIds`, not hand-placed) that is no longer in `wanted`:
   - on an auto page, mark it for removal from that page;
   - on an edited page, set the frame's `assetId` to `null` and record it in `emptiedFrames`. Hand-placed photos are never removed.
3. **Additions.** `added` = `wanted` minus `placed`, in chronological order. Anything placed anywhere, by hand or not, is never added again (Review Focus 5).
4. **Same-day replacement.** For each removal on an auto page, take the first `added` photo with the same `dayKey` and the same orientation class (landscape when the aspect ratio is 1.1 or more, portrait at 0.9 or less, otherwise square). Put it into the frame, with the crop the template would give it, and record it in `replaced`.
5. **Remaining removals:** re-lay the page with its remaining photos. Re-lay the whole spread when both of its sides are auto pages; otherwise re-lay only that page. When an auto spread has no photos left, remove it, unless it is the title spread or the last spread.
6. **Remaining additions**, in date order:
   - Pick the target: the auto page whose photos' dates contain the new photo's `capturedAt`, else the nearest auto page before it, else the first auto page. Photos with no date go to the last auto page.
   - If the target has fewer than `Math.min(7, preset.maxPerPage)` photos, insert the photo in date order and re-lay.
   - Otherwise try the other side of the same spread when it is an auto page.
   - Otherwise insert a new spread right after the target spread. It holds the overflow and is laid out like a generated pair, with provenance and fingerprints; its `chapterId` comes from the target spread.
7. Re-laid pages use the same choices as `generateDraft`: `chooseTemplate` (or mosaic when `preset.layoutMode === 'mosaic'`), date captions when `settings.includeCaptions` is set and the style's `captionMode === 'date'`, `keepSubjectOutOfGutter`, and `rng = mulberry32(settings.seed)`. After every change, call `withFingerprints`.
8. Run `reconcileCover` on the result. Set `generation.generatedAt`. Set `report.pages = spreads.length * 2 - 2`. When the pool fell back to every photo, add a note.

- [ ] **Step 1: Write the failing tests.** Draft a book from 40 starred `fakeAsset`s over 4 days, then change stars and call `updateDraft`.
  - `no change → identical document` (apart from `generatedAt`), with an empty report.
  - `unstarring a photo on an auto page removes it`: the photo is gone, and only that page or spread is in `relaidPages`.
  - `same-day same-orientation replacement`: unstar one landscape and star a new landscape from the same day. The new photo takes the same frame (same element geometry), `replaced.length === 1`, and `relaidPages` is empty.
  - `new photo lands on the pages for its date`: a newly starred day-3 photo appears on a spread whose other photos are from day 3.
  - `a full page overflows to a new spread right after it`: star 8 more day-2 photos and expect `addedSpreads.length >= 1`, the new spread right after the day-2 spreads, and `pages` grown by a multiple of 2.
  - `hand-edited page is never re-laid`: move a photo on page X, then unstar another photo on page X. Page X's elements are unchanged except that frame, which has `assetId === null`, and `emptiedFrames` lists it.
  - `hand-placed photo stays when not starred`: drag-place an unstarred photo on an auto page and update. It is still there.
  - `starred photo already placed by hand is not added twice` (Review Focus 5).
  - `spread emptied of photos is removed`, and the page count drops by 2.
  - `untouched pages keep their crops`: deep-equal for spreads not named in the report.
  - `deterministic`: the same input twice gives the same output.
  - `relayPage makes a hand-edited page auto again`: afterwards `isPageEdited` is false and its photos are in `provenance.assetIds`.
  - `starredPool falls back when nothing is starred`.
- [ ] **Step 2: Run** `npx vitest run tests/draft-update.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `draftUpdate.ts`. Factor any page-laying code shared with `generator.ts` into an exported helper in `generator.ts`, for example `layoutAutoPage(base, preset, photos, side, opts)`, rather than duplicating it.
- [ ] **Step 4: Run** the tests, then `npm test` and `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `Update an existing draft from changed stars, keeping hand edits`.

### Task 6: Auto-draft panel uses stars and updates

**Files:**
- Modify: `src/web/components/DraftPanel.tsx`, `src/web/components/Inspector.tsx` (or wherever page commands live, for **Re-lay this page**), `src/web/components/Canvas.tsx` (empty-frame marker), `src/web/store.ts` (`draftReport` type)
- Create: `src/web/components/UpdateSummary.tsx`
- Test: `tests/draft-panel.test.ts` (pure helpers), plus one Playwright case in `tests/e2e/`

**Interfaces:**
- Consumes: `starredPool`, `updateDraft`, `relayPage`, `UpdateReport`.
- Produces: `export function pagesForStarred(count: number, target: number, maxPerPage: number): number`. It returns the smallest even page count at least `target` that fits `count` photos at `maxPerPage` per page, plus the title page and the closing page.

**Panel behaviour:**
- **When the book has no spread with `provenance`:** the primary button is **Generate**. It runs `generateDraft` with `starredPool(...).photos` and `targetPages = pagesForStarred(photos.length, target, Math.min(7, preset.maxPerPage))`.
- **Otherwise:** the primary button is **Update from stars**. It runs `updateDraft` as one undo step, labelled `Update draft`. The existing Regenerate moves to a secondary button, **Rebuild all pages**, with its current behaviour, and so does **Another variation**.
- **After an update,** `UpdateSummary` shows the counts from `UpdateReport` ("12 added · 5 removed · 3 replaced · 3 pages re-laid · added 2 pages, now 92 · 1 empty frame"). Each changed page is a link that calls `goToSpread`.
- **With no stars,** a note says "No photos are starred, so every photo was used."
- **When `pagesForStarred` raised the page count,** a note says "Added N pages so every starred photo fits."
- **Help text** (replaces the current line): "Uses your starred photos, in time order. Update adds and removes photos to match your stars and leaves pages you changed by hand alone. Undo brings back the previous version."
- **Empty frames** in `emptiedFrames` show a dashed outline with the label "Unstarred: fill or remove". This reuses the existing empty-frame rendering, with an extra class.
- **Re-lay this page** appears in the page's command area for any page `isPageEdited` reports as true. It calls `relayPage` as one undo step.

- [ ] **Step 1: Write the failing test** `pagesForStarred`:
  - `(40, 20, 7)` → `20`;
  - `(200, 20, 7)` → the smallest even number of pages at least `ceil(200 / 7) + 2`;
  - `(0, 20, 7)` → `20`.
- [ ] **Step 2: Run** it. Expect FAIL.
- [ ] **Step 3: Implement** the helper and the panel, summary, marker and command.
- [ ] **Step 4: Run** `npm test`, then add and run a Playwright case. Create a book, import the test fixtures with two of them starred through `photoinfo.json`, and click Generate: expect 2 photos placed. Star a third by editing the file, wait for the poll, and click **Update from stars**: expect the summary to show "1 added". Run `npx playwright test <file>`. Expect PASS.
- [ ] **Step 5: Commit** `Draft from starred photos and update the draft in place`.

### Task 7: Time left, a wider library and a large hover preview

**Files:**
- Create: `src/web/eta.ts`, `src/web/components/PanelResizer.tsx`, `src/web/components/HoverPreview.tsx`
- Modify: `src/web/components/Library.tsx`, `src/web/components/Editor.tsx` (workspace columns), `src/web/styles.css` (`.workspace`, `.grid`, `.tile`)
- Test: `tests/eta.test.ts`

**Interfaces:**
- Produces:
  - `export function estimateRemaining(processed: number, total: number, startedAtMs: number, nowMs: number): number | null`. It returns seconds, or `null` until at least 5 photos and 2 s have passed.
  - `export function formatRemaining(seconds: number): string`. The strings are exactly "less than a minute left", "about 1 minute left", "about N minutes left" (rounded up), and "about N hours M minutes left" when it is 90 minutes or more.

**Behaviour:**
- **Import label:** "Importing 120 / 403 · about 3 minutes left". The time uses `job.startedAt`.
- **Library width:** the workspace becomes `grid-template-columns: var(--library-width, 264px) 1fr 292px`. A drag handle on the library's right edge sets the width, clamped to 220–900 px. It is saved in `localStorage` under `photobook.libraryWidth`, inside try/catch.
- **Library grid:** `.grid` becomes `grid-template-columns: repeat(auto-fill, minmax(110px, 1fr))`, and `.tile` gets `aspect-ratio: 1`. The fixed `grid-auto-rows` rule is removed.
- **Hover preview:** resting the pointer on a tile for 400 ms shows `HoverPreview`. It is a fixed overlay from the library's right edge to the window's right edge, top to bottom with a 24 px margin, and ignores the pointer. It shows `thumbUrl(id, 'm')` with `object-fit: contain`, plus the file name, date and time taken, size, and people if any. It hides when the pointer leaves, a drag starts, the list scrolls, or Esc is pressed. It never shows during a drag.
- **Preview pane:** the existing `PreviewPane` in `Library.tsx` also shows `people` (comma-separated) and `description` when present.

- [ ] **Step 1: Write the failing tests** for `estimateRemaining`:
  - `null` at 4 photos;
  - 100 of 400 after 50 s → `150`.

  And for `formatRemaining`:
  - `30` → "less than a minute left";
  - `61` → "about 2 minutes left";
  - `5400` → "about 1 hour 30 minutes left".
- [ ] **Step 2: Run** `npx vitest run tests/eta.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the helpers and the components.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expect PASS. Then check by hand in `npm run dev`: widen the panel, reload, and confirm the width is kept. Hover a tile and confirm the preview fills the right side. Start an import of the 2023 folder and confirm the time appears after a few photos.
- [ ] **Step 5: Commit** `Show time left on import, let the library widen, preview on hover`.

### Task 8: Docs and a desktop check

**Files:**
- Modify: `docs/handoff.md` (state table and next steps), `docs/plan.md` (the non-goal line about Google Photos and the build order), `README.md` (a short "Stars and photoinfo.json" section)

- [ ] **Step 1: Update the docs.** Explain what `photoinfo.json` is, that the editor writes it when you star, that the web version does not use it, and what **Update from stars** keeps.
- [ ] **Step 2: Run** `npm run dist:dir`, then the self-test on the unpacked build (`"Photobook Studio.exe" --self-test <photos> --self-test-out <dir>`). Expect all checks ok. Then by hand in the unpacked build: add `"star": true` for a photo by editing `photoinfo.json` in Notepad and check the editor shows the star within 3 s; drop a JPEG from Explorer onto a page.
- [ ] **Step 3: Run** `npm test`, `npm run typecheck` and `npx playwright test`. Expect PASS. Note the known flaky 500-photo drag timing test if it fails, and do not change it.
- [ ] **Step 4: Commit** `Document photoinfo.json and draft updates`.
