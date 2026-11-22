# Photo book helper: research

Last updated 2026-11-22. Companion to [plan.md](plan.md).

## 1. How the books get made today

From Steven, 2026-11-22:

| Stage | Where | Time |
|---|---|---|
| Review the year's photos and mark favourites | Google Photos | 2 to 3 weeks |
| Download the favourites, crop them, tidy them into a working folder | Local disk | "a little more time" |
| Build the book | BookWright | 3 to 4 days of work |
| Order | Blurb | |

End to end this takes about three months of calendar time.

BookWright's own counter (`editingDurationMinutes` in each project) says 234 minutes for 2023, 441 for 2022 and 633 for Eclipse 2024. Steven's recollection is 3 to 4 days for 2023, so treat that counter as unreliable.

## 2. The past books

Location: `\\chipkin_nas\steven\vault\1.projects\11.photobook`

### 2.1 File format

A `.blurb` file is a SQLite 3 database, not a proprietary blob. It has one useful table, `Files(filepath, filecontent, filesize, filedate)`, which acts as a small file system:

| Path | Content |
|---|---|
| `bbf2.xml` | The whole book: cover, pages, every container's position, every photo's crop |
| `media_registry.xml` | One entry per imported photo: original path, pixel size, date taken, camera |
| `project_settings.json` | Cover type, paper type, editing minutes |
| `images/<guid>.jpg` | The original photos, full size |
| `thumbnails_small/<guid>.jpg` | Thumbnails |
| `old_bbfs/*.xml` | Earlier saves of the layout |

Quirks found while reading them:

- Blobs can carry stale trailing bytes after the real content. Cut XML at the first closing root tag and JSON at the last `}`.
- Opening over the network works with a read-only immutable URI: `file:////chipkin_nas/...?mode=ro&immutable=1`.

Layout XML shape:

```xml
<book width="855" height="864" format="large-square">
  <cover type="imagewrap" papertype="premium_matte_paper">
    <coversheet width="1801" height="918" color="#000000"> ...containers... </coversheet>
  </cover>
  <section>
    <page number="1" color="#000000" [spread="..."]>
      <container x y width height type="image|text">
        <image src="<guid>.jpg" x y scale rotate flip/>
        <shape borderColor borderWidth .../>
        <text valign> ...HTML... </text>
      </container>
    </page>
  </section>
</book>
```

Units are PDF points (1/72 inch). `image/@scale` is points per source pixel, and `image/@x,y` is the offset of the photo inside its container, so every crop Steven ever made is recoverable.

Saved custom layouts live in `MyLayouts/*.layout` as JSON with the same container geometry. There are 15, named for their use: `2024-2x2-text`, `2024-3x2-text`, `2024-2x3_long_notext`, `2024a-2x3`, `2024-5x5-white`, `2024-9x9-text`, `2024-Birds`, `2024-cover`, `2024-large`, `2024-side-by-side`, `2024-year-in-review`, `2x2 left`, `4x4-4x4`, `full-sheet`, `full-spread`.

### 2.2 The books

All are Large Square 12×12, 855 × 864 pt pages, ImageWrap hardcover.

| Book | Pages | Photos placed | Per page | Paper |
|---|---|---|---|---|
| Vietnam Cambodia Thailand Shenzhen 2018 | 132 | 395 | 3.0 | Premium lustre |
| South Africa, UK 2019 | 160 | 698 | 4.4 | Premium lustre |
| COVID 19, Canada 2020 | 86 | 617 | 7.2 | Premium lustre |
| Birds and Bees, Canada 2021 | 79 | 469 | 5.9 | Standard |
| 2022 | 111 | 770 | 6.9 | Premium matte |
| 2023 | 87 | 383 | 4.4 | Premium matte |
| Eclipse 2024 | 120 | 749 | 6.2 | not recorded |

`2017-2016.blurb`, `Birds 2021.blurb`, `tes.blurb` and `testing.blurb` are empty or abandoned and were ignored.

### 2.3 Templates in use

Across the seven books there are 775 pages and 381 distinct page geometries (rounded to 20 pt). That overstates the variety: left and right pages are the same layout shifted about 20 pt away from the binding, and many pages are one-off tweaks. The 14 most common geometries cover 313 pages (40%).

The families that matter, with page counts across all books:

| Family | Pages | Books | Slots |
|---|---|---|---|
| 2 large + 3 small, caption strip | 61+ | 2021 to 2023 | Two 520×380 landscape, three 260×380 portrait |
| 3×2 portrait, caption strip | 51+ | 2021 to 2023 | Six 260×380 portrait |
| 2×3 landscape | 59+ | 2021 to 2023 | Six 380×260 landscape |
| 7-up mixed | 40+ | 2019, 2020 | Four landscape, three near-square in the middle row |
| 2×3 landscape, older margins | 17+ | 2019, 2020 | Six 340 to 380×260 |
| Title + text + one photo | 28 | 2019 | Heading, paragraph, one 700×500 photo |
| Full-bleed single page | 22 | Five books | One 860×860 |
| Full-bleed spread | 7 | Six books | One 1720×860 across two pages |
| 5×5 grid of squares | 12 | 2022 | Twenty-five 140×140 |
| 2×2 | many | All | Four per page, appears in several margin variants |

Photos per page, by book, peaks at 4 and 6 in 2021 to 2023, and at 7 in 2020 and Eclipse 2024. Single-photo pages were 28% of the 2018 and 24% of the 2019 book but have been 13% or less since 2020.

Other fixtures:

- **Year in Review:** the first pages of 2023 hold a dated list ("January 5th - Vancouver Electronics Meet-up", ...) in two 360 pt columns under a heading.
- **Cover:** seven photos on the front in 2020, 2022, 2023 and Eclipse; nine in 2018 and 2019. Cover sheet is about 1801 × 918 pt.
- **Background:** mostly white pages with about 20 black pages per book, except Eclipse 2024, which is black throughout.
- **Borders:** 1 pt white rectangle on every container.

### 2.4 How photos are matched to slots

For each placed photo, its orientation against the orientation of the slot it sits in (L landscape, P portrait, S square, 10% tolerance):

| Book | Same orientation | Into a square slot | Opposite orientation |
|---|---|---|---|
| 2023 | 89% | 3% | 8% |
| 2022 | 88% (incl. square to square) | 5% | 7% |
| Eclipse 2024 | 33% | 66% | 1% |
| 2020 | 49% | 40% | 10% |
| 2021 | 55% | 33% | 12% |
| 2019 | 57% | 31% | 12% |
| 2018 | 65% | 27% | 8% |

So the rule Steven follows is: landscape photo into a landscape slot, portrait into portrait, and either into a square. Opposite-orientation placements are rare and are the first thing an auto-layout should avoid.

### 2.5 Cropping

How much of each photo is visible in its slot:

| Book | 10th percentile | Median | 90th percentile |
|---|---|---|---|
| 2023 | 51% | 90% | 97% |
| 2022 | 51% | 90% | 100% |
| Eclipse 2024 | 31% | 72% | 75% |
| 2020 | 48% | 79% | 99% |
| 2021 | 20% | 73% | 97% |
| 2019 | 28% | 70% | 97% |
| 2018 | 45% | 74% | 95% |

A typical photo loses 10 to 30% to fit its slot, and one in ten loses half or more. Cropping is already happening inside BookWright on top of whatever was cropped beforehand, so a good per-slot crop control in the new tool can replace the separate pre-crop step.

Resolution is not a constraint: the median placed photo prints at over 600 dpi, and the 5th percentile is above 380 dpi in every book since 2020 (210 in 2018, 286 in 2019). Exports can be downsampled to 300 dpi to keep the PDF small.

### 2.6 Ordering

Counting consecutive pages whose earliest photo is not older than the previous page's: 62 of 84 in 2023, 78 of 108 in 2022, 74 of 116 in Eclipse. The books run roughly chronologically but about a quarter to a third of page turns go backwards, which means photos are grouped by event or theme first and by date second.

### 2.7 Captions

| Book | Caption strips | Filled |
|---|---|---|
| 2019 | 55 | 55 |
| 2021 | 123 | 94 |
| 2022 | 64 | 1 |
| 2023 | 48 | 3 |

The 2022 and 2023 templates have a caption strip (780×20 pt at the foot of the page) on most pages, but they were left empty. The slot is there; the effort of filling it was the problem.

### 2.8 Where the photos came from

The registry records each photo's original path: `C:/Users/funvill/Pictures/2023 google photos favorites`, `.../2022 google photos favorites`, and plain `Downloads` folders in earlier years. File names such as `PXL_20231204_044129335.jpg` are Pixel originals, and the registry holds date taken and camera model, so the downloaded files keep their EXIF.

### 2.9 Cover and opening pages

The 2022, 2023 and Eclipse 2024 covers are the same design, on a black wrap of about 1801 to 1814 × 918 pt:

| Part | Content |
|---|---|
| Back | One large photo, 817 × 617 pt, centred. This is the sunset. |
| Spine | The year's places in one line ("Canada, Washington DC, New York, Hawaii") and the year, in Arial. |
| Front | Six photos in two rows, each row narrow, wide, narrow (168, 380, 168 pt wide by about 330 high), with the year in large type in the gap between the rows. |

The cover width matches Blurb's calculator for ImageWrap at these page counts (25.014 in is 1801 pt at 100 pages).

Opening pages:

- **Page 1, and sometimes 2: Year in Review.** A heading and two columns of dated one-line entries, for example "January 1 - Palm Springs with Chris and Marjorie", "July 19 - Beaver at Burnaby lake". These already name dates, places and people, which is the same information the captions need.
- **2023 only:** page 3 is a titled essay ("#100 Ideas Project").
- **Closing pages:** a full spread or single full-page photo. 2022 ends with a 5×5 grid followed by a single photo.

## 3. AlbumCraft

<https://github.com/kbarni/AlbumCraft> is a photo organizer, viewer and editor in the Picasa mould. It is not a photo-book tool.

- Rust desktop app, Apache-2.0 or MIT, one author, very active (v0.9.0 on 2026-11-21).
- Layout is nine collage styles plus contact sheets, arranged by dragging. No multi-page book, no auto-flow.
- Output is JPEG, PNG or PDF with no bleed, trim box or colour management. Its own notes say printing was never tested with a real print job, and "export for print" is only proposed.
- Storage is one `library.json`; there is no per-project file.

Verdict: not a base to build on. Worth a look later for its collage styles (mosaic, pile) as ideas for special pages.

## 4. Blurb PDF to Book, Large Square 12×12

Figures from Blurb's live size calculator (<https://www.blurb.com/make/pdf_to_book/booksize_calculator>).

### Interior pages

| Item | Inches | Points |
|---|---|---|
| PDF page (w × h) | 11.875 × 12.0 | 855 × 864 |
| Trim | 11.75 × 11.75 | 846 × 846 |
| Bleed: top, bottom and outside edge only | 0.125 | 9 |
| Safe inset: top, bottom, outside | 0.25 | 18 |
| Safe inset: binding edge | 0.5 | 36 |

- The PDF page is the same 855 × 864 canvas BookWright uses, so extracted templates need no conversion.
- There is no bleed on the binding edge, so left and right pages are offset differently.
- The calculator's footnote gives the binding safe inset as 45 pt, contradicting its own table. Use the larger figure.
- Pages are single pages, not spreads. The book starts and ends on a single page and the count must be even. Minimum 20 pages.

### Cover

One single-page PDF: back, spine, front.

| Cover, paper, pages | PDF size (in) | Spine (in) |
|---|---|---|
| ImageWrap, Standard, 20 pp | 24.903 × 12.75 | 0.458 |
| ImageWrap, Standard or Premium, 100 pp | 25.014 × 12.75 | 0.569 |
| ImageWrap, Standard, 240 pp | 25.361 × 12.75 | 0.917 |
| ImageWrap, ProPhoto Pearl, 100 pp | 25.194 × 12.75 | 0.75 |
| Dust jacket, Standard, 100 pp | 33.014 × 12.25 | 0.569 |

ImageWrap bleed is 0.306 in (it wraps round the board); safe inset is 0.25 in from trim. Cover width depends on page count and paper through the spine, so the cover has to be generated last, from the final page count.

### Other rules

- No spot or registration colours, 100% K for black text, no trim marks.
- Blurb offers an ICC profile at <https://www.blurb.com/color-management>.

Not confirmed on a live Blurb page: PDF/X-3 as a hard requirement, the 2 GB upload limit, the maximum page count for Premium paper (shown as both 80 and 240).

Reported second-hand from Blurb's help-centre checklist (the page blocked direct reading): CMYK recommended, sRGB accepted, no PDF/X requirement stated, no printer marks, interior up to 2 GB, cover up to 90 MB. The PDF/X-3 mandate appears only in Blurb's 2010 guides.

One wording to confirm before the first real order: Blurb's page describes the book as a single right-hand page, then two-page spreads, then a single left-hand page. BookWright stores single pages and the calculator gives a single-page size, so single PDF pages is the working assumption. Phase 0 of the plan tests it.

## 5. Google Photos

### 5.1 The API

Verified on Google's developer pages:

- On 31 March 2025 Google removed the scopes that let an app read a user's library. An app can now only list photos and albums it created itself. There is no way to list the library or the Favorites.
- The replacement is the **Picker API**: the tool opens a Google page, Steven selects photos there (up to 2000 per session), and the tool receives them.
- Per photo the Picker gives file name, date, pixel size and camera details. It gives **no location, no people, no description and no favourite flag**.
- Downloads through the Picker have their GPS coordinates stripped.

So a direct link can fetch the pictures but none of the information the captions need. There is no supported way to ask for "all favourites from 2025".

### 5.2 Google Takeout

Google's own help only says that metadata not in the original file is exported as a separate JSON file. The details below come from community tools and user reports, not from Google:

- Each photo gets a sidecar, currently named like `IMG_1234.jpg.supplemental-metadata.json`, with truncated variants on long file names.
- Fields include `photoTakenTime`, `geoData`, `geoDataExif`, `description`, `people` (a list of `{name}` from face tags), `url`, and `favorited: true` on favourites only.
- Takeout can be limited to chosen albums, including the automatic "Photos from 2025" album. Favorites does not appear to be exportable as an album on its own.

If that holds, one Takeout of "Photos from YYYY" a year gives people names, coordinates and the favourite flag for every photo, and the tool can pick the favourites out of it itself. This needs proving with a real export before anything is built on it.

### 5.3 GPS in the files Steven already downloads

Checked directly: the first 150 original photos stored inside each of three books.

| Book | With GPS coordinates | GPS block present but empty | No GPS block |
|---|---|---|---|
| 2023 | 61 | 86 | 3 |
| 2022 | 60 | 86 | 4 |
| Eclipse 2024 | 31 | 117 | 2 |

**Superseded:** a proper decode in section 8.2 found coordinates on only 8 of 403 photos from 2023, about 2%. The table above over-counts.

On this first check, 20 to 40% of the downloaded favourites appeared to carry coordinates. The check was a simple one (it counts entries in the GPS block rather than decoding them), so treat the split as approximate, but the conclusion stands: place names cannot come from the downloaded files alone. Whether the coordinates were never recorded or were removed on download is not known; a Takeout sidecar would show which.

## 6. Making the PDF

| Tool | Keeps JPEGs without re-encoding | Print features |
|---|---|---|
| pdf-lib (JavaScript) | Yes, confirmed in its source | Exact page sizes; no built-in output intent |
| img2pdf (Python) | Yes, documented | Whole-page images only, no layout |
| ReportLab (Python) | Yes when given a file path (unverified) | Full layout and text; no PDF/X in its guide |
| WeasyPrint (Python, HTML to PDF) | Unverified; has options that re-encode | Claims PDF/X-4 |
| Headless Chrome print-to-PDF | Unverified | No colour management or bleed boxes |
| Typst | Unverified | PDF/A only |
| pikepdf (Python) | Post-processor | Can add trim and bleed boxes to another tool's output |

Since Blurb accepts sRGB and does not appear to require PDF/X, the requirements reduce to: exact page size, photos placed at exact positions and crops, embedded fonts for captions, and predictable image quality. pdf-lib and ReportLab both do that. Because slots are cropped views of large originals, the exporter should crop and resample each photo to its slot at 300 dpi itself and embed the result, rather than embedding 12-megapixel originals behind a clipping mask.

## 7. Other printers that take a PDF

| Printer | Notes |
|---|---|
| PrestoPhoto | 12×12 upload page is 12.25 × 12.25 in |
| WhiteWall | Single pages, sRGB, separate cover PDF, interior up to 1.5 GB |
| CEWE (UK) | sRGB, 3 mm bleed, 10 mm on the cover, minimum 26 pages; 30×30 not confirmed |
| Bob Books | 3 mm bleed, 10 mm on the cover |
| Pikto (Canada) | 12×12 offered, 20 to 200 pages, sRGB |
| Lulu | Single pages, sRGB, 0.125 in bleed; 12×12 not confirmed |
| Mixam | 3 mm bleed, 20 mm on a hardcover cover; 12×12 not confirmed |
| MILK Books | No whole-book PDF; per-page JPEGs instead |
| BookBaby | Templates stop at 9×12 |

The differences are page size, bleed on each edge, cover wrap and page limits, which is what a printer profile has to hold. Per-page JPEG export is worth having as a second output format since at least one printer wants it.

## 8. Prior art

Found by search; none has been run or read in depth yet.

| Project | What it is | Licence |
|---|---|---|
| [photobook_studio](https://github.com/jkw2lo/photobook_studio) | TypeScript and React browser editor that auto-drafts a book and exports interior and cover PDFs with trim and bleed. Has Blurb and Lulu profiles. 2026. | MIT |
| [fotobuch](https://github.com/EddyXorb/fotobuch) | Rust and Typst. Optimises layouts with a genetic algorithm, has a drag-to-rearrange GUI, sets trim and bleed boxes. | AGPL-3.0 |
| [photobook-as-code](https://github.com/mytracks/photobook-as-code) | Python and ReportLab, driven by a YAML file, one section per day, place names from Nominatim. No bleed. | MIT |
| [flickr/justified-layout](https://github.com/flickr/justified-layout) | Given photo sizes, returns justified rows. | MIT |
| BRIC (HP Labs, 2008) | Published algorithm that fills a page with photos of any aspect ratio without cropping. | Paper |
| [PhotoCollage](https://github.com/adrienverge/PhotoCollage) | Random space-filling collage posters. | GPL-2.0 |

**photobook_studio is close to what the plan describes** and is MIT licensed, so it has to be evaluated before writing an editor from scratch. It could be a base to fork, a source of parts, or nothing, depending on how it is built.

### 8.1 photobook_studio, evaluated 2026-11-22

How it was evaluated: the source was cloned and read (docs, printer presets, templates, layout and generator code), and the hosted web version was opened and confirmed to load. It has **not** been installed locally or tried with Steven's photos.

**What it is.** A TypeScript app: React editor, a pure layout core, a small local Node server with SQLite, PDF export through PDFKit, checked afterwards with pdf-lib. About 9,500 lines of core and server code plus the editor, with 21 test files. Version 0.1.0, 35 commits by one author between 2026-10-23 and 2026-11-07, nothing since. It runs two ways: locally with Node, or entirely in the browser at <https://jkw2lo.github.io/photobook_studio/> with nothing uploaded.

**What it already does that the plan needs:**

| Plan item | photobook_studio |
|---|---|
| Import a folder, originals untouched | Yes. Reads date, GPS, size; builds thumbnails; flags blurry shots and near-duplicates. |
| Auto-draft a whole book to a page count | Yes. Chronological, split into chapters by day, favourites always kept. |
| Orientation-aware slot matching | Yes. Assigns photos to slots by least cropping, the same rule found in Steven's books. |
| Templates as data | Yes. Slots as fractions of the page, mirrored for left and right pages. |
| Editor | Yes, and more than planned: free-form move, resize and rotate as well as templates, swap between pages, crop with live print DPI, reorder spreads, lock spreads, undo, 50 saved versions. |
| Cover sized from page count | Yes. Back, spine, front; spine follows page count. |
| Warnings before export | Yes. Low DPI, content in the bleed or binding, missing files. |
| Interior and cover PDFs with trim and bleed | Yes, with no bleed on the binding edge for Blurb, and every export re-opened and checked. |
| Printer profiles | Lulu, Blurb and Custom. |

**Where it falls short for Steven:**

| Gap | Detail | Size of fix |
|---|---|---|
| Blurb 12×12 size is wrong | The preset uses a 12 × 12 in trim, giving a 12.125 × 12.25 in page. Blurb's calculator wants 11.875 × 12.0 in on an 11.75 in trim. The cover wrap is assumed at 0.75 in; Blurb's is 0.306 in. | Small: correct the preset from the calculator figures in section 4. The Custom printer can do it by hand today. |
| Page density | Built-in templates stop at six photos, and its densest style averages five a page. No caption-strip grids, no 7-up, no 5×5. | Small: add Steven's templates and a style weighted towards them. |
| Captions | Dates only. No place names, no people. Its own notes list reverse geocoding as not done. | Medium. This was always going to be new work. |
| Grouping | Chapters are calendar days. Steven groups by event or trip. | Medium. |
| Year in Review and his cover design | Has generic title, contents and cover layouts; not the dated event list or the six-photo cover. | Small to medium, as templates. |
| Reading `.blurb` files | None. | Small, and only needed once to harvest templates. |
| Built on a Mac | HEIC import, the shareable flipbook and poster image export call macOS tools. The launcher is a Mac app. Core import, editing and PDF export use cross-platform libraries, but nothing says it has been run on Windows. | Unknown until tried. Pixel photos are JPEG, so HEIC does not matter. |
| Storage | Book lives in a SQLite database or the browser's storage, with a single-file backup. Not the plain readable project file the plan wanted. | Accept, or add a JSON export. |
| Scale | Its speed tests used 500 small synthetic images. Real 12-megapixel photos and an 800-photo, 100-page book are untested by its author. | Unknown until tried. |

**Risks of adopting it.** It is two weeks of work by one person and has been quiet since. Forking means owning roughly 15,000 to 20,000 lines of someone else's code, a good deal of it for features Steven does not need (posters, stickers, map cut-outs, calendars, flipbooks). There is no upstream to rely on.

**Verdict.** Fork it instead of starting from nothing. The parts it already has (editor, crop, undo, cover geometry, verified PDF export, preflight) are the expensive and unglamorous parts, they are tested, and its design matches what the plan chose independently: TypeScript, templates as data, one layout function shared by screen and PDF. What it lacks is the part that is specific to Steven. The verdict is conditional on a hands-on trial with real photos on Windows, because scale and platform are the two things reading the code cannot settle.

### 8.2 photobook_studio, trial on Windows with the 2023 photos

Run 2026-11-22 on Steven's PC (Windows 11, Node 24), from a clone in a temporary folder. The 403 original photos stored inside `2023.blurb` (1.15 GB) were extracted and used as the input. The trial drove the app's own server and layout code from a script; the editor screen itself was not exercised.

| Step | Result |
|---|---|
| Install | Clean. 212 packages in 45 seconds; no native build problems. |
| Type check | Passes. |
| Unit tests | 377 of 378 pass. The one failure is a temporary-folder clean-up that Windows refuses while a file is still open, not a fault in the feature under test. |
| End-to-end test | Fails on Windows, for one reason: its sample set includes a HEIC photo that can only be generated on a Mac, so the expected count of 21 photos is 20 and the later steps cascade. |
| Import 403 real photos | 198 seconds, no errors, about 210 MB of memory. 395 had a date. |
| Auto-draft, 86 pages | Under a quarter of a second. |
| Export | Interior PDF in about 3 minutes, 306 MB, 86 pages, passes its own check. |

Two draft styles were tried at 86 pages, against the real 2023 book (87 pages, 383 photos placed, 4.4 a page):

| | "Collage" style | "Documentary" style | Steven's 2023 book |
|---|---|---|---|
| Photos placed | 403 of 403 | 268 of 403 | 383 |
| Typical page | 4, 5 or 6 photos | 2, 3 or 4 photos | 4 or 6 photos |
| Photo in a slot of the opposite orientation | 11% | 17% | 8% |
| Photo in a square slot | 23% | 46% | 3% |

The "Collage" style already lands at Steven's density and placed every photo. It uses more square slots and slightly more wrong-orientation placements than he does, which is what adding his templates should fix.

Print geometry:

- **Interior:** with the trim set to 11.75 in, the exported page is exactly 855 × 864 pt with an 846 pt trim, matching Blurb's calculator. With the built-in Blurb Large Square preset it would not be, as noted above.
- **Cover:** exported at 25.254 × 13.25 in. Blurb wants 25.014 × 12.75 in for ImageWrap at about 100 pages. The app's wrap and spine are placeholders and its own preflight says so; the real figures have to be entered or built in.

Not checked: what the pages look like. The PDFs passed dimension checks but nobody has looked at them yet. They are saved in `trial-output/` for Steven to open.

**GPS, corrected.** The app's importer, which decodes coordinates properly, found GPS on only **8 of the 403** photos. The simpler check in section 5.3 counted GPS blocks that hold a timestamp but no position, so its 20 to 40% is too high. Around 2% is the better figure for 2023: the downloaded favourites effectively have no location.

### 8.3 Other approaches

The free-form algorithms (BRIC, justified rows) solve a different problem from Steven's: his pages are fixed grids with photos cropped to fit, not variable grids with photos uncropped. They are an option for an occasional "mosaic" page, not the core.

### Place names from coordinates

- **GeoNames** city lists (CC BY 4.0) work offline: nearest town to a coordinate, with province and country. Free and private, but only town-level ("Tofino, British Columbia"), not "Chesterman Beach".
- **Nominatim** (OpenStreetMap) gives finer names. Its public server allows one request a second with caching, which is fine for 800 photos once a year, but it sends the coordinates of Steven's photos to an outside service.
