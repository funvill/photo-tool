# Gallery Review Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Photobook Gallery's main screen into a review screen: a large preview pane, keyboard moving and judging (F favourite, H hide), hidden photos, near-duplicate stacks that unfold in the grid, a sectioned info panel with camera details and a histogram, and a right-click menu (copy image, copy path, show in folder, delete to Recycle Bin), and a Map tab on OpenStreetMap tiles that the user allows once.

**Architecture:** Pure rules (stacking, hidden filter, key steps, flag targets, histogram, fact formatting, trash flow) live in `src/core` / `electron/fileActions.ts` with Vitest tests. The zustand store (`src/gallery/web/store.ts`) gains hidden/stack state and actions on top of them. The screen (`GalleryApp`, `Grid`, new `Preview`, `Splitter`, `PhotoMenu`, sectioned `Details`) renders them. EXIF details come from a widened `readMetadata` stored in a new `exif` column of the gallery cache. File actions run in the Electron main process over new IPC calls, checked against the gallery server's catalogue.

**Tech Stack:** TypeScript, React 19, zustand, Vite, Express 5, node:sqlite, sharp, exifr, Electron 45, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-gallery-review-pane-design.md` (builds on `docs/superpowers/specs/2026-11-23-gallery-and-photo-info-design.md`).

## Global Constraints

- Every commit: `git -c user.name="SWS-Chipkin" -c user.email="sws-dev@chipkin.com" commit ...`, message body wrapped at ~72 chars, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push; never pull from or push to `upstream`.
- Never read, test against, or commit `photos/`, `data/` or `trial-output/`. Tests use `fixtures/` (the `fixtures/generated/trip` folder has 21 photos) or files generated in a temp dir.
- No agent drives the desktop (no computer-use tools). Anything that needs a real desktop goes into `docs/handoff.md` as a human check.
- `npm test` and `npm run typecheck` pass at the end of every task; Playwright gallery e2e (`npx playwright test tests/e2e/gallery.spec.ts`) passes at the end of every task that touches the screen.
- Favourite **is** the existing `star` field. Hidden is `hidden: true` in `photoinfo.json`; un-hiding sends `hidden: null` (PATCH with `null` deletes a field, see `updatePhotoInfo` in `src/photoinfo/store.ts`).
- Hidden filter default (`filter.hidden` undefined) **leaves hidden photos out**; `'show'` shows all; `'only'` shows only hidden.
- Stacks on by default. Top of a stack: the first starred member in sort order, else the group's keeper (`facts.isKeeper`), else the first member in sort order. The stack sits where its top sorts. Badge "×N", N = members passing the filter. A stack of one shown member is a plain tile.
- Keys are ignored when focus is in `input, textarea, select, [contenteditable="true"], [role="dialog"]` or when Ctrl/Alt/Meta is held (same guard the grid's Enter/Space uses).
- Delete = `shell.trashItem` only, after a native confirm naming the file (or the count); never a permanent delete; only paths the gallery server has catalogued.
- Menu icons from `src/web/components/Icon.tsx`: Copy to clipboard `image`, Copy path `copy`, Show in file explorer `folder`, Delete `trash`, Favourite `star`, Hide `eye-off` (Unhide `eye`). Menu uses the existing `.ctx-menu` styles in `src/web/styles.css`.
- Histogram clipping flag: `analysis.clippedShadows` or `analysis.clippedHighlights` ≥ 0.02.
- Panel widths remembered in localStorage keys `gallery.gridWidth` (default 420, min 200) and `gallery.detailsWidth` (default 340, min 260, max 560); the preview keeps at least 300 px. Section open state in `gallery.sections` (JSON object of section id → boolean, all open by default). All localStorage access wrapped in try/catch.
- Network: nothing leaves the machine except, in the gallery window only and only after the user chose **Load maps**, GET requests for `https://tile.openstreetmap.org/{z}/{x}/{y}.png`. No script, style or font from the internet ever (Leaflet is bundled from npm).
- The hover preview is removed from the gallery only; `src/web/components/HoverPreview.tsx` stays (the editor's Library uses it).

## Review Focus

1. **Typing never triggers keys:** F, H, arrows, Home/End pressed in the people box, description, notes, date field or search box type text and do nothing else. (Test in Task 3 e2e.)
2. **Hiding down to nothing:** pressing H on the last shown photo selects the previous one; hiding every photo leaves nothing selected and shows "No photos match the filter" without errors. (Test in Task 2.)
3. **Delete only what it should:** a path not catalogued, or the user cancelling the confirm, trashes nothing; a failing `trashItem` (no Recycle Bin) reports the error and the photo stays in the grid. (Test in Task 6.)
4. **Stacks under change:** starring a non-top member makes it the top without losing the selection; a filter that leaves out the top still shows the stack under another member. (Test in Task 1.)
5. **Old caches:** a `gallery.sqlite` made before this change opens (column added), and its photos get camera details on the next scan without thumbnails being rebuilt. (Test in Task 4.)

---

### Task 1: Pure review rules

**Files:**
- Modify: `src/core/gallerySort.ts` (hidden filter)
- Create: `src/core/galleryStacks.ts`
- Modify: `src/core/galleryViewer.ts` (grid steps, flag targets, next after removal)
- Modify: `src/core/index.ts` only if these modules are re-exported there today (follow what `gallerySort` does)
- Test: `tests/gallery-sort.test.ts`, `tests/gallery-stacks.test.ts` (new), `tests/gallery-viewer.test.ts`

**Interfaces:**
- Produces:
  - `GalleryFilter.hidden?: 'show' | 'only'`; `filterItems` leaves out `info.hidden === true` unless `'show'`, keeps only them for `'only'`; `isFilterActive` counts `hidden` when set.
  - `export interface StackInfo { id: string; size: number; open: boolean; top: boolean }`
  - `export function stackItems<T extends GalleryItemLike>(sorted: T[], facts: Map<string, GalleryFacts>, open: ReadonlySet<string>): { items: T[]; stackOf: Map<string, StackInfo> }` — `stackOf` has an entry (keyed by path) for every shown member of a stack with size ≥ 2; `id` is the facts `groupId`.
  - `export function gridStep(index: number, count: number, cols: number, key: string): number | null` — ArrowLeft/Right ±1, ArrowUp/Down ±cols, Home 0, End count−1, clamped to the list; null for any other key or an empty list.
  - `export function flagTargets(selection: readonly string[], selected: string | null, current: (path: string) => boolean): { paths: string[]; value: boolean } | null` — paths = selection when it has 2+ and includes `selected`, else `[selected]`; value = `!current(selected)`; null when nothing selected.
  - `export function nextAfterRemoval(before: readonly string[], after: readonly string[], selected: string | null): string | null` — `selected` if still in `after`; else the first photo after it in `before` that is in `after`; else the last one before it that is; else null.

- [ ] **Step 1: Write the failing tests**
  - `gallery-sort.test.ts`: `filter hides hidden photos by default`, `hidden 'show' keeps them`, `hidden 'only' keeps only them`, `isFilterActive({hidden:'show'}) is true`, `isFilterActive({}) is false`.
  - `gallery-stacks.test.ts` (build items + facts by hand, groupId/isKeeper set directly):
    - `folded stack shows only its keeper, at the keeper's sort position, with size = members`
    - `a starred member becomes the top over the keeper`
    - `open stack lists the other members right after the top, in sort order`
    - `when the filter left out the keeper, the first shown member is the top`
    - `a group with one shown member is a plain item with no stackOf entry`
    - `photos in no group pass through unchanged`
  - `gallery-viewer.test.ts`: `gridStep` cases (`ArrowRight` from last stays last, `ArrowDown` with cols 4 from 1 → 5, `ArrowDown` past the end clamps to count−1, `Home`/`End`, `'x'` → null, count 0 → null); `flagTargets` (single, multi with selected inside → all, multi with selected outside → just selected, value flips current); `nextAfterRemoval` (still there; next after; last removed → previous; all removed → null).

- [ ] **Step 2: Run them to see them fail**
  Run: `npx vitest run tests/gallery-sort.test.ts tests/gallery-stacks.test.ts tests/gallery-viewer.test.ts`
  Expected: FAIL (missing exports / hidden photos still shown).

- [ ] **Step 3: Implement** the filter change, `galleryStacks.ts` and the three helpers. `stackItems` is O(n): one pass to group shown members by `groupId`, pick tops, then one pass emitting each non-member, or a group's top (and, when open, its other members) at the top's position.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** `Gallery: hidden filter, stacks, grid steps and flag targets (pure)`.

---

### Task 2: Store: hidden, stacks, F/H and removal

**Files:**
- Modify: `src/gallery/web/store.ts`
- Test: `tests/gallery-store.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces (on `GalleryState`):
  - `stacked: boolean` (default true), `openStacks: string[]` (cleared by `open`/`close`), `setStacked(on: boolean): void`, `toggleStack(id: string): void`.
  - `toggleFlag(field: 'star' | 'hidden'): Promise<void>` — uses `flagTargets`; star saves via `setStar`; hidden saves `{ hidden: value ? true : null }` via `saveInfo`; then, when the selected photo left the visible list, selects `nextAfterRemoval(before, after, selected)` and trims `selection` to the visible list.
  - `removeItems(paths: string[]): void` — drops them from `items`, selection follows `nextAfterRemoval`.
  - `selectVisible` returns the stacked list when `stacked` (facts are needed whenever `stacked` is on: add it to `needsFacts`); the memo also keys on `stacked` and `openStacks`.
  - `export function selectStackInfo(s): Map<string, StackInfo>` — from the same memo; empty map when not stacked. `export const useStackInfo`.
  - On a folder finishing loading with nothing selected, select the first visible photo.

- [ ] **Step 1: Write the failing tests** (in the style `gallery-store.test.ts` already uses, with its fake API):
  - `toggleFlag('hidden') hides the selected photo and selects the next one`
  - `toggleFlag('hidden') on the last shown photo selects the previous one`
  - `hiding every photo leaves nothing selected`
  - `toggleFlag on a multi-selection sets every selected photo to the opposite of the focused one` (two saves, both `hidden: true`)
  - `toggleFlag('hidden') on a hidden photo with filter 'show' sends hidden: null`
  - `toggleFlag('star') stars through setStar`
  - `stacked list folds a group and toggleStack unfolds it`
  - `setStacked(false) shows every photo`
  - `removeItems drops the photos and moves the selection`
  - `opening a folder selects the first photo`

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/gallery-store.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass,** then `npm test`, `npm run typecheck`.
- [ ] **Step 5: Commit** `Gallery store: hidden photos, stacks, F/H toggles`.

---

### Task 3: The review screen (preview pane, keys, stacks and hidden in the grid)

**Files:**
- Modify: `src/gallery/web/GalleryApp.tsx`, `src/gallery/web/components/{Grid,Tile,FilterBar,Viewer}.tsx`, `src/gallery/web/gallery.css`
- Create: `src/gallery/web/components/Preview.tsx`, `src/gallery/web/components/Splitter.tsx`
- Test: `tests/e2e/gallery.spec.ts`

**Interfaces:**
- Consumes: Task 2 store (`toggleFlag`, `useStackInfo`, `toggleStack`, `setStacked`, `stacked`, `filter.hidden`), Task 1 `gridStep`.
- Produces: `Preview` (shows the selected photo; Task 6 attaches the context menu to it through an `onContextMenu(e, path)` prop); `Tile` gains `stack?: StackInfo`, `hidden: boolean`, `onToggleStack(id)`, `onContextMenu(path, e)` props (Task 6 wires the last).

Behaviour (exact values in Global Constraints):
- Layout `.gallery-main`: grid column (width from `gallery.gridWidth`) | splitter | preview (flex) | splitter | details (width from `gallery.detailsWidth`). `Splitter` is a 6 px vertical handle with pointer capture and `role="separator"` + `aria-orientation="vertical"`; it writes the width on release.
- `Preview`: the selected photo's `thumbUrl(key, 'm')`, `object-fit: contain` on a dark background; caption with file name and badges "Favourite", "Hidden", "N of M in stack"; double-click opens the viewer; nothing selected → empty pane.
- Remove `useHoverPreview`, `previewOf` and the hover props from `Grid`/`Tile`.
- Keys (one window `keydown` listener in `Grid`, which knows `cols`; keep the existing Enter/Space): arrows/Home/End move selection via `gridStep` (plain select: `select(path)`, selection becomes `[path]`), then scroll the selected row into view (reuse the existing scroll-into-view logic, extracted into a function); `f`/`F` → `toggleFlag('star')`; `h`/`H` → `toggleFlag('hidden')`; `e.repeat` ignored for F/H; `preventDefault` on handled keys. Not while the viewer or tidy dialog is open.
- Viewer: add F (same as S) and H (`toggleFlag('hidden')` for the shown photo — select it first) to `viewerStep` (`action: 'star' | 'hide'`); update its test in `tests/gallery-viewer.test.ts`.
- Tile: hidden → class `hidden` (opacity .4) and an `eye-off` badge; stack top → "×N" badge button (`aria-label="Show N similar photos"` / `"Fold N similar photos"`), click calls `onToggleStack` and does not select; open stack members get class `stack-member` (tinted outline in the stack's colour, e.g. a shared `--accent` outline).
- FilterBar: a "Hidden" select (Leave out / Show / Only) and a "Stack similar" checkbox.

- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/gallery.spec.ts` (on the `fixtures/generated/trip` copy the spec already uses):
  - `preview pane shows the selected photo and follows ArrowRight`
  - `F stars the selected photo and the tile shows the star badge`
  - `H hides the photo, it leaves the grid, the next photo is selected; Hidden: Show brings it back dimmed`
  - `typing f, h and arrows in the description box changes only the text` (selection and star unchanged)
  - `a stack badge unfolds and folds the stack` — only if the fixture has a near-duplicate group after analysis; if it has none, add a pair of near-identical generated photos to the temp copy in the test setup (sharp: one image and the same image with 1 % brightness change).
  - `the hover preview no longer appears` (hover a tile 600 ms, no `.hover-preview`).
- [ ] **Step 2: Run to see them fail.** `npx playwright test tests/e2e/gallery.spec.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run e2e, `npm test`, `npm run typecheck`** → all pass.
- [ ] **Step 5: Commit** `Gallery: preview pane, review keys, stacks and hidden in the grid`.

---

### Task 4: Camera details from EXIF

**Files:**
- Modify: `src/server/media.ts` (`ExtractedMetadata`, `readMetadata`)
- Modify: `src/core/model.ts` or a new `src/core/photoFacts.ts` for the `PhotoExif` type (src/core must not import the server)
- Modify: `src/gallery/server/catalog.ts`, `src/gallery/server/scanner.ts`
- Test: `tests/media-exif.test.ts` (new), `tests/gallery-catalog.test.ts`, `tests/gallery-server.test.ts`

**Interfaces:**
- Produces:
  - `export interface PhotoExif { lens?: string; focalLength?: number; focalLength35?: number; aperture?: number; exposureTime?: number; iso?: number; exposureBias?: number; flash?: boolean }` in `src/core/photoFacts.ts`.
  - `export function exifFromTags(tags: Record<string, unknown> | null | undefined): PhotoExif` in `src/server/media.ts` — reads `LensModel` (prefixed with `LensMake` when the model doesn't start with it), `FocalLength`, `FocalLengthIn35mmFormat`, `FNumber`, `ExposureTime`, `ISO` (exifr's name for ISOSpeedRatings; accept an array, take the first), `ExposureBiasValue`, `Flash` (number: fired = bit 0; string: starts with "Flash fired"); drops non-finite or non-positive numbers (bias may be 0 or negative).
  - `ExtractedMetadata.exif: PhotoExif` (always an object; `{}` when nothing found).
  - `GalleryPhoto.exif: PhotoExif | null` — null only for a cached row written before this change. Catalog column `exif TEXT`; on open, `PRAGMA table_info(photos)` and `ALTER TABLE photos ADD COLUMN exif TEXT` when missing.
  - Scanner: a cache hit whose `exif` is null re-runs `readMetadata(path)` only and puts the row back with `exif` (and refreshed `camera`); thumbnails and analysis untouched.

- [ ] **Step 1: Write the failing tests**
  - `media-exif.test.ts`: `exifFromTags` with a full tag set; with `ISO: [400]`; with `Flash: 16` (not fired) and `Flash: 25` (fired); with lens make prefixing; with `ExposureBiasValue: 0` kept; with junk values dropped; with null → `{}`. Plus `readMetadata on a JPEG written by sharp with EXIF gives exif.iso` if sharp's `withExif({ IFD2: { ISOSpeedRatings: '200', FNumber: '28/10' } })` round-trips in this sharp version — if it doesn't, leave this one out and say so in the report.
  - `gallery-catalog.test.ts`: `opens a cache made without the exif column and adds it` (create the old schema by hand with `node:sqlite` in a temp dir, insert a row, open `GalleryCatalog`, `get` returns `exif: null`); `put and get round-trip exif`.
  - `gallery-server.test.ts`: `a cached photo without exif gets it on the next scan and keeps its thumbnail files` (compare thumbnail mtimes before/after).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** Add the new tags to the existing `exifr.parse` `pick` list (one parse, not two).
- [ ] **Step 4: Run to see them pass,** then `npm test`, `npm run typecheck`.
- [ ] **Step 5: Commit** `Gallery: read lens, exposure and ISO from EXIF into the cache`.

---

### Task 5: Sectioned info panel with Photo, Camera and Histogram

**Files:**
- Modify: `src/core/photoFacts.ts` (formatters), create `src/core/histogram.ts`
- Modify: `src/gallery/web/components/Details.tsx`, `src/gallery/web/gallery.css`
- Create: `src/gallery/web/components/Section.tsx`, `src/gallery/web/components/Histogram.tsx`
- Test: `tests/photo-facts.test.ts` (new), `tests/histogram.test.ts` (new), `tests/e2e/gallery.spec.ts`

**Interfaces:**
- Consumes: `GalleryItem.exif` (Task 4), `item.analysis`.
- Produces:
  - `formatShutter(s: number): string` — s < 1 → `1/round(1/s) s` (e.g. 0.004 → `1/250 s`, 0.5 → `1/2 s`); s ≥ 1 → one decimal with a trailing .0 dropped (`2 s`, `1.3 s`).
  - `formatAperture(n: number): string` → `f/2.8`, `f/8` (one decimal, trailing .0 dropped).
  - `formatFocal(mm: number, mm35?: number): string` → `35 mm`, or `35 mm (52 mm in 35 mm terms)` when mm35 differs by ≥ 1.
  - `formatBias(ev: number): string` → `+0.7 EV`, `−1 EV` (U+2212), `0 EV`.
  - `megapixels(w: number, h: number): string` → `12.2 MP` (one decimal).
  - `aspectRatio(w: number, h: number): string` → nearest of `1:1, 5:4, 4:3, 3:2, 16:9, 2:1` (orientation-free, written long side first) within 2 %, else `1.62:1` (two decimals).
  - `histogram(rgba: ArrayLike<number>, bins = 64): { r: number[]; g: number[]; b: number[]; l: number[] }` — counts per bin, luminance `0.2126R + 0.7152G + 0.0722B`; alpha ignored.
  - `Section({ id, title, children })` — header button with `aria-expanded`, folds its body; open state from/to `gallery.sections`.
  - `Histogram({ item })` — loads `thumbUrl(item.key, 'm')` into an `Image`, draws it scaled to ≤ 256 px on an offscreen canvas, runs `histogram`, draws four SVG area paths (R, G, B semi-transparent, luminance grey), scaled to the largest bin; discards a result if the photo changed meanwhile; shows "Shadows clipped X %" / "Highlights clipped Y %" under it, flagged when ≥ 0.02.
  - Sections in order: Photo, Camera, Histogram, Place, People, Date and time, Description and notes (spec lists the content of each; existing editors move unchanged).

- [ ] **Step 1: Write the failing tests** — `photo-facts.test.ts` for each formatter's examples above (plus `aspectRatio(4000, 3000) === '4:3'`, `aspectRatio(3000, 4000) === '4:3'`, `aspectRatio(1000, 618) === '1.62:1'`); `histogram.test.ts`: a 2-pixel buffer (pure red, pure white) with bins 4 → r bin 3 = 2, g bin 0 = 1 and bin 3 = 1, l bins correct; e2e: `info sections fold and stay folded after reload`, `histogram draws for the selected photo` (an `svg path` inside the Histogram section with a non-empty `d`), `camera section says No camera details for a photo without EXIF` (fixtures are generated, so likely no EXIF — assert whichever the fixture gives, checking the fixture first).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass,** then `npm test`, `npm run typecheck`, gallery e2e.
- [ ] **Step 5: Commit** `Gallery: collapsible info sections with camera details and a histogram`.

---

### Task 6: Right-click menu and file actions

**Files:**
- Modify: `src/gallery/server/app.ts`, `src/gallery/server/catalog.ts`
- Create: `electron/fileActions.ts`; modify `electron/gallery.ts`, `electron/preload.ts`, `src/shared/desktopApi.ts`
- Create: `src/gallery/web/components/PhotoMenu.tsx`; modify `Grid.tsx`, `Tile.tsx`, `Preview.tsx`, `GalleryApp.tsx`
- Test: `tests/gallery-server.test.ts`, `tests/gallery-file-actions.test.ts` (new), `tests/e2e/gallery.spec.ts`

**Interfaces:**
- Produces:
  - `GalleryCatalog.remove(path: string): void` — deletes the row and its thumbnail files (missing files ignored).
  - `GET /api/gallery/image?path=` — full-size PNG of a catalogued photo (`sharp(workingFile(...).path).rotate().png()`), 404 when not catalogued, `Content-Type: image/png`.
  - `POST /api/gallery/removed { paths: string[] }` → `{ removed: string[] }` — for each catalogued path no longer on disk: `catalog.remove`, drop it from every in-memory job's `photos`, and `forgetPhotos(dirname, [basename], infoOpts)`; paths still on disk or not catalogued are skipped (not an error). 400 on a bad body.
  - `electron/fileActions.ts`: `export async function trashPhotos(requested: unknown, deps: { check(paths: string[]): Promise<string[]>; confirm(paths: string[]): Promise<boolean>; trash(path: string): Promise<void>; removed(paths: string[]): Promise<void> }): Promise<{ trashed: string[]; failed: { path: string; message: string }[]; cancelled: boolean }>` — `dragRequest` the input, `check` (the drag-check route), nothing to do → `{trashed:[],failed:[],cancelled:false}`; `confirm` false → cancelled with nothing trashed; else trash each, collect failures, call `removed(trashed)` when any.
  - IPC (all `ipcMain.handle`, all with the `fromApp` origin check used by the drag handlers, all only on the gallery window): `gallery:copy-image` (path) → `{ ok, error? }` — check catalogued, fetch `/api/gallery/image`, `clipboard.writeImage(nativeImage.createFromBuffer(buf))`; `gallery:show-in-folder` (path) → `{ ok, error? }` — check, `shell.showItemInFolder`; `gallery:trash` (paths) → `trashPhotos` with `confirm` = `dialog.showMessageBox(win, { type: 'warning', buttons: ['Move to Recycle Bin', 'Cancel'], defaultId: 1, cancelId: 1, message: one ? 'Move "name" to the Recycle Bin?' : 'Move N photos to the Recycle Bin?', detail: 'You can restore them from the Recycle Bin.' })` (on Linux say "Trash"), `trash` = `shell.trashItem`.
  - `DesktopApi`: `copyImage?(path: string): Promise<{ ok: boolean; error?: string }>`, `showInFolder?(path: string): Promise<{ ok: boolean; error?: string }>`, `trashPhotos?(paths: string[]): Promise<{ trashed: string[]; failed: { path: string; message: string }[]; cancelled: boolean }>`.
  - `PhotoMenu({ x, y, path, onClose })` — items in this order with icons: Copy to clipboard, Copy path to clipboard, Show in file explorer, separator, Favourite (F) / Unfavourite, Hide (H) / Unhide, separator, Delete. Copy path uses `navigator.clipboard.writeText` (multi-selection: every selected path in grid order joined by `\n`) and toasts "Copied". Items needing the desktop are `disabled` when `desktop?.copyImage` etc. are absent. Delete → `desktop.trashPhotos(targets)`; on reply `removeItems(trashed)`, toast failures (`error`), nothing on cancel. Closes on Esc, outside click, scroll, or after an action. Right-click on an unselected tile selects it first; on a selected one keeps the selection. Copy image / Show in folder act on the clicked photo; Copy path / Delete / Favourite / Hide on the selection when the clicked photo is in it.

- [ ] **Step 1: Write the failing tests**
  - `gallery-server.test.ts`: `image route returns a PNG for a catalogued photo` (check the PNG signature bytes), `image route 404s for an unknown path`, `removed drops a deleted photo from items and photoinfo.json` (copy fixture to temp, star a photo, delete the file with `rmSync` on the temp copy, POST removed, GET items lacks it, photoinfo.json lacks its entry), `removed skips a photo still on disk`.
  - `gallery-file-actions.test.ts`: `trashes only checked paths`, `cancel trashes nothing`, `a failing trash is reported and not passed to removed`, `junk input does nothing`.
  - e2e (browser build, no desktop): `right-click opens the menu with icons; Copy path puts the path on the clipboard` (grant `clipboard-read`/`clipboard-write` permissions in the test context), `desktop-only items are disabled in the browser`, `Hide from the menu hides the photo`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass,** then `npm test`, `npm run typecheck`, gallery e2e, `npm run desktop:build` (compiles the Electron side).
- [ ] **Step 5: Commit** `Gallery: right-click menu to copy, show in folder and delete to the Recycle Bin`.

---

### Task 7: Map tab

**Files:**
- `package.json` (add `leaflet`, `leaflet.markercluster` and their `@types/*` dev deps; exact current versions)
- Create: `src/gallery/web/components/MapView.tsx`, `src/core/galleryMap.ts`, `electron/mapTiles.ts`
- Modify: `src/gallery/web/GalleryApp.tsx` (Grid | Map switch in the thumbnail column), `src/gallery/web/store.ts` (`view: 'grid' | 'map'`, `setView`), `src/gallery/web/gallery.css`
- Modify: `electron/main.ts` / `electron/gallery.ts` (request guard, User-Agent, consent IPC), `electron/preload.ts`, `src/shared/desktopApi.ts`
- Modify: `src/gallery/web/index.html` and `src/gallery/server/app.ts` (CSP `img-src` adds `https://tile.openstreetmap.org`)
- Test: `tests/gallery-map.test.ts` (new), `tests/electron-shell.test.ts` (guard), `tests/e2e/gallery.spec.ts`

**Interfaces:**
- Produces:
  - `export const OSM_TILE_ORIGIN = 'https://tile.openstreetmap.org'` and `export function isMapTileRequest(url: string, method: string): boolean` in `electron/mapTiles.ts` — true only for `GET` of `https://tile.openstreetmap.org/<int>/<int>/<int>.png` with no query, no userinfo, default port.
  - The gallery session's `onBeforeRequest` allows a request when `isAllowedRequest(...)` OR (`mapsAllowed()` AND `isMapTileRequest(url, method)`); the editor session is unchanged. `onBeforeSendHeaders` for map-tile requests sets `User-Agent: PhotobookGallery/<app version>` (no other identifying data).
  - Consent kept by the main process in `<gallery userData>/settings.json` as `{ "mapsOnline": boolean }` (absent = not asked yet). IPC `gallery:get-map-consent` → `boolean | null`, `gallery:set-map-consent` (boolean) — `fromApp` origin check. `DesktopApi.getMapConsent?(): Promise<boolean | null>`, `setMapConsent?(on: boolean): Promise<void>`. In a plain browser (dev/e2e) the page keeps consent in localStorage key `gallery.mapsOnline` instead.
  - `export function locatedItems<T extends GalleryItemLike & { effectiveLon: number | null }>(items: T[]): { located: T[]; missing: number }` in `src/core/galleryMap.ts` — finite lat in [−90, 90] and lon in [−180, 180]; everything else counts as missing.
  - Store: `view: 'grid' | 'map'` (default `'grid'`, kept across folders), `setView(view)`. The map reads `selectVisible` (Task 2), so filters and hidden apply; markers use the photos of the full visible list, unfolding stacks (every member with a location gets a marker — use the unstacked filtered list; add `selectFiltered(s)` to the store if needed, from the same memo).
  - `MapView`: Leaflet map with `L.markerClusterGroup`; marker = `L.divIcon` holding a 36 px round `thumbUrl(key, 's')`; selected marker class `selected`; marker click → `select(path)`; when `selected` changes to a located photo not in view, `panTo` (no zoom); first render `fitBounds` of all markers (padding 24 px, max zoom 15); attribution "© OpenStreetMap contributors" (a link is not needed: the app blocks navigation); tile layer added only when consent is true; tile error → overlay "Map unavailable offline"; consent prompt (copy from the spec, buttons **Load maps** / **Not now**) when consent is null; a "Map: online / offline" toggle in the map corner changes it; count line "N photos have no location".
  - Arrow/F/H keys keep working in map view (they act on the selection in grid order, Task 3's handler must not depend on the grid being mounted — move it to a hook used by `GalleryApp` if Task 3 put it in `Grid`, using a stored `cols` that defaults to 1 when the grid is not mounted).

- [ ] **Step 1: Write the failing tests**
  - `gallery-map.test.ts`: `isMapTileRequest` accepts `https://tile.openstreetmap.org/3/4/2.png` GET; rejects POST, `http:`, another host, `https://tile.openstreetmap.org.evil.com/1/1/1.png`, a query string, a non-png path, userinfo, a non-default port; `locatedItems` keeps valid, counts null / NaN / out-of-range as missing.
  - `electron-shell.test.ts` (or wherever the guard is tested): with maps off, a tile URL is cancelled; with maps on, the tile URL passes and `https://example.com/` is still cancelled. If the guard wiring is not unit-testable as is, extract the decision into a pure `galleryRequestAllowed(url, method, opts & { mapsAllowed: boolean })` in `electron/mapTiles.ts` and test that.
  - e2e (block every request to `tile.openstreetmap.org` with `page.route` so the test never uses the network): `Map tab shows the consent prompt first`; `Not now shows markers without tiles`; `clicking a marker selects the photo and the preview shows it`; `switching back to Grid keeps the selection`. The fixture photos need locations: set locations on two photos through the info panel's location editor or a seeded `photoinfo.json` in the temp copy (check what the existing e2e setup does).
  - A source scan check: the built gallery bundle contains no `http(s)://` script or stylesheet URL other than `tile.openstreetmap.org` (extend the existing URL-scan test if there is one; find it with `grep -rn "https\\?://" tests/electron-shell.test.ts`).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** Import Leaflet CSS from the npm package in `MapView.tsx` (Vite bundles it); point Leaflet's default icon paths nowhere (we only use divIcons) so it never requests marker images.
- [ ] **Step 4: Run to see them pass,** then `npm test`, `npm run typecheck`, gallery e2e, `npm run desktop:build`.
- [ ] **Step 5: Commit** `Gallery: Map tab with OpenStreetMap tiles, allowed once by the user`.

---

### Task 8: Docs and human checks

**Files:**
- Modify: `README.md` (Photobook Gallery section: the three panes, keys F/H/arrows/Home/End/Enter, hidden filter, stacks, right-click menu, that delete uses the Recycle Bin, the Map tab, and replace "it never uses the network" with: the gallery uses the network only for OpenStreetMap map tiles, only after you allow it), `docs/handoff.md` (human checks), `docs/plan.md` (mark done)

- [ ] **Step 1:** Update the README section and `docs/plan.md`.
- [ ] **Step 2:** Add human checks to `docs/handoff.md`: Copy to clipboard pastes into another app (JPEG and HEIC); Show in file explorer selects the file; Delete puts the file in the Recycle Bin and it can be restored, and the gallery stays consistent after restoring and reopening; camera details on real camera and phone photos; histogram looks right on a dark and a bright photo; splitter widths survive a restart; the Map tab's consent prompt, tiles loading after Load maps, nothing loading after Not now (watch the network in DevTools), "Map unavailable offline" with Wi-Fi off, and markers for real GPS photos.
- [ ] **Step 3:** `npm test`, `npm run typecheck`.
- [ ] **Step 4: Commit** `Docs: gallery review pane`.
