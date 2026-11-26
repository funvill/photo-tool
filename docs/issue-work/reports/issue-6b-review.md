# Review: #6 phase 2 (6b), branch `media-formats-2` (791c73f, 1711c82 on 9e28f24)

Read-only review. Worktree: `C:\Users\funvill\Documents\git\photobook_helper-media2`. Full suite not re-run (report carries it). Throwaway probes run against the worktree's sharp 0.35.5 / libvips 8.18.7 (Windows prebuilt), from the scratchpad (`probe6b/`): a 300k-case mutation fuzz of the BMP/ICO decoder, an RLE "tiny file, huge picture" case, gzipped-SVG cases, and RGBA-to-JPEG output.

## Spec verdict: mostly met, one stated step not done

Against issue #6, phase 2 (steps 5 to 7) and the controller's binding constraints:

| Requirement | Status |
|---|---|
| AVIF, TIFF (first page), GIF (first frame, `animated`), SVG through librsvg with no external fetches | Met. Registry entries, handlers, both programs, grid/viewer/zoom/shelf/import, all through the server. |
| "...after checking each against the prebuilt sharp **in the packaged app on Windows and Linux**" (step 5) | **Not done** (the report says so). No `selfTest.ts` check was added, and the Linux `wasm` mode is unverified. See I-3. |
| BMP, ICO via a small pure-JS decoder (step 6) | Met: a hand-written decoder, no dependency. |
| Fixtures generated in `scripts/make-fixtures.ts`, nothing from `photos/` or `data/` | Met (`fixtures/generated/formats`, 6 files). |
| Handler interfaces stable, `HandlerContext` unchanged | Met. Only an optional `exifBlock?()` was added to `MediaHandler`. |
| Import boundaries; no extension regex outside the registry | Met. The guard's `EXT` list already covers the new extensions, and nothing new was added outside the registry. |
| SVG untrusted: rasterised through sharp, never inlined, no external refs or scripts, raster capped | External refs, scripts, network and raster cap are met and well tested. **But the "input cap" can be bypassed by gzip** (I-1). |
| Animated GIF: first frame in the grid and thumbnails; edits and save consistent | Met. Viewer, edit and Save-as all use frame 0, and the copy is PNG. |
| Desktop-only; formats Chromium can't show still work | Met. The page never gets an original (no `file://`, and no route serves originals). |
| Per-handler `sniff` (magic bytes), per the issue's Tests section | Not done in phase 1 or 2. It is optional in the interface; noted only (M-7). |

## Quality verdict: good, with two Important fixes before merge

The code is careful and well commented. The decoder bounds-checks every read: the fuzz below found no crash, no hang and no wrong-size output. SVG reference blocking is genuinely tested, with a local HTTP server that must see zero requests. The catalog change is a fix. **Counts: 0 Critical, 3 Important, 7 Minor.**

### Important

**I-1. A gzipped SVG named `.svg` bypasses the ".svgz is left out" decision: a decompression bomb.** `shared/server/mediaHandlers/svg.ts:33-45`
- Leaving out `.svgz` only filters by extension. libvips' SVG loader inflates gzip from a **buffer** too: `sharp.format.svg` lists `.svgz` and `.svg.gz`, and `meta.format` comes back `'svg'`.
- Probe: a 0.41 MB file named `bomb.svg` (gzipped, 419 MB of XML) was accepted by `rasteriseSvg` and rasterised to 2048 px. Peak RSS grew by about **894 MB** in about 1.1 s. The document is parsed twice, once for `metadata()` and once for the render.
- The 20 MB cap applies to the compressed bytes, so a 20 MB file can expand by roughly 1000×.
- **Failure scenario:** one such file in a folder the user opens (or in an editor Shelf folder) drives the server utility process out of memory. No catalog row is written, so it happens again every time that folder is scanned.
- **Fix:**
  - Before handing the bytes to sharp, refuse gzip (`bytes[0] === 0x1f && bytes[1] === 0x8b`). Better still, require the first non-whitespace byte after an optional BOM to be `<`.
  - Add a test: a gzipped SVG under `.svg` is refused.
  - Optionally add `.timeout({ seconds })` to the render (see M-4).

**I-2. JPEG output from a see-through source turns transparent areas black, while every view shows them on white.** `shared/server/photoEditRender.ts:51` (affects `photo-tool/server/app.ts:396` and `photobook-editor/server/importer.ts:283`)
- Probe: `sharp(<RGBA, alpha 0>).jpeg()` gives pixel `[0, 0, 0]`. libvips flattens on black.
- This branch marks AVIF and TIFF `alpha: true, saveAs: 'jpeg'`. It also made `/full` flatten on white "to match the thumbnails".
- **Failure scenarios:**
  - **Photo Tool:** a cutout AVIF or TIFF is shown on white everywhere. **Save as** writes a JPEG with black where it was transparent.
  - **Editor:** any alpha format with an edit in `photoinfo.json` is rendered to `<hash>-edit-<key>.jpg`. That now includes SVG and ICO, whose pictures are mostly transparent, and they land in the book on black.
  - The PNG case existed before ("transparency is lost there"). This branch widens it to formats where transparency is the norm, and it contradicts the white `/full` the same branch introduced.
- **Fix:** in `renderEdited`, `if (format === 'jpeg') out = out.flatten({ background: '#ffffff' })` before `.jpeg()`. Add a test that saves an alpha TIFF or AVIF and checks a corner is white.

**I-3. Step 5's packaged-app check was not done, and there is a startup risk in the Linux `wasm` mode.** `shared/server/mediaHandlers/svg.ts:29`, `scripts/desktop/build.mjs:51-58,107`
- **Windows and Linux native/shim builds look fine.** The worktree's Windows prebuilt reports `heif` 1.23.5 with `aom` (AVIF input), `rsvg` 2.63.2, `tiff` 4.7.2 and `cgif`. Shim and native modes ship the same `@img/sharp-libvips-*` build.
- **The wasm mode is the risk:**
  - `PHOTOBOOK_LINUX_SHARP=wasm` (`@img/sharp-wasm32`) is a different build.
  - `sharp.block(...)` runs **at module load** of `svg.ts`, and `media.ts` imports the handlers. If the wasm build lacks `block`, the import throws and **both servers fail to start**, not just SVG.
  - If the build has `block` but does not recognise the operation names, the call may silently do nothing.
  - If the wasm build lacks librsvg or AVIF, those formats fail per file. That is acceptable, but unknown.
- **The block is the only defence for a disguised SVG.** An SVG named `.jpg`, `.png`, `.webp`, `.tif` or `.gif` goes to `sharpHandler`, which hands sharp the **path** (`sharp.ts:21`, and `preview` returns the path).
  - If the block is not in effect, librsvg loads it by path and draws images beside it: the sibling-file leak the report demonstrated.
  - The block is therefore not belt-and-braces; it is load-bearing.
- **Fix:**
  - **Assert the effect, not the API.**
    - At server start, or in the self-test, write a tiny SVG to a temp path and check that `sharp(path).metadata()` rejects.
    - If it does not reject, refuse every SVG-sniffing file: either refuse `.svg`, or have `sharpHandler` check the first bytes and refuse SVG/XML content.
    - Do not crash the server when `block` is missing.
  - Add a `selfTest.ts` check in each program that decodes one tiny in-memory AVIF, TIFF, GIF and SVG, runs a BMP through the decoder, and runs the block assertion above. Run it in the desktop CI on Windows and Linux.

### Minor

**M-1. The BMP/ICO decoder allocates the full RGBA buffer before checking that the file holds the pixels.** `shared/server/mediaHandlers/bitmap.ts:119` (alloc) vs `:167` (`need(start + stride * height)`)
- **Failure scenario:**
  - For uncompressed files, a 60-byte BMP claiming 7000×7000 makes a 196 MB `Buffer.alloc` and only then throws "cut short". The four scan or import workers could do that together.
  - For RLE (`:135`) there is no such check at all. Probe: a **60-byte** RLE8 file decodes to a 7000×7000 (49 MP) bitmap, a fully transparent one, then gets PNG-encoded and thumbnailed.
  - This is no worse than a PNG bomb through sharp (whose default limit is about 268 MP), so it is not Important.
- **Fix:**
  - For uncompressed files, move the `need(start + stride * height)` check above the alloc.
  - For RLE, refuse when `width * height` is wildly beyond what the RLE stream length could encode (for example, more than `(buf.length - start) * 128` pixels plus generous delta slack), or use a lower pixel cap for RLE.

**M-2. Decoder memory per file is up to 256 MB read plus 200 MB RGBA, with no cache for `image()`.** `bitmap.ts:24-26,241-249`
- With concurrency 4 (`scanner.ts:68`, `importer.ts:45`), a folder of large BMPs can peak around 1.8 GB.
- The shelf preview's result is cached, but its decode still happens in full on the first view.
- **Fix:** consider a lower `BITMAP_MAX_BYTES` (BMP pictures over 50 MP are refused anyway, so 50 MP × 4 bytes plus headers is about 200 MB), or a small semaphore around bitmap decodes.

**M-3. Decoder tests miss cases that matter for hostile input.** `shared/tests/media-bitmap.test.ts`
- The decoder was written before its tests.
- My probe fuzz (200k BMP and 100k ICO mutations of valid seeds) threw only `BitmapError`: no `RangeError`, no hang (max 29 ms), no wrong-size output. So the code is sound, but these are untested:
  - 2 bpp;
  - top-down 1/4/8/32 bpp;
  - RLE4 absolute mode with an odd count (word padding);
  - a truncated absolute run (`need(p + bytes)`);
  - delta past the last row;
  - ALPHABITFIELDS (compression 6);
  - 32-bit BITFIELDS with a 40-byte header;
  - zero, non-contiguous or wider-than-8-bit masks;
  - masks with bit 31 set (signed `&`, which is correct only because of the `>>>`);
  - negative width; height `INT32_MIN`;
  - OS/2 core with 24 bpp;
  - palette ICO entries (1/4/8 bpp) with a mask;
  - a 32-bit ICO whose alpha is all zero (mask must apply);
  - an ICO DIB declaring more than `BITMAP_MAX_PIXELS`;
  - the RLE tiny-file case (M-1).
- **Fix:** add these as table cases, and add a small seeded mutation fuzz test that asserts "returns a correctly sized bitmap or throws `BitmapError`".

**M-4. No time limit on SVG rendering.** `svg.ts:45`
- An SVG with heavy filters (a large `feGaussianBlur`, `feTurbulence`, deep `<use>` fan-out within libxml's limits) at up to 4096² can occupy a libuv thread for a long time during a scan.
- **Fix:** `sharp(bytes, …).timeout({ seconds: 20 })` on the render. Also consider reusing one parse for metadata and render, which halves the cost (see I-1).

**M-5. The report's claim that old editor rows "already used the registry ids" is wrong for HEIC.** `photobook-editor/server/importer.ts:295` (old code at 9e28f24: `importer.ts:293`)
- The old rule stored the bare extension, so a `.heic` was stored as `'heic'`. It is now `'heif'`, and old and re-imported rows will mix.
- I found no reader that depends on it. `formatById('heic')` is undefined, so the alpha backfill skips it, which is correct for HEIC, and the editor UI never shows `format`. So this is harmless today, but it is a latent inconsistency.
- **Fix:** a one-line migration (`UPDATE assets SET format = 'heif' WHERE format = 'heic'`), or correct the report and PR text.

**M-6. Photo Tool now catalogues the format by extension, not by content.** `photo-tool/server/scanner.ts:234`
- A mislabelled file (JPEG bytes named `.png`) used to show "JPEG" in Details and now shows "PNG". Old catalog rows are not rescanned, so a mislabelled file's row differs depending on when it was scanned.
- For correctly named files the stored value is unchanged: `jpeg`/`png`/`webp`/`heif` equal the registry ids. Only `Details.tsx:223` reads it, for display. So migration is not needed.
- **Fix:** none required. Optionally display `formatById(format)?.label` (it shows "HEIF" for HEIC today, which was already so before this branch).

**M-7. Process-wide `sharp.block` side effects.** `svg.ts:29`
- **Coverage is good:**
  - Both servers import `media.ts`, which imports the handlers, so the block is applied before any request.
  - worker_threads share the process's libvips.
    - The HEIC worker uses no sharp.
    - The tagging worker imports only `node:` modules and `@huggingface/transformers`. That package depends on sharp, but `npm ls sharp` shows a single `sharp@0.35.5`, deduped. So any sharp it loads is the same native binding and libvips, with the block applied.
  - The Electron main process does not use sharp.
  - The Source block does not affect sharp's stream input (probe: a stream SVG still loads), because sharp buffers streams. So the Source entry is belt-and-braces, and it is harmless because there is no base path.
- **Side effects:**
  - Nothing ever unblocks, so any future in-process code that wants an SVG by path must read bytes (this is documented).
  - In vitest's threads pool, the block leaks into every test file sharing the process. A future test doing `sharp('x.svg')` will fail depending on scheduling.
  - Separately, the issue's optional `sniff` was not implemented. Only SVG checks content (`meta.format === 'svg'`).
- **Fix:** document the vitest leak beside the block, or set the test pool so the files that import the handlers are isolated.

### Things checked and found fine

- **Integer overflow:**
  - All size arithmetic is in JS doubles. `width * height > 50e6` is checked before any use, and negative or zero width and height are refused.
  - Top-down BMPs are handled, and top-down RLE or top-down icons are refused.
  - A palette index out of range renders black. `colorsUsed > 256` is refused, and palettes running past the end of the file are refused.
- **ICO:**
  - `offset + size > length` entries are skipped.
  - PNG-in-ICO goes to sharp with `limitInputPixels: 50M`.
  - BMP-in-ICO is bounds-checked within its own subarray, including the mask.
- **SVG:**
  - It is only ever rasterised from bytes.
  - `file://`, relative, `../`, `http://`, `<use>`, XInclude, `@import` and `xml-stylesheet` are all inert, and an external entity is refused.
  - The raster is capped at 4096 by density plus `resize(inside)` plus `limitInputPixels`.
  - A disguised `.jpg` SVG cannot load by path.
- **The see-through background in the zoomed view** (`photo-tool/server/app.ts:420`): **not a regression.**
  - Thumbnails (`media.ts:206`) and the editor's opaque thumbnails were already flattened on white, so zoom used to flash from a white `m` thumbnail to a black `/full`. It is now consistent.
  - Only `web/api.ts:106` (zoom) uses `/full`, and nothing needs alpha from a JPEG.
  - Cutout PNGs now zoom on white. This is a visible change, so it is worth stating in the PR (the report does).
- **Save-as-copy:**
  - `editInPlace: false` routes through the phase-1 plumbing. `saveToFile` refuses (`editActions.ts:84`), Save as writes `.jpg` or `.png` (`:139`), and the store marks `saveBlocked` and skips the item in Save all (`store.ts:420,1184`).
  - Edits render from the working image (`workPathOf`/`work.path`), never from an SVG path.
- **Editor `exportAssets` / backfill:** both now go through `workingFile`, so SVG, BMP and ICO originals are never handed to sharp by path. `workingFile` accepts a string hash, which suits the editor.
- **No in-page decoding:**
  - The editor's browser backend that the issue lists (`web/backend/browser/folders.ts`, `BrowserFolderPicker.tsx`) no longer exists. `photobook-editor/web/backend/` holds only `http.ts`, `index.ts` and `types.ts`.
  - Neither `web/` tree uses `acceptAttribute`, `createObjectURL`, `createImageBitmap` or `FileReader`. Photo Tool's page uses the registry only for `copyOnly`.
  - So an SVG or TIFF never reaches the page undecoded.
- **10-bit AVIF:** the prebuilt sharp here encodes and decodes a 10-bit AVIF (`bitsPerSample: 10`), so HDR-depth AVIFs are not refused.
- **CI fixtures:** `.github/workflows/test.yml:25` runs `npm run fixtures` before `npm test`, so the `describe.runIf` format suites do run in CI.
  - Only a local checkout without fresh fixtures skips them silently.
  - The desktop self-test points at `fixtures/generated/trip` only, so it never sees the new formats (I-3).

## ⚠️ Cannot verify from the diff

- Whether `@img/sharp-wasm32` (Linux `wasm` mode) exposes `sharp.block`, recognises the two operation names, and includes librsvg and an AV1 decoder (I-3). If it silently ignores the names, an SVG disguised as `.jpg` is loaded by its path there.
- The format support of the Linux prebuilt `@img/sharp-libvips-linux-x64` inside the packaged Electron app, especially under the `shim` patch. It is expected to match the Windows prebuilt probed here, but it has not been run.
- How far a 20 MB gzipped SVG really goes on the user's machines (out-of-memory kill versus slow). I stopped the probe at 419 MB expanded on purpose.
- Desktop e2e or self-test behaviour of the new formats in installed builds. No CI run was available.

---

## Re-review 1: fix round (6463764..01d426f, HEAD 01d426f on issues-integration 0b18c30)

Scope: the fix commit diff, the report's "Fix round 1" section, and the touched lines in the worktree.
- I did not re-run the suite.
- Probes are in the scratchpad (`probe6b/sniff.mts`). They run against the worktree's sharp 0.35.5, with `sharp.unblock` used to simulate a build where the block does not hold.

**Verdict.**
- I-1, I-2 and the decoder allocation fix are real, and each has a test that fails without it.
- I-3's content sniff **can be bypassed** (R1-1, Important). On this Windows build the block still holds, and CI fails a build where it doesn't, so the bypass is reachable only on such a build.
- **Counts this round: 0 Critical, 1 Important, 3 Minor.**

### Fix-by-fix

| Item | Real? | Test fails without it? |
|---|---|---|
| **I-1: gzip refused** | Yes. `rasteriseSvg` checks `isGzip(bytes)` and `startsWithMarkup` before any sharp call (`svg.ts`). It also adds `.timeout({ seconds: 20 })` (my M-4). | Yes. The 200 MB-inflated bomb must be refused with `/compressed/`, within 2 s and under 100 MB RSS; before the fix libxml parsed it. Also tested: a non-markup `.svg` is refused, and a BOM plus whitespace is accepted. |
| **I-2: JPEG on white** | Yes. `photoEditRender.ts`: `out.flatten({ background: '#ffffff' }).jpeg(...)`. PNG and WebP are untouched. | Yes. The corner must be above 245 for identity, rotate 90 and straighten 5. The editor test checks an SVG and a cutout PNG with a photoinfo edit. PNG/WebP alpha stays 0. |
| **I-3: guard asserted, not assumed** | Yes. `block` is in try/catch; `svgPathRefused()` probes a real temp SVG by path. `checkSvgGuardOnce()` runs in both `createGalleryApp` and `createApp`. `/api/gallery/media-check` feeds the new `mediaFormats` self-test step. The step is ok only with `blockApplied && pathRefused`, and the harness exit code fails CI (`desktop.yml:85`, `:115`). | Yes. With `sharp.unblock` in effect, disguised `.jpg/.png/.webp/.tif/.gif/.avif`, BOM, UTF-16 and gzipped files must be refused with `/text, not a/`. They decoded before. |
| **Decoder: length before alloc** | Yes. The `need(start + stride * height)` check moved above `Buffer.alloc`. RLE is capped at `(len - start) × 1024 + 65 536` pixels (`bitmap.ts`). | Yes. A `Buffer.alloc` spy asserts no allocation over 1 MB for the 60-byte 49 MP RLE file and the short uncompressed file. |
| **Decoder: hostile cases (my M-3)** | Added: 2 bpp; top-down 8/32; RLE4 odd absolute run and truncated run; delta past the end; ALPHABITFIELDS; bit-31 and zero masks; negative width; `INT32_MIN`; OS/2 24 bpp; palette ICO with mask; zero-alpha 32-bit ICO; ICO over the cap; a seeded 20k fuzz asserting "right size or `BitmapError`". | n/a (coverage). |

**No-remote-URL exception: narrow, as asked.** `photobook-editor/tests/core.test.ts`:
- It matches the exact string `http://www.w3.org/2000/svg` (`u === …`). There is no prefix or regex, so `http://www.w3.org/anything-else` still fails.
- It applies only when `join(f)` is one of exactly `shared/server/mediaHandlers/svg.ts` or `shared/server/mediaSelfCheck.ts`.
- Comment lines were already skipped. Nothing else was widened.

### Content sniff: bypass probe

The sniff is a `.jpg` file checked by `looksLikeText(readHead(file))`, which reads 512 bytes. I ran each case against sharp with the block lifted.

| Case | sharp detects SVG? | Sniff | Result |
|---|---|---|---|
| UTF-8 BOM + whitespace + `<svg` | yes | refused | ok |
| `<?xml …?><!-- c --><svg` prolog/comment | yes | refused | ok |
| UTF-16 LE/BE with BOM, UTF-16 LE without BOM, UTF-32 BOM | no | refused | ok |
| gzip in `.png` / `.tif` | (n/a) | refused (`isGzip`) | ok |
| SVG bytes in `.jpg` | yes | refused | ok |
| `\f`, `\v`, NUL, NBSP, double BOM, `hello ` before `<svg` | no | passed | harmless (libvips doesn't take it as SVG either) |
| **600 spaces, then `<svg`** | **yes** | **passed** | **BYPASS** |
| 1200 spaces, then `<svg` | no | passed | harmless |

### Important

**R1-1. The sniff window (512 bytes) is smaller than libvips' SVG sniff window: about 513 to ~1000 bytes of leading whitespace gets an SVG past the sniff.** `shared/server/mediaHandlers/sniff.ts` (`HEAD_BYTES = 512`, `contentStart`)
- **How:** `contentStart` walks off the end of a whitespace-only head and finds no `<`, so `looksLikeText` is false. libvips still finds `<svg` within its own window and loads the file by path.
- **Failure scenario:** on a sharp build where the block does not take effect (the open question for the Linux wasm build), `photo.jpg` made of 600 spaces followed by `<svg …><image href="secret.png"/>` is rasterised by path. It draws sibling files into the thumbnail: the exact leak the sniff was added to stop.
- **Why only Important:**
  - On Windows the block holds (packaged self-test: `pathRefused: true`).
  - The `mediaFormats` step makes CI fail a build where it doesn't hold, so such a build should not ship unnoticed.
  - But the fix claims the sniff alone makes SVG unreachable "even with no block", and that claim is false.
- **Fix:** prefer a positive check over a deny-list. Each sharp-read handler requires its own magic bytes:
  - JPEG `FF D8 FF`;
  - PNG signature;
  - `RIFF....WEBP`;
  - `....ftyp` for AVIF;
  - `II*\0` / `MM\0*` for TIFF;
  - `GIF87a` / `GIF89a`.

  At minimum, read at least 4 KB, and treat a head that is all whitespace as text. Add the 600-space case to the disguised-SVG test, which runs with `sharp.unblock`.

### Minor

- **R1-M1. HEIC is not sniffed, though the report says "JPEG, PNG, WebP, HEIC…".** `heic.ts` is untouched.
  - Off macOS that is harmless: libheif-js decodes bytes, and sharp only ever reads the derived JPEG.
  - On macOS, `sips` is handed the path. It is not a shipped platform today, but correct the report, or add `looksLikeText` to `heifHandler.preview`.
- **R1-M2. Only Photo Tool's self-test has the `mediaFormats` step.** The editor ships the same `shared/` code and sharp build, so one program's check covers the build, but not the editor's own installer packaging. Optional: mirror the step in `photobook-editor/electron/selfTest.ts`.
- **R1-M3. The gzip-bomb test asserts RSS growth under 100 MB and time under 2 s** (`media-handlers.test.ts`). RSS is process-wide and shared with concurrent vitest work, so this may flake on a busy CI runner. Consider asserting only the error, plus a no-allocation spy as in the bitmap tests, or keep a generous bound.

### Touched lines: no new Critical issues

- `sharpHandler` now opens each original for a 512-byte read on every `preview` and `image` call. That costs one extra open per call; it is closed in `finally`, and it is negligible.
- `checkSvgGuardOnce` writes a temp file once per process.
- In `renderEdited`, straighten's black fill is still cropped away before the white flatten, so the corner test covers it.
- `mediaSelfCheck` cleans up its temp dir in `finally`.
- The report's Windows packaged self-test (8 of 8 steps, `svgGuard` all true) is consistent with the code. Linux, including wasm, is still unverified ⚠️.

---

## Re-review 2: R1-1 only (e83a199..b97de63, HEAD b97de63 on issues-integration 8a849d3)

Scope: R1-1, and whether the new check refuses valid photos. Probe: `probe6b/magic.mts`, run against the worktree's sharp, with the block lifted where noted.

**Verdict: R1-1 is closed.**
- The new check does not refuse any photo that loaded before. The one exception is an ISO box using the 64-bit size form, which is theoretical.
- One path still reaches sharp by file path without the check (R2-M1, Minor), behind a fallback in the editor's export.
- **Counts: 0 Critical, 0 Important, 1 Minor**, plus R1-M1 carried over.

### Bypass closed

**The check is now positive.**
- `sniff.ts rasterFormat` accepts only these starts: JPEG `FF D8`, the PNG signature, `GIF87a`/`GIF89a`, `RIFF…WEBP`, TIFF and BigTIFF (both byte orders), or an `ftyp` box with a known HEIF/AVIF brand.
- `sharpHandler.preview` and `image()` (`sharp.ts`) refuse anything else, before sharp sees the path.
- Window size no longer matters: any SVG has to start with `<`, possibly after a BOM and white space, and no accepted magic starts that way.

**Probe with the block lifted:** an SVG placed right behind each accepted magic is not taken as SVG by sharp in any case. The cases were:
- `FF D8` + `<svg`, and `FF D8` + spaces + `<svg`;
- PNG signature + `<svg`;
- `GIF89a` + `<svg`;
- `II*\0` + `<svg`;
- `RIFF…WEBP` + `<svg`;
- `ftyp heic/mif1` + `<svg`.

All were refused by sharp, because the SVG loader requires `<` first.

**The cases from Re-review 1** (600 spaces, comments, tab/CR/LF in a `.png`, BOM, UTF-16, gzip) now have no raster magic, so they are refused. The test adds them with `sharp.unblock` in effect.

**Every path to sharp by file path:**
- Photo Tool's scan, `/full`, `/image` and edit render, the editor's import, backfill and Shelf preview, and `mediaSelfCheck` all go through `workingFile` or `handler.image()`, so they all pass the check first.
- The functions in `media.ts` (`orientedSize`, `analyze`, `writeJpegThumb`, `makeThumbnails`, `hasTransparency`) and `renderEdited` only ever receive that working path.
- Gaps:
  - **R2-M1** below.
  - **R1-M1** (macOS `sips` for HEIC) is unchanged. It is not sharp, and macOS is not shipped.

### Valid photos

- **HEIF/AVIF brands.** `rasterFormat` returns `heif` for all of these major/compatible brand sets:
  - `heic`/`mif1,heic` (iPhone);
  - `mif1`/`heic,miaf`;
  - `avif`/`mif1,miaf,MA1B`;
  - `avis`/`avio,msf1,miaf`;
  - `msf1`/`hevc`;
  - `heix`/`mif1`;
  - `miaf`/`avif`;
  - `MiHE`/`…,heic` (Apple's newer HEIC);
  - `jpeg`/`mif1`;
  - `mif1` with no compatible brands.

  sharp's own AVIF output (`ftyp avif`, compatible `mif1 avif miaf`) is accepted. Any real HEIF or AVIF carries `mif1`/`msf1` or a listed brand, so the brand set is adequate.
- **The only HEIF refusal:** an `ftyp` box using the 64-bit size form (size field = 1). No real HEIF or AVIF writer does this. If it is ever seen, treat size 1 as "read the brands in the head".
- **HEIC itself** (`.heic`/`.heif`) goes through `heifHandler` (libheif/sips), not this check, so it is unaffected. A HEIC named `.jpg` is accepted and then fails in sharp's HEVC-less libheif, as it always did.
- **JPEG.** libvips' own test is `FF D8`, and the check matches it exactly. A JPEG with junk or NUL padding first did not load in sharp before either. That matches the implementer's probe, and my earlier `nul` case was refused by sharp too.
- **Mismatched extensions** (a PNG named `.jpg`, an AVIF named `.jpg`, and so on) are still read by their content. That is unchanged behaviour, and it is safe.
- **SVG, BMP and ICO** never reach this check. Each has its own handler: SVG is rasterised from bytes (and refused if gzipped or not markup), and BMP/ICO use the pure-JS decoder. A BMP or ICO named `.jpg` is refused ("not a JPEG picture"); sharp could not read it anyway. That is fine.

### Minor

**R2-M1. The editor's export hands the original path to sharp when its handler refuses the file.** `photobook-editor/server/app.ts:404`
- The line is `workingFile(r.original_path, …).then((w) => w.path, () => r.original_path)`. On a refusal it hands `pdf.ts` / `imageExport` / `flipbook` the original, and they read it by its path.
- **Scenario:** a photo is imported, then its file is replaced with an SVG under the same name, and it has no derived copy. On export, the sniff refuses it, the fallback passes the path anyway, and only `sharp.block` stands between the SVG and its sibling files.
- **Why Minor:** import would have refused the SVG, the swap needs someone to write into the user's folder after import, and the block holds on the verified Windows build.
- **Fix:** on refusal, leave the asset out of the map, like a missing original, so the export reports it. Or fall back only for formats not read through `sharpHandler`.
