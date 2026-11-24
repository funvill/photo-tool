# Gallery edit and zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gallery preview always fits and zooms with a mini map, and photos can be cropped and rotated, saved into `photoinfo.json` (default) or into the file itself, with Save / Save as / Save all; the editor applies saved info-file edits on import.

**Architecture:** One pure edit-geometry module in `src/core` drives both the page (CSS transforms) and the servers (sharp). The gallery server renders edited pictures to temp files and re-reads changed photos; the Electron main process owns everything that touches files (Recycle Bin, move into place, save dialog) and the new `editTarget` setting. The editor's importer renders an edited working file when a photo's info has an `edit`.

**Tech Stack:** Electron 45, React 19, zustand, Express 5, sharp, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-gallery-edit-and-zoom-design.md`

## Global Constraints

- Info-file mode never changes a photo file; the only write is `photoinfo.json`'s `edit` field (via `updatePhotoInfo`).
- Photo-file mode: original goes through `shell.trashItem` before the edited file takes its path; if trashing fails, nothing changes.
- Every file action in main runs only for paths the server's `file-check` says are in the open folder, and only for the gallery page in the gallery window (`allowed(e)` as in `galleryFileActions`).
- Edit field shape: `{ rotate: 0|90|180|270, straighten: −45…45, crop: {x,y,w,h} in 0…1 }`; identity edit ⇔ no field.
- Written formats: JPEG quality 95, PNG, WebP in the original's format; HEIC → Save as JPEG only; EXIF kept, orientation upright.
- Zoom 1…8, ×1.2 per wheel notch; mini map 160 px long side, opacity 0.75 (1 on hover), only when zoom > 1.
- Aspect presets: Free, Original, Square, 4:5, 3:2, 16:9 (portrait/landscape swap for non-square).
- Straighten slider −45…45 in 0.5° steps. Rotate 90° turns anticlockwise.
- Setting key `editTarget: 'info' | 'file'` in the gallery settings file beside `mapsOnline` (keep other keys); default `'info'`; browser fallback localStorage `gallery.editTarget`.
- Keys ignored in inputs/dialogs; while editing only Esc / Enter / R act.
- No new runtime dependencies. Git author `SWS-Chipkin <sws-dev@chipkin.com>` on every commit; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never read, test with or commit `photos/`, `data/`, `trial-output/`.

## Review Focus

1. A photo with EXIF orientation 6 (portrait from a phone): page display, gallery render and editor render must all crop the same region — Task 1 test with orientation applied before `rotate`; Task 2 render test on an oriented JPEG.
2. Photo-file Save when the Recycle Bin refuses (network drive): original stays, temp file removed, error toast — Task 4 test.
3. Saving while the folder is re-scanned or the photo left the open folder: refused with "not in the open folder" — Task 4 test.
4. Zoom at a pane that changes size (splitter drag, window resize): view resets to fit, no blank gap — Task 5 test on `clampPan`.
5. Closing the window with unsaved edits in a plain browser and in the app — Task 7 e2e for the page path (`beforeunload` set), Task 4 unit test for the main dialog logic.

---

### Task 1: Edit geometry (pure)

**Files:**
- Create: `src/core/photoEdit.ts`; export from `src/core/index.ts`
- Test: `tests/photo-edit.test.ts`

**Interfaces — Produces:**
- `type QuarterTurn = 0 | 90 | 180 | 270`
- `interface CropRect { x: number; y: number; w: number; h: number }`
- `interface PhotoEdit { rotate: QuarterTurn; straighten: number; crop: CropRect }`
- `IDENTITY_EDIT: PhotoEdit`
- `parseEdit(raw: unknown): PhotoEdit | null` — null for missing/invalid; clamps straighten to ±45, crop into [0,1] with w,h ≥ 0.01.
- `isIdentityEdit(e: PhotoEdit): boolean` (crop within 1e-4 of full, straighten 0, rotate 0)
- `editKey(e: PhotoEdit): string` — short stable hash string (same edit → same key; rounding to 1e-4).
- `straightenScale(w: number, h: number, deg: number): number` — scale of the largest centred same-aspect rectangle inside a w×h picture turned by deg.
- `turnedSize(w, h, rotate): { w: number; h: number }`
- `editPlan(w: number, h: number, e: PhotoEdit): { rotate: QuarterTurn; straighten: number; frame: {w,h} /* after step 2, px */; extract: {left,top,width,height} /* px within the frame */; out: {w,h} }` — w,h are the upright picture's px.
- `rotateEditLeft(e: PhotoEdit): PhotoEdit` — turns 90° anticlockwise, keeping the same picture region cropped (crop rect turned with it).
- `ASPECTS: { id: 'free'|'original'|'square'|'4:5'|'3:2'|'16:9'; label: string }[]`
- `fitCropToAspect(crop: CropRect, ratio: number /* w/h in px */, frame: {w,h}): CropRect` — largest rect of that ratio centred on the old crop's centre, inside [0,1].
- `resizeCrop(crop, handle: 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'|'move', dx: number, dy: number /* fractions */, ratio: number | null, frame: {w,h}): CropRect` — clamps inside [0,1], min size 0.05, keeps ratio when given.
- `editCss(e: PhotoEdit, picW: number, picH: number, boxW: number, boxH: number): { box: {w,h}; img: { width: number; height: number; transform: string } }` — how to show the edited result fitted in a box: an overflow-hidden box of `box` size containing the upright picture with `transform` (translate/rotate/scale, transform-origin 0 0).

- [ ] **Step 1: Write the failing tests** — at least:
  - `straightenScale(100,100,0) === 1`; `straightenScale(100,100,45)` ≈ `0.70711` (5 dp); `straightenScale(400,300,10)` < 1 and the turned rectangle's four corners of a `400*s × 300*s` rect lie inside the turned 400×300 picture (check by rotating corners).
  - `editPlan(4000,3000, IDENTITY_EDIT)` → `out` 4000×3000, `extract` {0,0,4000,3000}.
  - `editPlan(4000,3000,{rotate:90,straighten:0,crop:{x:0,y:0,w:0.5,h:1}})` → `frame` 3000×4000, `out` 1500×4000.
  - `parseEdit({rotate:45})` → null; `parseEdit({rotate:90,straighten:99,crop:{x:-1,y:0,w:2,h:1}})` → straighten 45, crop {0,0,1,1}.
  - `isIdentityEdit(parseEdit(IDENTITY_EDIT)!)` true; `editKey` equal for edits differing by 1e-6, different for rotate 0 vs 90.
  - `rotateEditLeft` four times returns the original edit; a crop of the left half, turned left once, becomes the bottom half (`{x:0,y:0.5,w:1,h:0.5}`).
  - `fitCropToAspect({x:0,y:0,w:1,h:1}, 1, {w:400,h:300})` → `{x:0.125,y:0,w:0.75,h:1}`.
  - `resizeCrop` 'se' by (0.5,0.5) from full stays {0,0,1,1}; 'move' never leaves [0,1]; with ratio 1 on a 400×300 frame the result's px ratio is 1 (±1e-6).
  - `editCss` identity in a 200×150 box for a 400×300 picture → box 200×150, img 200×150 (scale applied in transform or size).
- [ ] **Step 2:** `npx vitest run tests/photo-edit.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement. `editPlan` and `editCss` must share `straightenScale` and the step order of the spec.
- [ ] **Step 4:** Tests pass; `npx tsc --noEmit -p .` clean.
- [ ] **Step 5:** Commit `Gallery: edit geometry (crop, rotate, straighten)`.

### Task 2: Render edits with sharp; the editor's importer applies saved edits

**Files:**
- Create: `src/server/photoEditRender.ts`
- Modify: `src/server/importer.ts` (constructor gains `photoInfo?: PhotoInfoOptions`), `src/server/app.ts:43` (pass `{ fallbackDir: opts.photoInfoFallbackDir ?? join(dataDir,'photoinfo') }`)
- Test: `tests/photo-edit-render.test.ts`, `tests/importer-edit.test.ts`

**Interfaces:**
- Consumes: Task 1 `PhotoEdit`, `editPlan`, `parseEdit`, `editKey`, `isIdentityEdit`; `readFolderInfo`/`infoFor` from `src/photoinfo`; `workingFile` from `media.ts`.
- Produces: `renderEdited(workPath: string, edit: PhotoEdit, outFile: string, format: 'jpeg'|'png'|'webp', opts?: { keepMetadata?: boolean }): Promise<{ width: number; height: number }>` — EXIF orientation applied first (`.rotate()`), then `rotate(quarter)`, `rotate(straighten, {background:'#000'})`, extract the centred frame, extract the crop; JPEG quality 95; `keepMetadata` keeps EXIF with orientation 1 (`withMetadata({ orientation: 1 })`); writes temp beside `outFile` then renames.
- Produces: `editFormatFor(path: string): 'jpeg'|'png'|'webp'` (HEIC/HEIF → jpeg; `.jpg/.jpeg` → jpeg; png; webp).

- [ ] **Step 1: Failing tests** (images made with sharp in a temp dir):
  - 400×300 red-left/blue-right JPEG; `renderEdited` with crop left half → 200×300 output whose centre pixel is red.
  - A JPEG with EXIF orientation 6 (create raw 300×400 then `withMetadata({orientation:6})`): identity render gives 400×300... (assert width/height equal `orientedSize` of the source) — rule: dims follow the upright picture.
  - `rotate:90` on 400×300 → 300×400.
  - `straighten:10` → output size equals `editPlan(...).out` (±1 px) and has no pure-black corner pixel.
  - `keepMetadata` keeps `DateTimeOriginal` (read with exifr) and output orientation is 1/absent.
  - Importer: folder with `a.jpg` and a `photoinfo.json` `{format:'photoinfo/1',photos:{'a.jpg':{edit:{rotate:90,straighten:0,crop:{x:0,y:0,w:1,h:1}}}}}` → imported asset width/height swapped, `derived_path` under `<dataDir>/derived` containing the edit key; removing the edit and syncing again → asset processed again with `derived_path` null and original size; same edit re-import → `alreadyInLibrary` (not re-rendered). A HEIC is not needed.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `renderEdited`, `editFormatFor`. In `Importer.importOne`: read the photo's `edit` (`parseEdit`, identity → none). Expected derived = edit ? `derived/<contentHash>-<editKey>.jpg` : (HEIC derived or null). The "unchanged, already catalogued" shortcut also requires the existing row's `derived_path` to match the expected one (compare by file name, not hash, so no hashing on the fast path: store the edit key in the name and compare `editKey` portion; no edit ⇒ existing derived must not contain `-e`). When an edit applies: `work = workingFile(...)`, render to the derived path (if missing), then size/analysis/thumbnails from the derived file.
- [ ] **Step 4:** Tests pass; full `npm test` still green.
- [ ] **Step 5:** Commit `Editor: apply crop and rotation saved in photoinfo.json on import`.

### Task 3: Gallery server — render, refresh, full picture, edit validation

**Files:**
- Modify: `src/gallery/server/app.ts`, `src/gallery/server/scanner.ts`
- Test: `tests/gallery-server.test.ts` (extend), `tests/gallery-edit-server.test.ts` (new, if clearer)

**Interfaces — Produces:**
- `POST /api/gallery/edit/render { path, edit }` → `{ file: string; format: 'jpeg'|'png'|'webp' }`. Path must be a photo of the open folder (same rule as `file-check`: last job) else 404 "That photo is not in the open folder any more."; edit via `parseEdit` else 400. Writes `<dataDir>/edits/<uuid>.<ext>` with `keepMetadata: true`, from the working file (HEIC via `workingFile`). Files in `edits/` older than 1 hour are removed when the route runs.
- `POST /api/gallery/refresh { paths: string[] }` → `GalleryItem[]` for the paths now in the open job. `Scanner.refresh(jobId: string, path: string): Promise<GalleryPhoto | null>` re-reads one file ignoring the cache (new key, thumbs), replacing the job's entry for that path or appending it when the file is new and inside the job root (respecting `recursive`); a path outside the root or not a supported photo → null, skipped.
- `GET /api/gallery/full?path=` → upright JPEG quality 90 of a catalogued photo, `Cache-Control: private, max-age=3600` (path in the open folder, else 404).
- `PATCH /api/gallery/info`: when `patch.edit` is present it must be `null` or pass `parseEdit` (else 400); an identity edit is stored as `null` (removed).

- [ ] **Step 1: Failing tests:** render for an open-folder photo returns a file that exists in `<dataDir>/edits` with expected size; render for a photo of an earlier job → 404; bad edit → 400. Refresh after overwriting a photo with a different-size image → item with new `key`, `width`; refresh of a new file in the root → appended, appears in `GET /api/gallery/items`; refresh of a path outside → `[]`. `full` returns `image/jpeg` with the upright size. PATCH with identity edit removes the field; PATCH `edit:{rotate:45}` → 400.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `Gallery server: render edits, re-read changed photos, full-size picture`.

### Task 4: Desktop shell — edit target setting, Save to file, Save as, unsaved-close guard

**Files:**
- Create: `electron/editActions.ts` (logic with injected seams, like `fileActions.ts`)
- Modify: `electron/gallery.ts` (IPC wiring), `electron/mapTiles.ts` (generic `readGallerySetting`/`writeGallerySetting` or new `electron/gallerySettings.ts`, keeping `readMapConsent`/`writeMapConsent` working), `electron/main.ts` (wire), `electron/preload.ts`, `src/shared/desktopApi.ts`
- Test: `tests/gallery-edit-actions.test.ts`, extend `tests/electron-shell.test.ts` if it checks the preload surface

**Interfaces — Produces (DesktopApi additions, all optional):**
- `getEditTarget?(): Promise<'info'|'file'>`, `setEditTarget?(t: 'info'|'file'): Promise<void>`
- `saveEditToFile?(path: string, edit: PhotoEdit): Promise<{ ok: boolean; error?: string; item?: unknown }>` — item is the server's refreshed `GalleryItem`.
- `saveEditAs?(path: string, edit: PhotoEdit): Promise<{ ok: boolean; cancelled?: boolean; error?: string; savedPath?: string; item?: unknown /* when inside the open folder */ }>`
- `setUnsavedEdits?(count: number): void` — the page tells main how many photos have unsaved edits.
- `editActions.ts` exports:
  - `saveToFile(path, edit, deps: { check(paths): Promise<string[]>; render(path, edit): Promise<{file: string}>; trash(path): Promise<void>; move(from, to): Promise<void> /* rename, else copy+unlink */; removeTemp(file): Promise<void>; refresh(paths): Promise<unknown[]>; clearEdit(path): Promise<void> }): Promise<{ok,error?,item?}>` — order: check → (HEIC → error "HEIC photos can only be saved as a copy.") → render → trash original (failure: remove temp, error "Couldn't move the original to the Recycle Bin, so nothing was changed: …") → move temp → clearEdit → refresh.
  - `saveAs(path, edit, deps: { check; render; ask(defaultPath: string): Promise<string | null>; move; removeTemp; refresh; copyInfo(from, to): Promise<void> }, root: string | null)` — default `<dir>/<stem>-edited.<ext>` (ext `jpg` for HEIC, else original's); chosen === original (case-insensitive on win32) → error "Choose a different name: Save as keeps the original."; extension of the chosen path forced to the render format; after move, when inside `root`, refresh + copyInfo.
  - `unsavedClosePrompt(count: number)` → `MessageBoxOptions` (buttons `['Close without saving', 'Keep editing']`, default 1, cancelId 1).
- Main: `win.webContents.on('will-prevent-unload', e => { if (dialog.showMessageBoxSync(win, unsavedClosePrompt(n)) === 0) e.preventDefault(); })` for the gallery window only.

- [ ] **Step 1: Failing tests** with fake deps: happy path call order; trash failure leaves original (move never called, temp removed); path not in open folder → error, render never called; HEIC → error; saveAs default name `IMG_1-edited.jpg` for `IMG_1.HEIC`; same-path refused; cancelled dialog → `{ok:false,cancelled:true}`, nothing rendered or render temp removed; inside root → refresh+copyInfo called, outside → not. Setting read/write keeps `mapsOnline`, default `'info'` for a missing/garbled file. `unsavedClosePrompt(3)` message names 3 photos.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement + wire IPC (`gallery:get-edit-target`, `gallery:set-edit-target`, `gallery:save-edit-file`, `gallery:save-edit-as`, `gallery:unsaved-edits`) with `allowed(e)`; `clearEdit` = server PATCH `{edit:null}`; `copyInfo` = server PATCH of the new photo with the original's star, people, date, location, description, notes.
- [ ] **Step 4:** Tests pass; typecheck clean.
- [ ] **Step 5:** Commit `Desktop: edit setting, save edits to the file or as a copy, warn on unsaved close`.

### Task 5: Preview fit, wheel zoom, mini map

**Files:**
- Create: `src/core/previewZoom.ts`, `src/gallery/web/components/MiniMap.tsx`
- Modify: `src/gallery/web/components/Preview.tsx`, `src/gallery/web/gallery.css`, `src/gallery/web/api.ts` (`fullUrl(path)`)
- Test: `tests/preview-zoom.test.ts`, `tests/e2e/gallery.spec.ts`

**Interfaces — Produces:**
- `fitSize(imgW, imgH, paneW, paneH): {w,h}`
- `interface View { zoom: number; x: number; y: number }` (x,y: top-left of the image in pane px)
- `fitView(img, pane): View`; `zoomAt(v: View, factor: number, px: number, py: number, img, pane): View` (clamps 1…8, keeps the point under the pointer; at 1 returns `fitView`); `clampPan(v, img, pane): View` (no gap where the image could cover; centred on an axis where it is smaller than the pane); `visibleRect(v, img, pane): CropRect` (fractions of the image, for the mini map); `centreOn(v, fx, fy, img, pane): View`.

- [ ] **Step 1: Failing tests:** `fitSize(1600,1067,2000,500)` → height 500 (the bug case: wide pane). `zoomAt` keeps the image point under (px,py) fixed (±1e-6); zoom capped at 8; zooming out to 1 returns `fitView`. `clampPan` after a pane shrink leaves no gap. `visibleRect` at fit = {0,0,1,1}. E2E: set the viewport to 2400×700, select a photo → the preview `img`'s bounding box lies inside the stage; wheel up over the image → `.gallery-minimap` visible; double-click → minimap gone, zoom reset; double-click again → viewer opens.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: stage `position: relative; overflow: hidden`, measured with `ResizeObserver`; image absolutely positioned with `transform: translate(x,y) scale(...)`. Wheel listener non-passive (`preventDefault`). Pointer drag pans when zoom > 1. Load `fullUrl` when `zoom × fitted width > 1600 px`-picture width, swap on load. Reset on item key change and on pane resize. Mini map per spec.
- [ ] **Step 4:** Unit + `npx playwright test tests/e2e/gallery.spec.ts` pass.
- [ ] **Step 5:** Commit `Gallery: preview always fits; wheel zoom with a mini map`.

### Task 6: Edit mode and unsaved edits in the page

**Files:**
- Create: `src/gallery/web/components/EditPane.tsx`, `src/gallery/web/components/EditedImage.tsx` (shows a picture with an edit via `editCss`)
- Modify: `src/gallery/web/store.ts` (`editing: string | null`, `pendingEdits: Record<string, PhotoEdit>`, `startEdit(path)`, `finishEdit(edit | null)`, `cancelEdit()`, `discardEdit(path)`, selector `shownEdit(s, item): PhotoEdit | null`), `Preview.tsx`, `Tile.tsx`, `useReviewKeys.ts` (E; off while editing), `PhotoMenu.tsx` (Edit), `gallery.css`
- Test: `tests/gallery-store.test.ts`, `tests/e2e/gallery.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers; Task 5 Preview structure.
- Produces: store fields above; `shownEdit` = pending ?? (editTarget==='info' ? parseEdit(item.info.edit) : null). `editTarget` field + `setEditTarget` are added in Task 7 — in this task read it as `'info'` default (add the field with default here; Task 7 loads/saves it).

- [ ] **Step 1: Failing tests:** store — `finishEdit` with a change stores pending; with the saved state clears it; `cancelEdit` leaves pending untouched; opening another folder clears pending (after Task 7's confirm; here: cleared). E2E: select, press E → edit pane with Done/Cancel; drag the SE handle inwards, Done → tile shows `.gallery-tile-unsaved` dot and caption "Edited · not saved"; R rotates (crop box aspect flips); Esc cancels; typing "e" in the description field does not open edit; arrow keys don't move selection while editing.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per spec "Edit mode". Preview and tile display the shown edit via `EditedImage`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `Gallery: crop and rotate photos in the preview`.

### Task 7: Save, Save as, Save all, Revert, Settings window

**Files:**
- Create: `src/gallery/web/components/SettingsDialog.tsx`, `src/gallery/web/editSettings.ts` (load/save `editTarget` like `mapConsent.ts`)
- Modify: `store.ts` (`editTarget`, `loadEditTarget`, `setEditTarget`, `saveEdit(path)`, `saveEditAs(path)`, `saveAllEdits()`, `revertEdit(path)`, report count via `desktop.setUnsavedEdits` and `beforeunload`), `Preview.tsx` caption buttons, `PhotoMenu.tsx` (Save, Save as…, Save all, Revert to original), `GalleryApp.tsx` (⚙ button, confirm before opening another folder with unsaved edits), `gallery.css`
- Test: `tests/gallery-store.test.ts`, `tests/gallery-edit-settings.test.ts`, `tests/e2e/gallery.spec.ts`

**Interfaces — Consumes:** Task 3 routes (via `galleryApi`), Task 4 DesktopApi, Task 6 store.

- [ ] **Step 1: Failing tests:** info mode `saveEdit` PATCHes `{edit}` and clears pending; identity → `{edit:null}`; file mode calls `desktop.saveEditToFile`, replaces the item with the returned one, clears pending; failure keeps pending and toasts the error. `saveAllEdits` saves each, one summary toast "Saved 2 photos" / "Saved 1, 1 failed: …"; skips HEIC in file mode naming it. `revertEdit` PATCHes `{edit:null}`. `editSettings` falls back to localStorage. `beforeunload` handler calls `preventDefault` only with pending edits. E2E (browser build, info mode): edit, Save → reloading the page shows the photo cropped (tile edited), photoinfo has `edit`; Settings dialog shows two options with "Change the photo file itself" disabled in the browser; Save as disabled in the browser with a title explaining why.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per spec "Saving" and "Settings window".
- [ ] **Step 4:** Tests pass; full `npm test`, typecheck and gallery e2e green.
- [ ] **Step 5:** Commit `Gallery: save edits, save as a copy, save all, settings`.

### Task 8: Docs

**Files:** `README.md` (gallery section: zoom, edit, settings, keys E/R), `docs/handoff.md` (human checks: wide-screen fit, wheel zoom feel + mini map, crop handles, straighten, Save in both modes with Recycle Bin restore, Save as into and outside the folder, Save all, close warning, editor import of an info-file edit, HEIC Save as), `docs/plan.md` if it lists gallery features.

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** Commit `Docs: gallery zoom and editing`.
