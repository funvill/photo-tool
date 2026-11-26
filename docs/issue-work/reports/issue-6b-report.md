# #6 phase 2 (6b): media formats sharp decodes, plus BMP/ICO

- **Status:** done, local only (nothing pushed, no PR opened)
- **Worktree:** C:\Users\funvill\Documents\git\photobook_helper-media2
- **Branch:** `media-formats-2`, rebased onto `issues-integration` at 9e28f24 (album-tags-sidecar). The only conflict was in gallery.spec.ts: the sidecar describe block and the #6 block both sat at the end of the file, and both are kept.
- **Commits:**
  - 791c73f feat(media): read AVIF, TIFF, GIF, SVG, BMP and ICO (#6 phase 2)
  - 1711c82 fix(photo-tool): zoom see-through pictures on white; more SVG checks
- **Version:** 0.1.43, one bump over the integration branch (0.1.42). The separate version-bump commit was dropped by the rebase as already upstream.
- **PR text:** C:/Users/funvill/AppData/Local/Temp/claude/c9348345901b9bca/ca988cda-866d-4051-8232-ecfcea4fd6b7/scratchpad/issue-6b-pr.md ("Part of #6")

## What was built

| Format | Extensions | Handler | Working image | Capabilities |
|---|---|---|---|---|
| AVIF | .avif | `sharpHandler('avif', { exifFromSharp })` | the original | copy-only, saved as JPEG, alpha |
| TIFF | .tif .tiff | `sharpHandler('tiff')` | the original (first page) | copy-only, saved as JPEG, alpha |
| GIF | .gif | `sharpHandler('gif')` | the original (first frame) | copy-only, saved as PNG, alpha, animated |
| SVG | .svg | `svg.ts` | derived `<sha>.png`, rasterised from the file's bytes | copy-only, saved as PNG, alpha |
| BMP | .bmp | `bitmap.ts` (our own decoder) | derived `<sha>.png` | copy-only, saved as PNG, alpha |
| ICO | .ico | `bitmap.ts` (biggest picture) | derived `<sha>.png` | copy-only, saved as PNG, alpha |

New files:
- `shared/server/mediaHandlers/svg.ts`
- `shared/server/mediaHandlers/bitmap.ts`
- `shared/server/mediaHandlers/derived.ts` (shared tmp + rename writer for the derived PNGs)

Changed:
- `mediaFormats.ts`: the six entries, and the `id` doc no longer claims it equals sharp's format name.
- `mediaHandlers/index.ts`: the handlers, plus an optional `exifBlock?()` on `MediaHandler`. `HandlerContext` is unchanged.
- `sharp.ts`: the `exifFromSharp` option.
- `media.ts` `readMetadata`: falls back to the handler's EXIF block when exifr finds nothing. Only AVIF has one.
- `photo-tool/server/scanner.ts`: stores `formatOf(path).id`. sharp reports AVIF as `heif`, which would have catalogued it as HEIC.
- `photobook-editor/server/importer.ts`: stores the registry id. It used the bare extension, so a .tif was stored as `tif`.
- `photobook-editor/server/app.ts`: the transparency backfill reads through `workingFile()`, and `exportAssets` re-decodes a missing derived copy through the handler. Both used to hand `original_path` to sharp.
- `photo-tool/server/app.ts` `/api/gallery/full`: now flattens onto white, matching the thumbnails. JPEG used to turn see-through parts black, so an SVG, icon or cutout PNG switched background as soon as it was zoomed. Cutout PNGs change too: they now zoom on white.
- READMEs: Photo Tool's Save paragraph and the editor's fixtures paragraph name the new formats.
- `scripts/make-fixtures.ts`: also writes `fixtures/generated/formats/` (6 files). It is a separate folder because tests count the `trip` photos.

## SVG safety (verified)

- A probe showed that sharp/librsvg, given an SVG **path**, draws a sibling `<image href="red.png">`. Given **bytes**, it draws no relative, `file:///`, `http://` or `../` reference. So SVGs are only ever rasterised from bytes.
- `sharp.block({ operation: ['VipsForeignLoadSvgFile', 'VipsForeignLoadSvgSource'] })` runs process-wide when the handlers load. No code path can load an SVG by path, including an SVG renamed `.jpg`. Buffer SVG (used by fixtures and editor rendering) still works, and the full vitest suite passes with it.
- Other outside references were checked too, both beside the file and on a local web server on port 5897. The server must see zero requests, and it saw none.
  - `<use href>`, XInclude, `@import` and `<?xml-stylesheet?>`: all drawn without the reference (still blue).
  - An external `SYSTEM` entity: libxml refuses the whole file, so it is reported as unreadable.
- Limits:
  - input capped at 20 MB;
  - raster long side kept between 2048 and 4096 px;
  - `limitInputPixels` on the render, so an absurd declared size is refused;
  - librsvg's own XML limits stay on (`unlimited` not set).

## Tests

- **Registry:** `shared/tests/media-formats.test.ts`, rewritten from phase 1's "nothing new". It covers every new extension and case, MIME, capabilities, `editFormatFor`, `acceptAttribute`, and one handler per format.
- **Handlers:** `shared/tests/media-handlers.test.ts` (24 tests).
  - For each fixture: the working image, `s` and `m` thumbnails, the full JPEG and `image()`.
  - First frame, first page and biggest icon picture are the ones shown.
  - The AVIF's EXIF date is read.
  - The SVG safety cases above.
- **Decoder:** `shared/tests/media-bitmap.test.ts` (11 tests): BMP/ICO on byte-built files, including malformed ones.
- **Photo Tool server:** `photo-tool/tests/gallery-formats.test.ts`. The scan picks up all six with the right format ids, and thumb, `/full` and `/image` work for each.
- **Editor:** `photobook-editor/tests/formats.test.ts`. The Shelf counts and previews all six, import works with the right ids and thumbnails, and a sneaky SVG stays blue on the Shelf and after import.
- **e2e:** `photo-tool/tests/e2e/gallery.spec.ts`, new `#6 phase 2` describe block. All six tiles load, the TIFF opens in the viewer at 1200 px, and the AVIF's `/full` returns 200.
- **Results:**
  - `npm run typecheck`: clean.
  - `npm test` (fast + slow sets) on the final HEAD: 1011 + 299 passed; the 3 + 1 skipped were already skipped before this work.
  - Playwright on the final HEAD, both projects, ports 5885/5886 (sidecar test 5887): 52 passed, 1 skipped (already skipped before this work).
  - Flaky test, not caused by this work: `#2 Regenerate…` sometimes fails in cleanup with Windows EPERM on its temp folder. It failed 2 of 3 times on a clean checkout of issues-integration too, and passed in the final full run.

## Decisions made

- **No converted copy for TIFF, AVIF or GIF.** The page never gets an original in either program: everything it shows is a server-made JPEG or WebP. So sharp reading the original is enough and costs no extra disk. SVG, BMP and ICO get a derived PNG, the same way HEIC gets its JPEG.
- **Animated GIF is a still everywhere, the viewer included.** It is edited and saved (as a PNG copy) as its first frame, so the viewer stays consistent with edits and Save.
- **All six are copy-only.** `SaveFormat` is jpeg/png/webp, and Save writes into the same path.
- **BMP and ICO use a hand-written, bounds-checked decoder** rather than a dependency (about 250 lines). It covers RLE, bit masks, palettes and ICO masks, and refuses embedded JPEG/PNG BMPs and the OS/2 2.x header.
- **`.svgz` is left out** (decompression-bomb risk not covered by the input cap).

## Concerns / not done

- The issue asks to check the formats against the prebuilt sharp in the packaged app on Windows and Linux. That was not done: it needs the desktop CI, and no `selfTest.ts` step was added. The Linux `shim` (default) and `native` modes in `scripts/desktop/build.mjs` carry sharp's prebuilt libvips, the same build tested here. The `wasm` mode (`@img/sharp-wasm32`) is a different build: whether it has AVIF and SVG, and supports `sharp.block`, is unverified. (Fix round 1 added the `mediaFormats` self-test step and ran it on Windows; Linux is still unverified.)
- Whoever merges must run `npm run fixtures` again. Without `fixtures/generated/formats`, the format vitest suites skip silently (`describe.runIf`) and only the e2e fails.
- TDD order was only partly followed. The registry tests and the Photo Tool and editor format tests were written first and seen to fail (`heif` and `tif` as stored formats, the black `/full` corner). The handler and decoder tests (`media-handlers`, `media-bitmap`) were written after the code.
- `sharp.block` is process-wide. Any future code that wants to load an SVG from a file path must read it into a buffer instead. This is documented in `svg.ts`.
- Editor rows imported before this change keep their stored format. (Corrected in fix round 1, M-5: not quite "the same ids". The editor stored the bare extension, so an old HEIC row says `heic` where a new one says `heif`. See below.)

## Fix round 1

Final HEAD **01d426f** on `media-formats-2`, rebased onto `issues-integration` 0b18c30 (v0.1.43), version 0.1.44 (bumped once, in the last commit). Commits: 89ee071, 6463764 (phase 2 as before) and 01d426f (this round). Nothing pushed.

### I-1: gzipped SVG

- `shared/server/mediaHandlers/sniff.ts` (new) reads the first 512 bytes. `rasteriseSvg` refuses gzip (`1f 8b`) with "This SVG is compressed (gzip), which is not supported." before sharp sees any byte, and refuses an `.svg` that does not start with markup (after an optional BOM and whitespace). The render also gets `.timeout({ seconds: 20 })`.
- Test first (failed before: libxml really parsed the inflated stream and reported "Comment too big"): `media-handlers.test.ts` makes a gzip bomb in the test (200 MB of inner SVG), and it must be refused within 2 s with RSS growth under 100 MB, with a "compressed" error. Plus a non-markup `.svg` refused and BOM + whitespace accepted.

### I-2: JPEG on white

- `shared/server/photoEditRender.ts`: `out.flatten({ background: '#ffffff' }).jpeg(...)`. Every JPEG an edit produces goes through `renderEdited`: Photo Tool's Save and Save-as-copy, the editor's photoinfo-edit derived copy (`-edit-*.jpg`), and so export of an edited photo. The editor's page export (`imageExport.ts`) already flattened on white.
- Tests first (both showed black corners before): `photo-edit-render.test.ts` "see-through pictures": a transparent PNG rendered as JPEG has a white corner and red centre for identity, rotate 90 and straighten; PNG and WebP keep alpha 0. `photobook-editor/tests/formats.test.ts`: an SVG and a cutout PNG with a photoinfo edit (rotate 90), imported, give a `-edit-*.jpg` with a white corner.

### I-3: SVG guard checked, and in the desktop self-test

- Content sniff, independent of `sharp.block`: every sharp-read handler (JPEG, PNG, WebP, HEIC, AVIF, TIFF, GIF) refuses a file whose head is markup, gzip or a UTF-16 BOM ("This file holds text, not a … picture (it may be an SVG drawing under another name)."). So an SVG can only reach sharp through the SVG handler, from bytes, even with no block.
- `svg.ts`: `sharp.block` in try/catch; on failure it warns and carries on. `checkSvgGuard()` probes that `sharp(path).metadata()` rejects a temp SVG and warns if not; both servers call it once at start-up (`createGalleryApp`, `createApp`) and still start if it fails.
- `shared/server/mediaSelfCheck.ts` (new) and `GET /api/gallery/media-check`: decodes an 8×6 AVIF, TIFF, GIF and BMP and an SVG made on the spot (bytes generated in code, no fixtures) through the handlers, and checks the guard: block applied, path refused, SVG named `.jpg` refused.
- `photo-tool/electron/selfTest.ts`: new `mediaFormats` step right after `health`. It is ok only if the check is ok **and** `blockApplied` and `pathRefused` are true, so CI hears about a build (Linux wasm, say) where the block does not hold, even though the sniff still protects it.
- Tests first: disguised SVGs (`.jpg/.png/.webp/.tif/.gif/.avif`, with BOM, UTF-16, gzipped) are refused with `sharp.unblock` in effect (they decoded before); `checkSvgGuard` warns when the block is lifted; `media-self-check.test.ts`; `gallery-formats.test.ts` checks the route.
- `photobook-editor/tests/core.test.ts` (local-first URL check): allows exactly `http://www.w3.org/2000/svg` in `svg.ts` and `mediaSelfCheck.ts`. It is the SVG namespace name, never fetched, and the probe SVGs need it.
- `.github/workflows/desktop.yml` not changed: `required_step` stays `taggingWorkerLoads`; a failing `mediaFormats` step already fails the overall `ok`.

**Packaged self-test, Windows (this machine):** `npm run dist:dir:photo-tool` on 01d426f, then `dist/installer/photo-tool/win-unpacked/Photo Tool.exe --self-test <temp copy of fixtures/generated/trip> --self-test-out <temp>`, with `PHOTO_TOOL_DATA_DIR`, `PHOTO_TOOL_PROFILE_DIR` and `PHOTOINFO_FALLBACK_DIR` in the scratchpad. Exit 0, overall ok, all 8 steps ok (health, **mediaFormats**, openFolder, starInViewer, sourceUntouched, taggingWorkerLoads, filterControl, navigationBlocked). `mediaFormats`: avif/tiff/gif/bmp 8×6, svg 2048×1536, svgGuard `{blockApplied: true, pathRefused: true, disguisedRefused: true}`, 1040 ms. The app exited by itself; no process left.

**Linux was not run** (no Linux here). The desktop CI's Linux jobs will run the same step; the `wasm` sharp mode is still the open question, and the step is built to fail loudly there if the block or a format is missing.

### Minor: BMP/ICO allocation

- `bitmap.ts` checks the data can fill the picture before `Buffer.alloc`: uncompressed needs `stride × height` bytes in the file; RLE is capped at 1024 pixels per data byte plus 65 536 slack ("The picture is too large for its data."). The 60-byte RLE file declaring 49 MP is now refused without allocating.
- Tests first for the two allocation cases (with a `Buffer.alloc` spy), then a "hostile and unusual" block: 2 bpp, top-down 8/32 bpp, RLE4 odd absolute run and truncated run, delta past the last row, ALPHABITFIELDS, bit-31 and zero masks, negative width, `INT32_MIN` height, OS/2 24 bpp, 4-bit ICO with mask, 32-bit ICO with zero alpha, ICO over the pixel cap, and a seeded 20 000-case fuzz (only `BitmapError`, never a crash). `media-bitmap.test.ts` now has 22 tests.

### M-5: HEIC format id in old editor rows

Photo Tool always stored `heif` for HEIC. The editor stored the bare extension, so HEIC rows imported before this branch say `heic` (and `.heif` ones `heif`); new imports say `heif`. Effect: `formatById('heic')` is null, so the transparency backfill skips those rows, which is right for HEIC anyway. A re-import updates the row (`format = excluded.format`). No migration added.

### Results (final HEAD 01d426f)

- `npm run typecheck`: clean.
- `npm test`: fast 1116 passed, 3 skipped; slow 299 passed, 1 skipped. The skips are the same as before this work.
- Playwright, both projects, ports 5885/5886/5887: 52 passed, 1 skipped (already skipped before).
- After the rebase this worktree's `node_modules` lacked `electron-updater`, which #4 added to the lock file. I ran `npm install --ignore-scripts` in the worktree to match the existing lock file (6 packages; `package.json` and the lock file unchanged), the same as the integration worktree has. Nothing was installed system-wide.

## Fix round 2

Final HEAD **b97de63** on `media-formats-2`, rebased onto `issues-integration` 8a849d3 (it had moved: a docs commit at v0.1.44). Version 0.1.45, bumped once in the last commit. Commits: 6f56576, 9246cc2 (phase 2), e83a199 (fix round 1), b97de63 (this round). Nothing pushed.

### R1-1: the sniff could be bypassed

Round 1's claim that the sniff alone keeps SVG away from sharp "even with no block" was false: it read 512 bytes, and a `.jpg` of 600 spaces then `<svg` got past it while libvips, which looks further, loaded it as SVG by its path.

- **Now a positive check** (`shared/server/mediaHandlers/sniff.ts` `rasterFormat`, used by `sharp.ts`). A file goes to sharp only if it starts with the magic bytes of a raster format sharp reads by file:
  - JPEG `FF D8` (what libvips itself checks: a JPEG whose third byte is not FF loads today, so it is kept);
  - the PNG signature;
  - `GIF87a` / `GIF89a`;
  - `RIFF....WEBP`;
  - TIFF and BigTIFF, `II*\0` / `II+\0` / `MM\0*` / `MM\0+`;
  - an `ftyp` box (size at least 16) whose major or compatible brand is a HEIF/AVIF one (`avif`, `avis`, `heic`, `heix`, `mif1`, `msf1` and kin).
- No search for `<svg` in any window. None of these magics can start an XML document, which must begin with `<` after an optional BOM and white space.
- Probed with the block lifted: an SVG behind each magic is never taken as SVG. libvips picks the raster loader and fails, or for `BM`/text first the SVG loader fails to parse.
- **Mismatched but real pictures** (a PNG named `.jpg`, an AVIF named `.jpg`, a TIFF named `.avif`) are read as what they are, as before. That is safe, and such files exist.
- **Everything else is refused.** I checked what sharp accepts by file today: `sharp.format` lists jpeg, png, webp, tiff, gif, svg, heif and vips. So the only things newly refused are SVG and the libvips-native `.v` format under a photo's name. JPEG with leading junk, NUL padding or PPM did not load before either.
- **The message** now reads "This file is not a JPEG picture…", saying "it holds text (it may be an SVG drawing under another name)" when the head looks like text (markup, UTF-16, gzip, or only white space).
- HEIC is not affected: it goes through libheif/sips, not this check. The fixtures (trip JPEGs, the six format fixtures) all pass.
- `mediaSelfCheck` (the desktop `mediaFormats` step) now also tries the 600-space `.jpg`.

**Tests (written first and seen to fail before the change, also with a regex that ignores the new wording, because the 600-space file was read):**

- `media-handlers.test.ts`, the disguised-SVG test, with `sharp.unblock` in effect:
  - It first asserts sharp really reads `spaces600.jpg` as SVG by path.
  - It then requires refusal of the 600-space `.jpg`, a 4000-character XML comment before `<svg` (alone, and after 600 spaces), and 900 bytes of tab/CR/LF in a `.png`, alongside the round-1 cases.
- New: "reads a picture by its own magic bytes, whatever its name says, and refuses one with none".
  - Read: PNG as `.jpg`, JPEG as `.png`/`.tif`/`.webp`/`.gif`, AVIF as `.jpg`, TIFF as `.avif`, GIF as `.png`, and a JPEG with trailing bytes.
  - Refused: a JPEG with junk first, `BM`+SVG as `.jpg`, an empty file, and `ftyp` with an unknown brand.
- New `rasterFormat` unit tests for each accepted magic and a list of near misses: `GIF88a`, `RIFF…WAVE`, a wrong TIFF version, MP4's `ftyp mp42`, a short `ftyp` box, BMP, ICO, PPM, gzip, markup and all-space heads.

### Minor: gzip-bomb test robustness

The RSS bound is gone. The test asserts the exact message 'This SVG is compressed (gzip), which is not supported.', which only `svg.ts`'s first-bytes check throws, before sharp or zlib gets anything. So it is refused before decoding. The time bound is now a loose 10 s.

### Results (final HEAD b97de63)

- `npm run typecheck`: clean.
- `npm test`: fast 1119 passed, 3 skipped; slow 299 passed, 1 skipped (skips as before).
- Playwright, both projects, ports 5885/5886/5887: 52 passed, 1 skipped (as before).
- The packaged self-test was not re-run this round. The media check's change (one extra refused file) is covered by `media-self-check.test.ts`. Round 1's Windows run stands, and Linux is still unrun.
