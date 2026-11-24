# Photo book helper: plan

Last updated 2026-11-22. Status: draft for Steven's review. Evidence is in [research.md](research.md).

## What this is for

Steven makes one 12×12 photo book a year, about 100 pages and 400 to 800 photos, printed by Blurb. Today that takes about three months: 2 to 3 weeks choosing favourites in Google Photos, then downloading and cropping them, then 3 to 4 days placing them in BookWright. The books end up locked in BookWright's format, and since 2022 the caption strips on the pages have been left empty because filling them is too much work.

The tool should:

1. Take a set of chosen photos and produce a complete first-draft book automatically.
2. Let Steven fix that draft: move, swap, re-crop, change a page's template.
3. Export a PDF any printer accepts, Blurb included.
4. Fill in captions (date, place, people) with as little typing as possible.
5. Be reusable every year, with templates and rules that accumulate.

## Goals

- **A full draft in minutes.** Every chosen photo placed on a page, in sensible order, in slots that match its orientation.
- **Dense pages by default.** 4 to 7 photos a page, with single-photo pages and full spreads as the exception.
- **Steven's own templates.** Seeded from the layouts in his past books, not generic ones.
- **No pre-cropping.** Crop inside the tool, per slot, without touching the original file.
- **Printer-independent output.** Page size, bleed, safe margins and spine are a printer profile, not hard-coded.
- **Captions that mostly write themselves.**
- **The fixed pieces:** a multi-photo front cover, a sunset back cover, a Year in Review opener.
- **A book project that is a plain, readable file,** so it survives the tool and can be diffed, backed up and reopened next year.

## Not goals

- Replacing Google Photos for choosing favourites. Choosing can still happen there, but stars can now also be set in the editor or by a gallery program, and are kept in a `photoinfo.json` beside the photos (see the 2026-11-23 design in `docs/superpowers/specs/`). No Google Photos library access is built.
- A general design tool with free-form drawing, shapes and effects.
- A product for other people. One user, one machine, no accounts.
- Ordering from the printer automatically. The tool stops at the PDF.

## What would make it a failure

- The draft needs so much fixing that it is no faster than BookWright.
- A printed book comes back with photos cut off at the edge or lost in the binding.
- Output only Blurb can print.
- Captions that are wrong often enough that every one has to be checked.

## Approach

Three were considered.

1. **A script that generates the PDF from a config file, no editor.** Fastest to build, but every fix means editing a text file and re-running. Fails the "move photos around" requirement for a 100-page book.
2. **Generate a BookWright project and keep editing there.** The `.blurb` format is readable and probably writable, so the auto-layout could feed BookWright. But it keeps the book locked to Blurb's tool, which is the thing to get away from, and it depends on an undocumented format that can change.
3. **Own tool: a layout engine, a browser-based editor running locally, and a PDF exporter, sharing one project file.** More to build, but it is the only one that meets all five aims.

**Chosen: 3, starting from a fork of photobook_studio** instead of an empty folder. It is an MIT-licensed tool that already has the editor, crop, undo, cover geometry, preflight and checked PDF export (evaluation in research.md section 8.1). The work then becomes adding what is specific to Steven: his templates, his page density, event grouping, captions, his cover and Year in Review, and a corrected Blurb 12×12 profile.

A trial on Steven's PC on 2026-11-22 supports this (research.md section 8.2): it installed cleanly on Windows, imported the 403 real photos from 2023, drafted an 86-page book placing all of them at 4 to 6 a page, and exported a 306 MB interior PDF at exactly Blurb's 855 × 864 pt. Still open: nobody has looked at the pages or used the editor yet, and 800 photos has not been tried. If either disappoints, fall back to building fresh with the same design, borrowing its layout and PDF code.

Calls made here that Steven has not confirmed:

- **Forking over building fresh.** Trades a faster start for owning about 15,000 to 20,000 lines of someone else's two-week-old code, some of it for features that will never be used (posters, stickers, calendars). Unused parts can be deleted over time.
- **Its stack is kept:** TypeScript, React, a local Node server, PDFKit. Blurb accepts sRGB and does not appear to require PDF/X, so nothing heavier is needed.
- **The editor is free-form as well as template-based,** because the fork already is. That removes the earlier question of whether template-only editing would be enough.
- **The book is stored in the fork's SQLite database,** with a single-file backup, not a plain text project file. Add a readable JSON export if that matters.

## How it works

```
photos folder ──► import ──► auto-layout ──► book project file ──► export ──► interior.pdf + cover.pdf
 (+ metadata)                                       ▲   │
                                                    └───┘
                                                    editor
```

### Import

- Point at a folder (the year's downloaded favourites).
- Read per photo: pixel size, orientation, date taken, GPS, camera.
- Build thumbnails and screen-size previews so the editor stays fast with 800 photos.
- Originals are never modified.

### Auto-layout

Rules taken from the past books:

1. Sort by date taken, then split into **events**: runs of photos close together in time and place. A trip is one event; so is an afternoon.
2. Keep an event's photos together on consecutive pages. Events run in date order; Steven can drag whole events around.
3. For each page, pick a template whose slots match the next photos' orientations: landscape into landscape, portrait into portrait, either into square. Opposite-orientation placement is a last resort.
4. Prefer 4 to 7 photos a page. Give an event a single-photo page or a spread only when a photo is marked as a hero.
5. Default each crop to centre, shifted to keep faces in frame where they can be detected.
6. Left and right pages use mirrored margins so nothing falls in the binding.
7. Fit to a target page count (even, within the printer's limits) by tightening or loosening density.

### Templates

- Stored as small JSON files: a list of slots with position, size and kind (photo, caption, text).
- First set extracted from Steven's books and `MyLayouts` folder: 3×2 portrait, 2×3 landscape, 2 large + 3 small, 2×2, 7-up mixed, 5×5 squares, full page, full spread, title + text + photo, Year in Review, cover.
- Each has a left-page and right-page form, and a with-caption and without-caption form.

### Editor

- Page-spread view with a filmstrip of all pages and a tray of unplaced photos.
- Drag a photo onto another to swap. Drag between pages. Drag pages or whole events to reorder.
- Pick another template for a page; photos re-flow into it.
- Pan and zoom a photo inside its slot to set the crop.
- Mark a photo as hero (gets a big slot) or remove it from the book.
- Edit captions in place.
- Warnings for low resolution, a face near the trim edge, or content in the binding margin.

### Captions

- **Date:** from the photo.
- **Place:** from coordinates, looked up to a name such as "Tofino, BC". Only about 2% of the downloaded 2023 favourites carry coordinates, so in practice place has to come from a Google Takeout sidecar or be typed once per event.
- **People:** from the face-tag names in a Google Takeout sidecar if that proves out, otherwise typed once per event rather than per photo.
- **Typing once per event** is the fallback for both: an event has one place and one set of people, and every page of that event inherits them.
- Written per page into the existing caption strip ("Tofino, BC · August 12 to 14"), with per-photo captions optional.
- **Year in Review:** a first draft generated from the event list, for Steven to edit.

### Export

- Interior PDF: one page per PDF page, at the printer profile's size and bleed.
- Cover PDF: back, spine, front, sized from the final page count and paper.
- A printer profile for Blurb Large Square first; others added as files.
- A low-resolution proof PDF for reading through on screen before the real export.

### Google Photos

Google closed library access to third-party apps in March 2025 (research.md section 5). What is left:

| Route | Gets the photos | Gets place and people | Effort each year |
|---|---|---|---|
| Download the favourites, as now | Yes | Place for about 2% only | What Steven does today |
| Google Takeout of "Photos from YYYY" | Yes, the whole year | Reportedly yes, plus the favourite flag | One export request, a large download |
| Picker API link | Yes, after re-selecting them in a Google window | No; GPS is stripped | Building a Google sign-in, then picking every year |

Start with the folder Steven already downloads. Test a Takeout early, because if its sidecars are as reported it supplies captions and removes the manual download in one step: the tool reads the year's export and keeps only the favourites. The Picker link is the least useful of the three and is dropped unless Takeout fails.

## Build order

Each phase ends with something usable.

| Phase | Delivers | Proves |
|---|---|---|
| 0a. Trial | Steven tries photobook_studio's web version in Edge or Chrome with the 2023 favourites folder: import, auto-draft at 90 pages, edit a few spreads, export. Separately, request one Google Takeout of "Photos from 2025" and inspect its sidecars. | Whether it copes with 400 to 800 real photos and feels usable; whether Takeout really supplies people, places and the favourite flag. |
| 0b. Fork and run on Windows. **Done 2026-11-22.** | This folder is now a git repo holding photobook_studio's code and history (remote `upstream`), with the 2023 photos drafted into an 86-page book that opens in the editor | The base works on his machine. |
| 1. Blurb profile and reproduce 2023 | Correct the Blurb Large Square preset to the calculator's figures. Import `2023.blurb` into a book and export it. | The PDF matches Blurb's spec and the printed book on the shelf. The importer also yields the template files. |
| 2. Steven's templates and density | His grids (3×2 and 2×3, 2 large + 3 small, 2×2, 7-up, 5×5, with and without caption strip), and a draft style that averages 5 to 7 photos a page | An auto-draft of the 2023 and 2022 favourites looks like the books he actually made. |
| 2b. Stars and draft updates. **Done 2026-11-23** (not yet tried on the real 2023 photos). | Stars, dates, places and people read from `photoinfo.json`; star a photo in the editor and it is written back; draft from the starred photos, then **Update from stars** to follow later changes without losing hand edits; drag photos in from Explorer | Choosing favourites no longer needs Google Photos or a re-download, and a changed star does not mean redoing the book. |
| 2c. Photobook Gallery. **Built 2026-11-23 on branch `gallery`, not merged.** | A second desktop program (`--gallery`, its own Start-menu shortcut) for looking through a folder, starring, filtering and dragging photos into the editor; stars go to the same `photoinfo.json`. Human checks are listed in [handoff.md](handoff.md#photobook-gallery). | Choosing favourites happens on the computer, in a program made for it, and reaches the book without a re-download. |
| 3. Events and captions | Group by event instead of by day; date and place captions; people where available; Year in Review draft | Caption strips get filled. |
| 4. Cover and fixed pages | His cover design (sunset back, six-photo front, places on the spine), Year in Review opener | A complete, orderable book. |
| 5. Takeout import | Read a year's Takeout directly and keep the favourites, if 0a proved it out | No manual download step. |

Phase 1 deliberately uses a book that already exists in print: any difference between our PDF and the book on the shelf is a bug found before money is spent on printing.

A first real book should be ordered as a single proof copy before any larger order.

## Where things are

State of this folder after the fork on 2026-11-22:

| Path | What |
|---|---|
| `src/`, `tests/`, `README.md`, `docs/ARCHITECTURE.md` | photobook_studio as of its commit of 2026-11-07, unchanged |
| `docs/plan.md`, `docs/research.md` | This plan and its evidence |
| `scripts/draft-from-folder.ts` | New. Makes a Blurb Large Square book from a folder and auto-drafts it, with the trim corrected to 11.75 in |
| `photos/2023/` | The 403 originals extracted from `2023.blurb`. Not in git. |
| `data/` | The app's database and thumbnails, holding the book "2023 (trial draft)". Not in git. |
| `trial-output/` | PDFs exported during the trial. Not in git. |

To run it:

```powershell
npm run dev
```

Then open <http://127.0.0.1:5173>.

Known state of the checks on Windows: type check passes; 377 of 378 unit tests pass (one temp-folder clean-up fails); the end-to-end test fails because its sample HEIC photo can only be generated on a Mac. Making those two green on Windows is the first small job in the fork.

Nothing has been committed and nothing has been pushed. There is no copy of this fork on GitHub yet.

## Open questions for Steven

1. **Does photobook_studio feel right when you try it?** Open <https://jkw2lo.github.io/photobook_studio/> in Edge or Chrome, make a Custom-printer book, and import your 2023 favourites folder. Nothing is uploaded. What you like and dislike in half an hour decides whether to fork it.
2. **What is the pre-crop step for?** If it is to straighten horizons or fix exposure rather than to change the frame, the tool needs to pick up edited copies, not just originals.
3. **Which year is the first real book**, and when do you want to order it? That sets how far down the build order to go before using it in anger.
4. **Black or white pages:** Eclipse 2024 went all black; earlier books are mostly white. Is black the direction from now on?
5. **Would you run one Google Takeout** of "Photos from 2025" now, so its contents can be checked? It is the only route to automatic people names, and probably the best route to place names.
6. **Place lookups:** town-level names can be done entirely offline. Finer names ("Chesterman Beach") mean sending photo coordinates to OpenStreetMap's server. Is that acceptable?
