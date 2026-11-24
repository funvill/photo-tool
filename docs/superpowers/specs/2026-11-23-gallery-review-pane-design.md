# Gallery: preview pane, quick keys, hidden photos, stacks and a sectioned info panel

**Date:** 2026-11-23
**Builds on:** `2026-11-23-gallery-and-photo-info-design.md` (Part 2, Photobook Gallery)

## Why

The gallery is where Steven goes through a year of photos and picks what goes in the book. Today,
seeing a photo large means resting the pointer on a tile (the hover preview) or opening the
full-screen viewer, and every star is a mouse click. This change turns the main screen into a
review screen: a big picture of the current photo always in view, the keyboard to move and judge
(favourite, hide), bursts folded so they don't flood the grid, and an info panel with the camera
facts and a histogram, tidied into sections that can be folded away.

## Goals

1. **Preview pane.** Three columns: thumbnails | large preview of the selected photo | info panel
   (far right, as today). The hover preview goes from the gallery.
2. **Keys to move.** ← / → step to the previous / next photo in grid order; ↑ / ↓ move a row.
   The grid scrolls to keep the selected photo in view. Clicking a tile still selects it.
3. **F** toggles favourite.
4. **H** toggles hidden. Hidden photos can be filtered out.
5. **Stacks.** Near-duplicate photos show as one tile with a count; clicking the count unfolds the
   stack in place in the grid.
6. **Sectioned info panel.** The right panel's parts are collapsible sections, including a new
   **Histogram** and a **Camera** section with the key photo information.
7. **Right-click menu** on a photo: copy the image, copy the path, show in file explorer, delete.

## Non-goals

- No changes to the editor beyond what `photoinfo.json` already shares. The editor ignores
  `hidden` for now.
- No new grouping rule: stacks use the near-duplicate groups the gallery already computes.
- No zoom or pan in the preview pane (the full-screen viewer stays for that).

## Anti-goals

- A key press while typing in a field (people, description, notes, date, search) must never star,
  hide or move. Same rule the grid's Enter/Space already follows.
- Hiding must never delete or move a file. It is one field in `photoinfo.json`.
- Delete must never erase a file beyond recovery, and never touch a file outside the open folder.
- The grid must stay smooth on folders of thousands of photos (it stays virtual).

## Decisions

### Favourite is the existing star
**F** toggles the same `star` the tile button and the viewer's **S** set, so favourites keep
reaching the editor through "Update from stars". **S** keeps working in the viewer. *(My call:
two "favourite" ideas would split the one list the editor reads.)*

### Hidden
- Stored as `hidden: true` in the photo's `photoinfo.json` entry; un-hiding removes the field.
  Saved through the existing PATCH `/api/gallery/info` path (same stamps, per-photo queue,
  read-only-folder fallback) as every other field.
- Filter bar gets **Hidden: leave out (default) / show / only**. *(My call: the default leaves
  them out, so H works as "get this out of my way" while culling.)*
- Pressing **H** on a photo that the filter then leaves out moves the selection to the next photo
  (or the previous, at the end), so you can keep pressing H down a run of bad shots.
- When shown, a hidden photo's tile is dimmed with a small "hidden" mark; the preview says so too.

### F and H on a multi-selection
With several photos selected (Ctrl/Shift-click), F and H apply to all of them: they all become the
opposite of the focused photo's current state. *(My call: matches how a toggle on one photo reads.)*
F and H also work in the full-screen viewer.

### Keys
- ← / → previous / next in the shown order (unfolded stack members included; a folded stack is one
  step). ↑ / ↓ one row up / down. Home / End first / last. Plain arrows replace the selection;
  Shift+arrow is out of scope.
- Enter / Space still open the full-screen viewer; Esc closes it. Inside the viewer, its own
  ← / → keep working.
- All keys are ignored while focus is in an input, textarea, select, contenteditable or a dialog.

### Preview pane
- Shows the selected photo's 1600 px thumbnail, fitted to the pane (no crop), on a dark
  background. Under it: file name, and badges for favourite / hidden / "1 of 5 in stack".
- Double-click the preview opens the full-screen viewer.
- Column widths: the thumbnail column and the info panel each have a drag handle; the preview
  takes the rest. Widths are remembered per machine (localStorage). The thumbnail-size slider
  keeps working inside the thumbnail column. *(My call.)*
- Nothing selected (new folder): the first shown photo is selected.

### Stacks
- **Stack near-duplicates** toggle in the filter bar, on by default.
- One tile per group. The top photo is the favourited member if there is one, else the group's
  suggested keeper. The tile shows a "×N" badge (N = members currently shown by the filter).
- Clicking the badge unfolds the stack: the other members appear right after the top photo,
  in sort order, with a shared tinted outline. Clicking the badge again folds it. Several stacks
  may be open at once; open stacks reset when the folder changes.
- The stack sits where its top photo sorts. A filter that leaves out every member hides the stack;
  one that leaves out some just lowers N (and a stack of one is a plain tile).
- Dragging a folded stack's tile drags only the top photo. *(My call: dragging five photos you
  can't see would surprise.)*
- The **Near duplicates** filter keeps working; with stacks on, it shows the stacks.

### Info panel sections
Collapsible sections, each with a header that folds it; open/closed is remembered per machine:

1. **Photo** — taken, size in px and MB, megapixels, aspect ratio, orientation, format, folder.
2. **Camera** — camera, lens, focal length (and 35 mm equivalent), aperture, shutter speed, ISO,
   exposure compensation, flash fired. Rows with no data are left out; no data at all says
   "No camera details in this file".
3. **Histogram** — red, green, blue and luminance overlaid, from the 1600 px thumbnail, worked out
   in the page (canvas) when the photo is selected. Under it: the clipped-shadow and
   clipped-highlight percentages the scan already measures, flagged when high.
4. **Place** — location editor, country, coordinates.
5. **People**, **Date and time**, **Description and notes** — the existing editors, unchanged.

*(My call on the grouping and order; the existing fields only move.)*

### Right-click menu
Right-clicking a tile or the preview opens a menu, drawn in the page in the same style as the
editor's canvas menu (`.ctx-menu`), each item with an icon from `src/web/components/Icon.tsx`:

| Item | Icon | Does |
|---|---|---|
| Copy to clipboard | `image` | Puts the photo itself on the clipboard as an image, at full size (HEIC and other formats Electron can't read are converted to PNG first by the gallery server). Pastes into chat apps, documents, image editors. |
| Copy path to clipboard | `copy` | The full file path as text; with several photos selected, every selected path, one per line. |
| Show in file explorer | `folder` | Opens the folder with the photo selected (Explorer on Windows, the file manager on Linux). |
| Delete | `trash` | Moves the photo to the Recycle Bin / Trash, after a confirm dialog that names the file (or the count). With several selected, deletes them all. |

- Right-clicking a tile that is not selected selects it first; right-clicking one of several
  selected photos keeps the selection (so Copy path and Delete act on all of them; Copy to
  clipboard and Show in file explorer act on the photo clicked).
- The menu also carries **Favourite (F)** and **Hide (H)** with their shortcut shown. *(My call:
  makes the keys discoverable.)*
- **Delete goes to the Recycle Bin, not straight off the disk** (Electron `shell.trashItem`).
  *(My call: a mis-click on a year of photos must be undoable. If the bin is unavailable, e.g. some
  network drives, the delete fails with a toast rather than erasing permanently.)* After a delete
  the photo leaves the grid and the cache, its `photoinfo.json` entry is removed, and the selection
  moves to the next photo.
- These actions run in the Electron main process over new IPC calls, with the same `fromApp`
  origin check as the drag handlers, and only for paths inside the open folder (checked on the
  server, as drag-check does). In a plain browser (the dev web build) the items that need the
  desktop are greyed out.

### Camera details from the scan
`readMetadata` reads more EXIF tags (ExposureTime, FNumber, ISOSpeedRatings/ISO, FocalLength,
FocalLengthIn35mmFormat, ExposureBiasValue, Flash, LensModel/LensMake). The gallery cache stores
them as a new `exif` JSON column, added to an existing `gallery.sqlite` on open. A cached photo
that has no `exif` yet gets its metadata re-read on the next scan without redoing thumbnails or
analysis, so old folders fill in on their next open.

## Left to the builder

File layout, component names, how stacks are folded into the visible list (a pure helper in
`src/core` alongside `gallerySort.ts`, tested), histogram bin count and drawing, the exact
drag-handle limits, and tests in the style the gallery already uses (Vitest for helpers and server,
Playwright for the screen).
