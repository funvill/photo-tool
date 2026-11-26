feat(media): read AVIF, TIFF, GIF, SVG, BMP and ICO (#6 phase 2)

Part of #6

## What this adds

Phase 2 of the media format plug-ins. Six formats join the registry (`shared/core/mediaFormats.ts`) and get a handler each (`shared/server/mediaHandlers/`). Both programs read them through the server: Photo Tool's scan, grid, viewer, zoom and clipboard picture, and the Photobook Editor's Shelf, import, thumbnails and exports.

- **AVIF, TIFF, GIF** are read by sharp straight from the original (`sharpHandler`). The page never gets an original in either program: thumbnails, `/full` and `/image` are all re-encoded by the server, so these need no converted copy. A multi-page TIFF shows its first page and an animated GIF its first frame. exifr misreads the EXIF libheif writes into AVIF, so the AVIF handler offers it through sharp (a new optional `exifBlock()` on `MediaHandler`; `readMetadata` falls back to it only when exifr finds nothing).
- **SVG** is treated as untrusted input (`svg.ts`). It is rasterised from its bytes, never from its path, into `<dataDir>/derived/<sha256>.png`. Everything else reads that PNG, and the page never gets the SVG. The raster's long side is the drawing's own size, kept between 2048 and 4096 px. The input is capped at 20 MB, and a drawing that would be bigger than the cap even at sharp's lowest density is refused. librsvg runs no scripts and fetches nothing from the network. Read by path, it would still draw an `<image href="photo.jpg">` that sits beside the SVG (checked: a red sibling showed up). From bytes it draws no outside file. A gzipped SVG is refused before sharp sees it (libvips would inflate it, so a small file could expand without limit), and so is an `.svg` that does not start with markup. Every format sharp reads from the original goes to sharp only if the file starts with a raster format's magic bytes (JPEG `FF D8`, PNG, GIF87a/89a, `RIFF….WEBP`, TIFF/BigTIFF, or an `ftyp` box with a HEIF/AVIF brand), none of which can start an XML document. So an SVG named `.jpg` never reaches sharp, however much padding or commentary comes before its `<svg`. A real picture under another raster format's name (a PNG called `.jpg`) is still read as what it is. As a second guard, sharp's SVG file and source loaders are blocked for the whole process (`sharp.block`), so no code path can load an SVG by its path. Each server checks at start-up that an SVG path is refused and logs a warning if not, but still starts: the sniff protects it either way.
- **BMP and ICO**: sharp has no loader for either, so `bitmap.ts` is a small decoder written here, with no new dependency. It writes a PNG into the derived cache. It reads BMP's 12, 40, 52, 56, 108 and 124-byte headers; 1, 2, 4 and 8 bits per pixel with a palette; 16, 24 and 32 bits per pixel, plain or with bit masks (and their alpha); and RLE4 and RLE8. For an ICO it takes the biggest picture: a PNG one goes straight to sharp, and a BMP one is decoded with its 1-bit mask. Every offset is checked against the file, and the file size (256 MB) and picture size (50 MP) are capped. The picture is only allocated once the file holds enough data to fill it (for RLE, at most 1024 pixels per byte), so a 60-byte file can't ask for 49 MP. Embedded JPEG/PNG in a BMP and the OS/2 2.x header are refused.
- **Capabilities**: all six are `editInPlace: false`. Save writes `saveAs` into the photo's own path, and `SaveFormat` is jpeg/png/webp, so a `.tif` would otherwise end up holding JPEG bytes. AVIF and TIFF are saved as JPEG copies; GIF, SVG, BMP and ICO as PNG copies. GIF carries `animated: true`.
- **Format ids in the catalogues**: Photo Tool's scanner now stores the registry's id for every photo (sharp reports AVIF as `heif`, which would have made it a HEIC). The editor's importer stores the registry's id instead of the bare extension (it stored `tif`, which `formatById` can't find). Existing rows keep their values. For the editor that means a HEIC imported before this change still says `heic` where a new import says `heif`: `formatById('heic')` finds nothing, so the transparency backfill skips it (right for HEIC anyway), and a re-import updates the row.
- **Editor**: the transparency backfill now reads through `workingFile()` (it handed `original_path` to sharp, which for an SVG would mean reading it by path). `exportAssets` re-decodes a missing derived copy through the handler instead of handing the original to sharp.
- **Zoomed view on white**: `/api/gallery/full` now flattens onto white, as the thumbnails do. JPEG used to turn see-through parts black, so an SVG, icon or cutout PNG switched background when zoomed.
- **Edits saved as JPEG on white**: `renderEdited` flattens onto white before JPEG output, so a see-through picture saved, exported or copied as a JPEG edit (Photo Tool's Save, the editor's edited copy) no longer gets a black background.
- **Desktop self-test**: `GET /api/gallery/media-check` decodes a tiny AVIF, TIFF, GIF, SVG and BMP made on the spot through the handlers and checks the SVG guard. Photo Tool's packaged self-test runs it as a new `mediaFormats` step, which also requires that `sharp.block` holds, so a sharp build without it shows up in CI.
- **Fixtures**: `npm run fixtures` also writes `fixtures/generated/formats/`. It holds an AVIF with an EXIF date, a two-page TIFF (page two is magenta and must never be shown), a two-frame GIF (red, then blue), an SVG, a 24-bit BMP, and an ICO with a 256 px PNG picture and a 32 px BMP one. All are generated with sharp, or byte by byte where sharp can't write the format. They sit in their own folder because existing tests count the `trip` photos.

`HandlerContext` is unchanged. `MediaHandler` gains only the optional `exifBlock`. The derived copies use the same cache and naming scheme (`<sha256>.<ext>`, tmp + rename) as HEIC.

## Tests

- `shared/tests/media-formats.test.ts` (rewritten from phase 1's "nothing new yet"): every new extension in every case, MIME, kind, the capabilities, `editFormatFor`, `acceptAttribute()`, and one handler per format.
- `shared/tests/media-handlers.test.ts`: for each fixture, the working image (from the original with no hashing, or a derived PNG), its size, both thumbnails, the full-size JPEG and the in-memory `image()`. It checks the GIF shows its first frame, the TIFF is not its magenta second page, the icon is its biggest picture, and the AVIF's EXIF date is read. SVG safety: sibling, absolute `file:///` and `http://` `<image>` references are never drawn (through `workingFile` and `image()`). Neither are `<use>`, XInclude, external entities, `@import` or `<?xml-stylesheet?>`, whether beside the file or on a local web server, which must see zero requests. Also covered: a huge drawing is capped, a tiny one is scaled up, an absurd one is refused, and an SVG can't be loaded by path even when named `.jpg`.
- `shared/tests/media-bitmap.test.ts`: the BMP/ICO decoder on files built byte by byte. It covers each bit depth, top-down rows, RLE8, RLE4 and deltas, 5-6-5 masks, V4 RGBA masks, unused vs real alpha, the OS/2 header, icon masks vs 32-bit alpha, and a set of files that lie about themselves.
- `photo-tool/tests/gallery-formats.test.ts`: the scan picks up all six with no errors, under their own format ids. Each one's `s` and `m` thumbnails, `/full` and `/image` come back, and the GIF's `/full` is its red first frame. A see-through SVG zooms on white.
- `photobook-editor/tests/formats.test.ts`: the Shelf counts and previews all six, import catalogues them under their ids with thumbnails, and an SVG that tries to draw a sibling file shows only its own blue on the Shelf and once imported.
- e2e (`photo-tool/tests/e2e/gallery.spec.ts`, new `#6 phase 2` block): all six tiles show with loaded thumbnails, the TIFF opens in the viewer at its 1200 px size, and the AVIF's full-size picture is served.
- Gzip bomb (200 MB inner SVG, made in the test): refused by the first-bytes check, before sharp or zlib sees it. SVGs disguised as `.jpg/.png/.webp/.tif/.gif/.avif` are refused even with `sharp.block` lifted: with a BOM, UTF-16 or gzip, behind 600 spaces (which libvips still reads as SVG), behind a long XML comment, or behind tab/CR/LF padding. The start-up check warns when the block is lifted.
- Magic bytes: odd but valid files still read (PNG named `.jpg`, AVIF named `.jpg`, a JPEG with trailing bytes). Files with no picture magic are refused. `rasterFormat` has yes and no cases, among them MP4's `ftyp`, `RIFF…WAVE` and BMP.
- `photo-edit-render.test.ts` and the editor format test: a see-through PNG or SVG saved as a JPEG edit has a white corner.
- `media-bitmap.test.ts` also covers hostile files: the tiny RLE and short uncompressed files with a `Buffer.alloc` spy, odd and truncated RLE4 runs, deltas past the end, odd masks, negative width, `INT32_MIN` height, icons over the cap, and a seeded 20 000-case fuzz.
- `media-self-check.test.ts` and `gallery-formats.test.ts` check the media check and its route.
- `npm run typecheck` clean; `npm test` 1119 + 299 passed (3 + 1 skipped, as before); Playwright for both projects 52 passed, 1 skipped (as before).
- Packaged Photo Tool self-test on Windows (`npm run dist:dir:photo-tool`, temp data/profile/photoinfo folders): all 8 steps ok, `mediaFormats` included (svgGuard all true). Not run on Linux.

## Checked by hand

- What librsvg does with outside references, read by path vs from bytes: by path, a relative `<image href>` beside the SVG was drawn; from bytes, nothing was (relative, `file:///`, `http://`, `../`).
- `sharp.block` refuses an SVG by path and one renamed `.jpg`, while SVG from a buffer still works.
- What sharp reports for each fixture (AVIF reports `heif`/`av1`; the TIFF and GIF have 2 pages).

## Decisions I made

- **No converted copy for TIFF, AVIF or GIF.** The brief asked for a converted working image "for formats Chromium can't show directly". In both programs the page never gets an original: thumbnails, the viewer's `m` picture, the zoomed `/full`, the clipboard PNG, the Shelf previews and the editor's thumbnails are all made by the server with sharp. So sharp reading these from the original already gives Chromium a JPEG, with no full-size copy per TIFF on disk. Only SVG (for safety), BMP and ICO (sharp can't read them) get a derived PNG, the same way HEIC gets its JPEG.
- **Animated GIF is a still everywhere**, the viewer included. It is shown, edited and saved (as a PNG copy) as its first frame, and the file itself is never changed. That keeps the viewer consistent with edits and Save. Playing it would need the original in the page, which nothing does today.
- **SVG raster size**: the long side is the drawing's own size kept between 2048 and 4096 px, since vector art has no natural pixel size and 2048 is above the 1600 px `m` thumbnail.
- **BMP and ICO through our own decoder** rather than a dependency: it is about 250 lines with every read bounds-checked, and the rules say install nothing.
- **ICO shows its biggest picture**. CUR files (type 2) are read the same way but are not in the registry.
- **`.svgz` is not included.** sharp reads it, but gzip adds a decompression-bomb case that the 20 MB input cap doesn't cover.

## Not done

- The packaged-app check on Linux: the `mediaFormats` self-test step passed on Windows here, but Linux needs the desktop CI. The Linux `wasm` sharp mode in particular is unverified for AVIF, SVG and `sharp.block`; the step fails loudly if any is missing.
- Run `npm run fixtures` again after merging. Without the new folder, the format vitest suites skip silently.
- Animated GIF playback in the viewer (see above).
- Phase 3 onwards (RAW, video, per-format scheduling).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
