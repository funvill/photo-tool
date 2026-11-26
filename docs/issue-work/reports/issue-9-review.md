# Review: issue #9, branch `gallery-keys-and-colour`

The worktree is `C:\Users\funvill\Documents\git\photobook_helper-keys`, base 0b18c30, tip 304b7a7. All six commits are authored by `SWS-Chipkin <sws-dev@chipkin.com>`. This was a read-only review. I re-ran five targeted vitest files (color-adjust, photo-edit, photo-edit-render, shortcuts, copy-files): 71 passed. File:line references point to the branch tip, not to the diff.

## Spec verdict: PASS, with 2 gaps

| Decision | Status | Notes |
|---|---|---|
| Delete | Met, 1 gap | It uses the same action as the menu (`trashSelected`, store.ts:1100) and the same `trashConfirm`, and the only delete is `shell.trashItem`. It takes only the selected photos that are shown, and the selection moves on as after H. It does nothing while typing, in the viewer, in a dialog, in edit mode, or with Shift+Delete. **Gap:** "every selected photo" is capped at 500 without a word (I1). |
| Rotate / flip | Met | `[` and `]` and the three menu items. One undo step for the whole selection, built on the shown edit (draft or saved), and kept out of edit mode and of photos being saved (store.ts `changeSelectedEdits`). Not Ctrl+R. |
| Light and colour | Met | Four sliders from −100 to +100, double-click resets one, Auto sets all four, Reset clears colour. One matrix (`colorMatrix`) is drawn by an SVG `feColorMatrix` in sRGB and applied by sharp `recomb` then `linear`. Auto works from the whole upright photo, where the plan said the cropped one; that is acceptable. |
| Before/after | Met | Hold `\` or the Before button. Works in the preview and in edit mode, shows the "Original" badge, and blur clears it. The draft is untouched. |
| Select all / none | Met | One `set`; the focused photo stays. In a field the key is the field's own. |
| Copy | Met on Windows (programmatic only), **gap on Linux** | One photo is copied as the picture; several as `text/uri-list`, which Windows turns into CF_HDROP; up to 500, with a toast. The plan's spike had to pick a method that works in Ubuntu's Files too; Linux was never tried (I2). |
| Shortcut overlay | Met, partly "one table" | `?`, Esc, a click outside, and Help › Keyboard shortcuts. A list for each place, with F1 and F2. Grid and edit mode switch on table ids. The viewer (`viewerStep` / `SWALLOWED`) and the menu's `REVIEW_KEYS` keep their own key sets, guarded in one direction only (M7). |

Binding constraints:
- Import boundaries hold: `shared/` imports nothing from the programs, and neither program imports the other.
- No new image-extension regex.
- `photoinfo.json` gets `storedEdit` (defaults left out, older `editKey` values unchanged, unknown top-level fields kept by `updatePhotoInfo`).
- Save, Save to file and Save as pass `flip` and `adjust` through unchanged: the edit goes from the IPC (gallery.ts:476 and :494) to `/api/gallery/edit/render`, then `parseEdit`, then `renderEdited`.
- Help order is updates, feedback, About, then Keyboard shortcuts (runDesktopApp.ts:532).
- Typing never triggers a shortcut: every new key is checked against `TYPING` or `TYPING_TEXT`, and Ctrl+C also gives way to selected text.

## Quality verdict: APPROVE WITH FIXES (0 Critical, 2 Important, 11 Minor)

What I checked and found sound:

- **Colour maths.**
  - sharp 0.35.5 `pipeline.cc` runs Recomb (line 701) before Linear (line 833).
  - `Linear` casts to uchar once at the end, so there is a single clamp, the same as feColorMatrix, which clamps after the matrix.
  - Both sides work on gamma-encoded sRGB 0–1 values: `colorInterpolationFilters="sRGB"` on the page, `toColourspace('srgb')` and an 8-bit PNG before recomb on the server.
  - The offset is `M·in + o` on both sides.
  - Agreement is shown by two tests: the render test checks sharp against `applyMatrix`, including clipping, greyscale and alpha, and the e2e test checks a screenshot of the page against `applyMatrix`.
- **Flip.** Mirroring the result gives `Mirror·R(θ)·Mᶠ = R(−θ)·Mᶠ⁺¹`, so swapping 90 and 270, negating straighten and mirroring the crop is correct when the flip comes first. CSS `rotate() scaleX(-1) translate()` mirrors before it turns, and the render step `flop()`s in its own pass before `rotate`. `rotateEditLeft` and `rotateEditRight` keep `flip` and turn the result on screen correctly, because `R(−90)·R(θ)·Mᶠ` leaves the mirror alone. The quadrant render test compares pixel for pixel.
- **Delete safety.**
  - It only ever calls `shell.trashItem`.
  - The confirm defaults to Cancel and is modal to the window, and Shift+Delete is excluded.
  - A failure partway leaves that file in place; only what was trashed is removed from the page, the catalog and `photoinfo.json` (`/api/gallery/removed` calls `forgetPhotos`), and a toast names the failure.
  - Undo after Delete cannot bring back a pending edit for a trashed photo, because `undo` skips paths that are no longer present (store.ts:1370–1378).
- **Image cache and `EditedImage`.** The picture source is the unedited thumbnail, and every edit is drawn live in CSS and SVG, so nothing can be stale after a rotate, flip or colour change. `PreviewStage` is keyed by `editKey`, which now includes flip and adjust. The new `useState` initialiser from `imageCache` only shortens the first frame.
- **Editor import.** The importer `parseEdit`s, then checks `isIdentityEdit` (flip-only now counts as an edit), then `editKey` (re-rendered when the colour changes), then calls `renderEdited`. `importer-edit.test.ts` covers this.

### Important

**I1. Delete (and the menu's Delete) silently stops at 500.** fileActions.ts:29 (`dragRequest` slices to 500) and store.ts:1100.
- *Scenario:* Ctrl+A in a folder of 2,000 shown photos, then Delete. The confirm reads "Move 500 photos to the Recycle Bin?", 500 go, and 1,500 stay with no explanation. The user has to repeat it 4 times. It fails safe, but it breaks "every selected photo", and Ctrl+A now makes it routine.
- *Fix:* either (a) have `trashSelected` refuse over 500 with a toast ("Delete takes at most 500 photos at a time"), or (b) send the list in batches of 500, each with its own confirm. In both cases `trashSelected` should check the count before calling the desktop app. Add a store test for 600 selected.

**I2. Multi-file Ctrl+C on Linux is untried, yet the toast always says "Copied N photos".** gallery.ts:312 and store.ts:1134.
- *Scenario:* on Ubuntu, Ctrl+C with 3 photos selected shows "Copied 3 photos", but GNOME Files may expect `x-special/gnome-copied-files`, so Paste does nothing. The plan's Task 6 spike asked for a method that works on both Windows 11 and Ubuntu's Files.
- *Fix:* try it on Ubuntu Files. If `text/uri-list` alone does not paste, also write `x-special/gnome-copied-files` (`copy\nfile:///…`) on Linux. Until then, gate `copyFiles` to `win32` in the preload or the handler, and fall back to "Copy path" text with an honest toast. Note the result in the issue.

### Minor

- **M1.** gallery.ts:308. `dragRequest` slices to 500 before `copyFilesRequest`, so `dropped` is always 0 from the main process, and the unit test that turns 600 into 500 (copy-files.test.ts) tests a branch the handler cannot reach. The page's own slice does the real work. *Fix:* pass `raw` through a type-only filter without the slice, or drop `dropped` from the reply.
- **M2.** PhotoMenu.tsx:27. `Delete` was added to `REVIEW_KEYS`, so Delete with the menu open closes it and trashes. The issue's constraint says keys are ignored in a menu, and only `[`/`]` were asked for. The native confirm keeps this from being harmful. *Fix:* take `Delete` out of `REVIEW_KEYS`, or record the decision.
- **M3.** PhotoMenu.tsx:173. The "Ctrl+C" hint sits on "Copy to clipboard", which copies only the right-clicked photo as a picture, while Ctrl+C with several selected copies them as files. *Fix:* drop the hint, or make the item follow `copySelected` when the right-clicked photo is in the selection.
- **M4.** shortcuts.ts:34 and :55. `plain()` rejects Ctrl or Alt, and AltGr arrives as Ctrl+Alt on Windows. So `\` (AltGr+ß), `[` and `]` (AltGr+8 and 9) can never fire on German, Nordic and similar layouts. *Fix:* accept `ctrlKey && altKey` together as AltGr for these rows (`e.getModifierState('AltGraph')`), or document it; the Before button and the menu still work.
- **M5.** Preview.tsx:148. `\` remounts `PreviewStage` (its key includes the edit), so a zoomed-in comparison resets to the whole photo on press and on release. The report mentions it. Comparing detail while zoomed is the main use of before/after. *Fix:* keep `showOriginal` out of the stage key; swap only `edit` inside a stable stage.
- **M6.** README.md:60 and photoEdit.ts:202. "An older Photobook Editor … still applies the crop and rotation" is not true for a flipped photo with a quarter turn: `flipEdit` stores 270 for an on-screen 90 plus a flip, and mirrors the crop. An older reader therefore shows it turned the wrong way, with the crop taken from the other side. The programs ship together, so the risk is low. *Fix:* correct the README sentence.
- **M7.** shortcuts.test.ts:62, Viewer.tsx (`SWALLOWED`) and PhotoMenu.tsx:27. The viewer guard runs one way only: a key `viewerStep` handles must be in the table, but a table row the viewer no longer handles fails nothing. `REVIEW_KEYS` and `SWALLOWED` are separate lists that are never checked against the table. *Fix:* build `SWALLOWED` and `REVIEW_KEYS` from the table, and add the reverse assertion (each viewer row's key makes `viewerStep` act).
- **M8.** Modal.tsx:7 and ShortcutOverlay.tsx:39. Both listen on `window` in the capture phase, and `stopPropagation` does not stop other listeners on the same node. Help › Keyboard shortcuts opened over Settings or Tidy, then Esc, closes both. *Fix:* use `stopImmediatePropagation` in the overlay and register it first, or have `Modal` ignore Esc while `shortcutsOpen`.
- **M9.** colorAdjust.ts:110–118 (Auto).
  - "Spread" is the luma-weighted average of the channel standard deviations, not the standard deviation of luma, so it overstates contrast on colourful photos and Auto may cut contrast.
  - Brightness is worked out as if the contrast were 0, but the matrix scales the brightness offset by `c`, so with both at their limits the mean misses 118.
  - Auto is still gentle and bounded. *Fix:* compute luma stats on the server (`.greyscale().stats()`), and solve for brightness after contrast. The new mean is `c·(meanL − 127.5) + 127.5 + c·b·255`, so `b = (118 − 127.5 − c·(meanL − 127.5)) / (c·255)` and the slider is `b / 0.4 × 100`, clamped.
- **M10.** gallery.spec.ts:1883. The test named "draws the colour the saved file will have" never saves. Agreement with the file only follows through `applyMatrix`. *Fix:* rename it, or Save to info and compare against `renderEdited` output.
- **M11.** photoEditRender.ts:55. `toColourspace('srgb')` before recomb brings 16-bit sources (16-bit PNG or TIFF) down to 8 bits whenever any colour is set, while an edit without colour keeps the depth. *Fix:* use `'rgb16'` when the input is 16-bit, and scale the `linear` offset by 65535. Or accept this and document it.
- Trivial: the Preview.tsx:131 Revert tooltip still says "Remove the crop and rotation"; it now removes flip and colour too.

## ⚠️ Could not verify

- Pasting into Explorer or a chat app by hand after multi-file Ctrl+C, and the Electron 45 main-process `ClipboardItem({'text/uri-list'})` path itself. I relied on the implementer's spike read-back; their scratch scripts are not in the repo.
- Linux clipboard behaviour (GNOME Files, Dolphin) under X11 or Wayland (I2).
- Help › Keyboard shortcuts and the `gallery:show-shortcuts` IPC in a running Electron. Only source tests and a Playwright stand-in cover it.
- Colour agreement for ICC-tagged or wide-gamut sources (Display P3 HEIC, Adobe RGB JPEG) and for 16-bit sources. The tests use flat 8-bit sRGB only. Thumbnails and render both go through sharp's sRGB conversion, so they probably agree, but this was not run.
- Rendering cost of one SVG filter per edited tile in large grids (Chromium does feColorMatrix on the GPU, so it is probably fine).
- Save to file and Save as with flip or colour, end to end. I read the code path and it passes the edit unchanged, but no test saves a colour edit through those routes.

## Re-review 1 (fix round, 264259c..c5b447c, head c5b447c)

Scope: the fix diff only. The fix commit is authored by SWS-Chipkin. I re-ran gallery-file-actions, copy-files, gallery-store and photo-tool-shell at c5b447c: 192 passed.

**Verdict: both Important findings are fixed. There is no new Critical or Important issue, and there are 4 new Minor ones. Ready to merge on the Important items.**

### I1: Delete stopped at 500. Fixed.
- `trashPhotos` (fileActions.ts) no longer slices. It removes duplicate paths, refuses more than `MAX_TRASH_FILES` (10,000) before any check, confirm or move, and checks the photos with the server 500 at a time; those calls are needed because `/api/gallery/removed` and the file-check each take only 500. It then shows one confirm with the real count, `shell.trashItem`s every confirmed photo one by one, and reports to the server in batches of 500. A batch whose report fails is swallowed, but the files are already in the bin and the server leaves missing files out of GET items.
- The page refuses more than `MAX_TRASH_PHOTOS` first with a clear toast (store.ts `trashSelected`). The menu's Delete goes through the same check.
- **Tests that fail without the fix:** gallery-file-actions "2,000 photos: one confirm … 500 at a time" (the old slice would make only one check of 500 and confirm 500) and the refusal test. The gallery-store 2,000 test would also fail on the old toast text.
- **After a partial failure:** only `r.trashed` goes to `removeItems`, so the page, the catalog and `photoinfo.json` (`/removed` calls `forgetPhotos`) match the disk. The toast counts against what the page asked for, so photos the server check dropped count as "not moved" too, which is honest. On selection (store.ts `settleSelection`): if the focused photo was trashed, the focus moves to the next photo and the photos that failed fall out of the selection. If the focused photo itself failed, the photos that failed stay selected, so Delete can be retried. That is inconsistent but safe (Minor R3).

### I2: multi-file Ctrl+C on Linux. Fixed (option b).
- `copyFilesClipboard(paths, process.platform)` returns the files as `text/uri-list` only for `win32`. Linux and macOS get the paths as text through `clipboard.writeText`, and the reply carries `as: 'paths'`, which the preload passes through unchanged.
- The page's toast says "Copied the paths of N photos as text (copying the files themselves works on Windows only)". A reply without `as` is treated as files, so an older reply still reads correctly.
- The branch runs in the main process on `process.platform`, which is correct. One photo still copies as a picture everywhere.
- **Tests:** the copy-files platform tests fail without the new function, and so does the source check in photo-tool-shell. The gallery-store toast test covers the page.

### Minor fixes checked
- The README now states the older-editor limit correctly.
- `\` keeps the zoom when the edit is only flip or colour (Preview.tsx `PreviewPicture`: `sameShape` keeps the stage key). The Playwright check fails without the fix.

### New Minor findings
- **R1.** README.md:30 and shortcuts.ts:59 still say several photos copy "as files"; on Linux and macOS they now copy as paths. *Fix:* add "(Windows; elsewhere their paths as text)".
- **R2.** Preview.tsx `PreviewPicture`: for a **flip**, keeping the stage keeps the pan coordinates, but the original is mirrored. Zoomed in on the flipped photo's left edge, holding `\` shows the original's left edge, which is a different part of the photo, so "the same detail, before and after" holds only for colour. *Fix:* for a flip, mirror `view.x` about the stage when swapping (`x' = fit.w·zoom − stage.w − x`), or keep the zoom for colour-only edits.
- **R3.** store.ts `trashSelected` and `settleSelection`: after a partial failure, whether the photos that failed stay selected depends on whether the focused photo was among them. *Fix:* after a partial failure, select exactly `r.failed` paths that are still shown, so a retry is one keypress.
- **R4.** fileActions.ts `trashPhotos`: up to 10,000 sequential `shell.trashItem` calls can take minutes, with no progress shown and no in-flight guard. Pressing Delete again meanwhile opens a second confirm for photos the first run is still moving. Its failures are then counted as "not moved" although the first run moved them. No data is lost, but the toast is wrong. *Fix:* keep a `trashing` flag in the store that blocks a second Delete, and show a progress toast for deletes over ~100 photos.

### ⚠️ Still not verified
- Explorer paste on Windows by hand.
- `clipboard.writeText` with 500 paths on Linux or macOS in a real Electron.
- How long a real 10,000-photo trash takes on Windows and Linux.
