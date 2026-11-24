# Gallery: preview fit, zoom with a mini map, and crop / rotate with two ways to save

**Date:** 2026-11-24
**Builds on:** `2026-11-23-gallery-review-pane-design.md`

## Why

Steven picks photos for the book in the gallery. Today the preview is cut off on wide screens, there
is no way to look closely at a photo without the full-screen viewer, and a crooked or badly framed
photo can only be fixed after it is in the book (the editor's frame crop, which can't straighten and
is lost when a layout is rearranged). This change makes the preview show the whole photo, lets it be
zoomed with the wheel, and adds Google Photos-style crop and rotate. The edit is saved either into the
folder's `photoinfo.json` (the original file untouched; the editor applies the edit when it imports
the photo) or into the photo file itself — a setting, the info file by default.

## Goals

1. **Preview always fits.** The whole photo shows in the preview pane at any window shape.
2. **Wheel zoom.** The wheel zooms the preview towards the pointer; drag pans; when zoomed, a
   semi-transparent mini map in the pane's top-right corner shows the whole photo with the visible
   part outlined.
3. **Crop and rotate** in the centre pane: crop box with handles and aspect presets, rotate 90°,
   straighten slider, Reset / Cancel / Done.
4. **Two ways to save**, chosen in a new Settings window: "Change only the photo's info file"
   (default) or "Change the photo file itself".
5. **Save, Save as…, Save all** for photos with unsaved edits; a warning before closing with any.
6. **The editor honours saved info-file edits** when it imports or re-syncs the photo.

## Non-goals

- No colour, light or filter tools; no flip; no undo history beyond Cancel / Reset.
- The full-screen viewer and the grid's histogram, analysis and near-duplicate grouping ignore edits.
- No editing several photos at once (Save all saves several, each with its own edit).

## Anti-goals

- **No file is ever changed in "info file" mode.** The only write is the `edit` field in `photoinfo.json`.
- **A file is never lost in "photo file" mode:** the original goes to the Recycle Bin (`shell.trashItem`)
  before the edited file takes its name. If the bin is unavailable, the save fails and nothing changes.
- Save as never overwrites the photo it was made from, and never writes outside the place the person
  picked in the system's save dialog.
- Keys typed in a field never act (same rule as the review keys); while editing, the review keys
  (arrows, F, H, Enter) are off.
- The preview must stay smooth: zoom and pan are CSS transforms, no re-render of the image.

## Decisions

### Preview fit (bug)
The stage's image is sized from the pane (measured), not from the picture: the image box is
`min(paneW/imgW, paneH/imgH)` of the image, centred. *(Root cause: the stage is a grid whose auto row
grows to the 1600 px picture's height, so `height: 100%` resolves to the picture, not the pane.)*

### Zoom
- Zoom is a factor of the fitted size, 1 (fit) to 8. Each wheel notch multiplies by 1.2, anchored at
  the pointer. Back at 1 the photo re-centres.
- Drag with the left button pans while zoomed; the image never leaves a gap at an edge it could cover.
- Double-click: zoomed → back to fit; at fit → opens the full-screen viewer, as today. *(My call:
  keeps the old double-click and adds the reset.)*
- Above the 1600 px picture's own size, the full-resolution picture is loaded (an upright JPEG from
  the gallery server, `GET /api/gallery/full`) and swapped in when ready.
- Changing photo, or the pane size, resets to fit.
- **Mini map:** shown only while zoom > 1. Top-right of the stage, 160 px on its long side,
  semi-transparent (opacity 0.75, 1 on hover), the small thumbnail with a rectangle for what is
  visible; the rest is dimmed. Clicking or dragging on it moves the view there. *(My call.)*

### Edit model (`photoinfo.json` field `edit`)
```
edit: { rotate: 0 | 90 | 180 | 270, straighten: number /* −45…45, degrees clockwise */,
        crop: { x: number, y: number, w: number, h: number } /* 0…1 */ }
```
Applied to the upright photo (EXIF orientation first), in this order:
1. turn clockwise by `rotate`;
2. turn by `straighten` about the centre, then keep the largest centred rectangle of the step-1
   aspect ratio that lies wholly inside the turned picture (no empty corners, as Google Photos does);
3. cut out `crop`, given as fractions of that rectangle.

No edit (`rotate` 0, `straighten` 0, crop the whole picture) is the same as no `edit` field; saving
it removes the field. The same pure function drives the page's display (CSS) and the server's render
(sharp), so they agree.

### Edit mode (centre pane)
- **Edit** button on the preview caption, the **E** key, or "Edit" in the right-click menu. Not
  offered while the photo is still being read, or in the full-screen viewer.
- The photo is shown whole (rotated / straightened), with the crop box over it: drag a corner or edge
  to resize, drag inside to move; outside is dimmed. Toolbar under it: aspect **Free / Original /
  Square / 4:5 / 3:2 / 16:9** (with a portrait/landscape swap for the non-square ones), **Rotate 90°**
  (anticlockwise, as Google Photos), **Straighten** slider (−45…45, 0.5° steps, double-click resets),
  **Reset**, **Cancel**, **Done**.
- Keys while editing: **Esc** cancel, **Enter** done, **R** rotate. Other review keys off; zoom off.
- Starting point: the photo's unsaved edit, else (info-file mode) its saved `edit`, else none.
- **Done** with a change makes it an *unsaved edit* (kept in the page, per photo); Done with no change
  from the saved state clears any unsaved edit. Cancel drops what was done in this session of editing.

### Unsaved and saved edits in the page
- The preview and the photo's grid tile show the edit (unsaved, else saved in info-file mode) through
  CSS. A tile with an unsaved edit has a small dot marker; the preview caption says "Edited · not saved".
- Saving, Save as and Save all appear in the preview caption when the photo has an unsaved edit
  (Save all whenever any photo has one, with the count). Also in the right-click menu.
- Leaving or reloading the window with unsaved edits: a native "You have unsaved edits to N photos.
  Close without saving?" dialog (Close / Keep editing). *(Renderer `beforeunload`, main handles
  `will-prevent-unload`.)* Opening another folder asks the same in the page.

### Saving
- **Save**, info-file mode: PATCH `edit` (or `null` for no edit) through the existing info path.
- **Save**, photo-file mode (desktop app only): the main process checks the photo is in the open
  folder, has the server render the edited picture to a temp file in the gallery's data folder, moves
  the original to the Recycle Bin, moves the temp file to the original's path, then asks the server to
  re-read that photo (new thumbnails, size, key). Any `edit` field for that photo is removed (the file
  now carries it). Written in the original's format for JPEG (quality 95), PNG and WebP, keeping EXIF
  (date, GPS, camera) with orientation reset to upright. HEIC can't be written: Save is disabled with
  "HEIC photos can only be saved as a copy" and Save as offers JPEG.
- **Save as…** (desktop app, either mode): the system's save dialog, starting in the photo's folder as
  `<name>-edited.<ext>` (JPEG for HEIC). The edit is rendered into the chosen file; the original and
  its info are untouched, and the unsaved edit stays on the original (so the person can still Save or
  Cancel it). *(My call: Save as is "a copy", it doesn't consume the edit.)* If the new file is inside
  the open folder it joins the grid, and it gets the original's star, people, date, location,
  description and notes. Picking the original's own path is refused.
- **Save all**: Save for every photo with an unsaved edit, one after another, then one toast
  ("Saved 12 photos" / "Saved 10, 2 failed: …"). In photo-file mode, HEIC photos are skipped and named.
- **Revert to original** (right-click menu and caption, info-file mode, photo with a saved `edit`):
  removes the field.
- In a plain browser (dev web build): photo-file mode and Save as are disabled with a note.

### Settings window
A ⚙ **Settings** button in the gallery's top bar opens a small dialog: "When I save an edit":
(•) **Change only the photo's info file** — "The photo stays as it is. The crop and rotation are kept
in photoinfo.json, and the photobook applies them when it brings the photo in." /
( ) **Change the photo file itself** — "The photo is rewritten. The original goes to the Recycle Bin."
Kept by the main process in the gallery's settings file (beside `mapsOnline`, key `editTarget:
'info' | 'file'`); in a plain browser, in localStorage. *(My call: one choice of two, since both at
once would apply the crop twice.)*

### The editor applies info-file edits
When the editor imports or re-syncs a photo whose `photoinfo.json` entry has an `edit`, it renders the
edited picture once into its data folder (`derived/<content hash>-<edit hash>.jpg`, quality 95, from
the working file) and uses it as the photo's working file: its size, thumbnails, analysis and every
export come from the edited picture. A photo already catalogued whose saved edit differs from the one
its working file was made with (including an edit removed) is processed again at the next import or
sync, the same as a photo whose file changed. *(Ruling, changing what I told Steven: "only new imports
pick it up" would leave a photo imported into a second book without its edit, because the editor's
catalogue is shared between books.)*

## Left to the builder
File layout, component names, the CSS of the crop box and mini map, exact handle hit sizes, how the
server finds the photoinfo fallback folder for the editor's importer (it already exists for stars),
and tests in the style the gallery already uses (Vitest for pure helpers, server and Electron logic
with injected seams; Playwright for the screen).
