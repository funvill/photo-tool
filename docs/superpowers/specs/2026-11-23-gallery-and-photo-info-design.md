# Gallery program, photo info file, and file drops into the book editor

Date 2026-11-23. Status: draft for Steven's review. Builds on [plan.md](../../plan.md) and [electron-plan.md](../../electron-plan.md).

## Why

Steven's first use of the editor (2026-11-23) showed that choosing photos is a bigger job than laying them out. He will import thousands of photos a year: some already narrowed down in Google Photos, some straight from disk. Today the editor's library is a narrow two-column panel with a small preview, five filters and one sort order, which is fine for 400 already-chosen photos and not for picking from thousands.

He wants picking to happen in a **separate program**, a general photo gallery he can use for other things too, and the book editor to accept photos dragged in from anywhere: that gallery, or File Explorer. Neither program depends on the other. What they share is a small file beside the photos that records what was decided about each one: starred or not, who is in it, a corrected date or place, a description, notes.

This changes one line of plan.md: "Replacing Google Photos for choosing favourites" is no longer a non-goal. Google Photos stays the first pass; the gallery is the second.

## Goals

- **The editor takes dropped files.** A photo dragged from Explorer, the gallery or any other program onto a page is imported into the book and placed, like a drag from the library panel today.
- **A photo info file per folder** that survives the folder being moved, copied or backed up, is readable in Notepad, and can hold more kinds of information over time.
- **A gallery program** for picking from thousands of photos in a folder: sort, filter, a large preview, a full-screen viewer with one-key starring, editing of people, date, place, description and notes.
- **Auto-draft from starred photos, and update it later.** A book's draft uses the starred photos; clicking auto-draft again after changing stars updates the book without undoing hand fixes. Dragging is for fixes.
- **The small editor fixes** from the same session: time left during import, a library panel that can be widened, a large preview on hover.

## Non-goals

- Editing pixels (exposure, straightening, retouching).
- Face recognition. People are typed, with suggestions from names already used.
- Syncing with Google Photos or any online service. Both programs work fully offline, like the rest of the desktop app.
- Moving or renaming photo files to sort them. "Low quality" is a filter, not a folder.
- A web version of the gallery. It relies on dragging real files out to other programs, which a web page cannot do. The web version of the editor still accepts dropped files (see below).
- macOS. Windows and Linux, as for the desktop app.

## Would make it a failure

- The original photo files are changed in any way.
- The photo info file is lost or silently goes stale when a folder is moved or copied.
- Two programs writing the same photo info file lose each other's changes.
- The gallery is too slow on a folder of a few thousand photos to be quicker than Google Photos.
- Starring something in the gallery and not seeing it reflected in the book, with no explanation.

## Approaches considered

1. **A second window of the same editor app**, sharing its server and library. Least new code, but tied to the book editor and useless for anything else.
2. **One window with a gallery panel that can be popped out.** Simplest to keep in step, but closes with the editor and is even more tied to it.
3. **A separate gallery program; the editor accepts dropped files; they share a file beside the photos.** **Chosen by Steven.** Either program is useful alone, Explorer works as a stand-in gallery, and decisions travel with the photos instead of living in one program's database.

Where stars live was decided separately. The options were a picks folder the gallery copies or links photos into, a rating written into each photo's own metadata (what Explorer and Lightroom use), and a small list file beside the photos. **Steven chose the list file**, generalised to hold every kind of per-photo information.

## The photo info file

The contract between the two programs. Both must read and write it through one shared module.

- **One file per folder**, holding entries only for the photos directly in that folder. Subfolders have their own.
- **Name:** `photoinfo.json`. *My call:* visible rather than a hidden dot-file, so it is copied by every tool and obvious to anyone looking in the folder. Steven asked only that the name be generic.
- **Photos keyed by file name**, not full path, so the file stays valid when the folder is moved, renamed, copied to another drive or restored from backup.
- **Plain JSON, pretty-printed, UTF-8**, with a format version.
- **Shape:**

  ```json
  {
    "format": "photoinfo/1",
    "photos": {
      "IMG_2041.HEIC": {
        "star": true,
        "people": ["Steven", "Alex"],
        "date": "2025-08-12T17:40:00",
        "location": { "lat": 49.1529, "lon": -125.9066, "name": "Chesterman Beach, Tofino" },
        "description": "First swim of the trip",
        "notes": "Slightly soft, but keep it"
      }
    }
  }
  ```

  Every field is optional. `date` and `location` are overrides: when present they replace what the camera recorded, for every program that reads the file. `notes` is Steven's "feedback": free text about the photo, never printed.
- **Unknown fields are kept.** A program must preserve fields and entries it does not understand when it writes the file, so new kinds of information can be added later (named lists, ratings, captions) without breaking older versions.
- **Entries for missing files are kept**, not cleaned up automatically: a photo might be on a drive that is not plugged in, or renamed outside the gallery. The gallery offers to tidy them.
- **Renames inside the gallery** update the entry. Renames elsewhere orphan it (see above).
- **Writing:** read the current file, apply only the change being made, write to a temporary file in the same folder, then rename it over the original. This avoids a half-written file and avoids one program overwriting another's changes made since it last read the file.
- **Read-only folders** (a memory card, some cloud-synced folders): keep the folder's information in **one fallback location shared by both programs** (a `photoinfo` folder under the desktop app's user-data folder, one file per photo folder, keyed by the folder's full path), and say so in the interface. Both programs check there when a folder's own file cannot be written, so a star set on a memory card in the gallery still reaches the editor. *My call.*
- **A star is a single yes/no.** Steven was asked about named lists ("2025 book", "Christmas card") and did not take them up; the format leaves room to add them later. *My call.*

## Part 1: the book editor

Built first, because it makes Explorer usable as the gallery immediately.

### Dropping files

- Dropping one or more image files onto a frame, onto empty space on a page, or onto the library panel works like dropping a photo from the library panel today: onto a frame replaces it, onto empty space adds it, onto the library only imports.
- A dropped file not yet in the book is imported first (thumbnail, analysis, the usual checks), then placed. The page shows a placeholder while it imports, typically under a second for a JPEG.
- **Desktop:** the page gets the file's location through a new preload function using Electron's `webUtils.getPathForFile`; the server imports that path. The original stays where it is, as with folder imports today.
- **Web version:** the browser gives the file's contents but not its location, so the browser backend stores the file the way its importer already does.
- Formats accepted are the ones import already accepts; anything else gets a clear message, not a silent failure.
- Dropping a whole folder imports it, the same as the Import button.

### Reading the photo info file

- **The book's folders** are every folder that at least one of the book's photos sits in, however it got there: a linked folder, the Import button, or a single dropped file. *My call.* For a yearly book that is typically a handful of folders, at most a few hundred.
- Importing or syncing reads each of those folders' `photoinfo.json`. While a book is open the editor checks those files for changes (only the info files, not the folders' contents) and refreshes when one changes, so starring in the gallery shows up without re-importing, including for a photo that was dropped in on its own.
- **Desktop only.** The web version of the editor does not read or write `photoinfo.json` and keeps its own stored star, as today. Safari and Firefox have no folder to write to, and Steven's use is the desktop app. The shared module can therefore use Node. *My call.*
- `star` becomes the photo's favourite flag, replacing the editor's own stored flag. The star button in the editor writes the photo info file through the shared module, so there is one star, not two.
- **Existing stored favourites are ignored, not migrated.** The only existing data is the 2023 trial book, so no files are written beside photos on upgrade. The stored column stays (the web version still uses it). `rating` and `tags` stay in the database unchanged; they are out of scope. *My call.*
- `date` and `location` overrides replace the camera's date and GPS everywhere the editor uses them: ordering, the date captions, place lookups.
- `people` and `description` are stored on the photo and shown in the preview. Using them in captions is plan.md phase 3, not this work.

### Auto-draft from starred photos, and updating it

Decided by Steven: auto-draft reads the stars as they are when he clicks it. Starring or unstarring later changes nothing until he clicks it again, and then it **updates the existing book** (adds newly starred photos, takes out or replaces unstarred ones) instead of rebuilding it. Where an update would touch something he did by hand, **his hand work wins**.

This differs from today's generator (`src/core/generator.ts`), which rebuilds every page except spreads marked `locked`. The update is new work in the layout engine.

**First draft** (a book with no auto-placed pages yet):

- Uses exactly the book's starred photos. Unstarred photos stay in the library and can be dragged in by hand.
- If nothing is starred at all, uses every photo as today and says so. *My call:* otherwise a first draft before any starring would be empty.
- Page count starts from the book's target, with density between 4 and 7 a page; if the starred photos do not fit at 7 a page, pages are added and the draft says so.

**Update** (every later click):

- **Unstarred photo on an auto-placed page:** removed from its frame. If a newly starred photo from the same day fits the frame's orientation, it takes the frame; otherwise the page is re-laid with one photo fewer, using the same template rules as a fresh draft.
- **Newly starred photo:** placed on the auto-placed pages for its date. A page gains a photo up to 7; when the pages for that date are full, a page is added after them. Chronological order is kept.
- **Page count follows the stars:** pages are added or removed only when pages fill or empty, and spreads stay paired. The update reports the new count ("added 2 pages, now 92").
- **Untouched photos and pages stay as they are,** including crops.
- **A summary afterwards:** photos added, removed and replaced, pages re-laid, added and removed, with a way to jump to each changed page. The update is one undo step.

**Hand work wins:**

- A page Steven has edited by hand (moved, resized, swapped, re-cropped, changed template, added or removed a photo, edited text) is never re-laid by an update. If a photo on it has been unstarred, its frame is left empty and marked for him to fill or remove; nothing is placed there automatically.
- A photo Steven placed by hand stays in the book even if it is not starred, on any page.
- Spreads marked `locked` keep working as today and count as hand-edited.
- To get the editor's layout back for a hand-edited page, Steven can re-lay that page on its own (an explicit command), after which it counts as auto-placed again.

**What the book has to remember:** for each placed photo, whether the editor or Steven put it there; for each page, whether Steven has edited it since the editor last laid it out. Both are new fields in the book document, set by the editor's existing edit actions, with a schema migration that treats every page of an existing book as auto-placed and unedited. *My call:* the 2023 trial book is the only existing data.

### The smaller fixes

- **Time left during import**, from the rate so far, shown after the first few photos. Applies to the gallery's analysis too.
- **A library panel that can be widened** by dragging its edge, with more columns as it widens, remembered per computer.
- **A large preview on hover:** resting the pointer on a library photo for a moment shows it across most of the right-hand side, from the 1600 px preview images the editor already makes. It disappears when the pointer leaves.

## Part 2: the gallery program

A separate desktop program in the same repository and installer, with its own Start-menu shortcut and its own window. It shares code with the editor (image decoding including HEIC, thumbnails, the blur and exposure analysis, near-duplicate grouping, offline place names, the photo info module) but not its database or book data.

### Opening photos

- Open a folder, optionally including subfolders. Recent folders are remembered.
- Thumbnails and analysis are cached in the program's own data folder, keyed by file path, size and modification time, so reopening a folder is instant. Nothing is written beside the photos except `photoinfo.json`.
- Analysis runs in the background with a progress bar and time left. The grid is usable before it finishes; sorts and filters that need analysis fill in as it goes.

### Browsing

- A grid with adjustable thumbnail size, built to stay smooth at several thousand photos.
- A large preview on hover, as in the editor.
- A details panel for the selected photo: file name, date and time taken, camera, size, location, and the editable fields from the photo info file (people with suggestions from names already used, date, location with offline place-name search, description, notes). Edits are saved straight away.

### Sorting and filtering

- **Sort by:** date taken (default), "interesting", main colour, file name.
- **"Interesting"** is a score from what analysis already measures: sharpness, exposure, colour variety, and whether a photo is the best of a burst of near-identical shots. No face detection, so faces do not count yet.
- **Filters**, combinable: starred or not, date range, low quality (blurry, too dark, too bright, low resolution, using the editor's existing Clean up rules), near-duplicates, portrait or landscape, has a location, people (any named person), subfolder, and text search over description and notes.

### Full-screen viewer

- Opens on the selected photo and steps through whatever the grid currently shows, in its current order, so Steven can filter first and then review just those photos.
- Keys: left and right arrows to move, **S** to star or unstar, **I** to show or hide details, **Esc** to close. Starring shows a clear on-screen mark.
- Loads the next and previous photos ahead so stepping feels instant.

### Dragging out

- Dragging one or more photos out of the grid starts a real file drag of the originals, through Electron's `webContents.startDrag`. The editor, Explorer, an email or any other program receives ordinary files. There is no special link between the gallery and the editor.

## Order of work

1. Shared photo info module, with tests for preserving unknown fields, concurrent writes and read-only folders.
2. Editor: file drops, reading and watching photo info files, star from the file, overrides, first draft from starred photos.
3. Editor: remembering hand edits, and updating an existing draft.
4. Editor: time left, wider panel, hover preview.
5. Gallery: open a folder, grid, cache, background analysis.
6. Gallery: details panel and editing, sorting and filtering, "interesting" score.
7. Gallery: full-screen viewer, dragging out.
8. Installer: both programs in one installer, two shortcuts, both pass the offline checks the editor already has.

Each step ends with something Steven can use. After step 2 he can pick photos in Explorer and fix the book by dragging; after step 3 he can re-star and update without losing fixes.

## Left to the builder

- Interface layout and look of the gallery, within the editor's existing style.
- How the "interesting" score weights its inputs.
- How "main colour" is grouped (hue buckets, or nearest of a fixed palette).
- Thumbnail sizes and cache layout.
- How the editor watches files (polling or file-system events).
- Whether the gallery and editor are two entry points of one Electron build or two builds.

## Calls made here that Steven has not confirmed

- The file name `photoinfo.json`, visible rather than hidden.
- A star is a single yes/no; named lists can come later.
- Read-only folders fall back to one location shared by both programs.
- The book's folders are every folder any of its photos sits in, and only the info files are watched.
- The web version of the editor ignores `photoinfo.json` and keeps its own star.
- Existing stored favourites are ignored, not migrated; `rating` and `tags` are untouched.
- With no starred photos, auto-draft uses every photo in the book.
- The exact update rules: same-day replacement into a matching frame, up to 7 a page before a page is added, empty frames left on hand-edited pages, an explicit "re-lay this page" command.
- Existing books are migrated as all auto-placed and unedited.
- The editor's star button writes the photo info file, so there is one star.
- No web version of the gallery.
