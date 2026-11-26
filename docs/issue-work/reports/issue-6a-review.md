# Review: media-registry (Part A: editor desktop only, Part B: #6 Phase 1)

Base `issues-integration` (3674fb9) ... head `3dc700c`. Read-only. Checks run: `npx vitest run` on media-formats, media-formats-guard, no-upstream and boundaries (4 files, 27 passed); `npm run typecheck` (clean). Full suites not re-run.

### Spec Compliance

- ✅ Spec compliant for everything verifiable from the diff and the targeted runs.
- ⚠️ Cannot verify from the diff: (a) the Playwright results and the one flaky `draft-stars` run are the implementer's claims, not re-run. (b) No desktop bundle was built and no desktop self-test run (the report says so). The desktop-side edits are small: the editor self-test's HEIC predicate and Photo Tool's save-dialog filter. Both type-check. The controller or CI should run the desktop self-test once on Windows before merge. (c) `vite build` of the editor was not run here. `vite.config.ts` kept `publicDir: false` as it was, and `index.html` is unchanged apart from nothing, so the build should be unaffected. The editor Playwright project covers it.

Judging the issue's Phase 1 steps: the registry and handlers exist (1), every list and HEIC check named in the issue is replaced (2), the guard test exists (3), and existing tests pass unchanged apart from the ones Part A had to delete or edit (4). The issue's "editor browser backend" sites (`folders.ts`, `BrowserFolderPicker.tsx`) are removed by Part A, which is Steven's decision; the plan's "browser can decode it" capability is therefore correctly dropped.

### Strengths

- The registry is small and pure (`shared/core/mediaFormats.ts`). `extensionOf` and `isSupported` are written to match Node's `extname` and `basename`, and `media-formats.test.ts` proves it against the old functions on 32 awkward names, using `win32` so it runs the same on Linux CI.
- `workingFile` keeps its signature, the `derived/<sha256>.jpg` name and the sips/libheif split (`mediaHandlers/heic.ts`). The lazy hash removes the three "is it HEIC, then hash" checks without hashing JPEG/PNG/WebP. The test asserts that sharp formats never call `contentHash`.
- The user-visible texts are preserved: "HEIC photos can only be saved as a copy", the "Skipped ..." toast, and the save-dialog filter names (`JPEG photo` `jpg,jpeg`; `PNG photo`; `WEBP photo`).
- A load-time check fails if a format has no handler or the reverse.
- Part A is thorough: typecheck is clean, no reference to `__BROWSER_BACKEND__`, `isBrowserBackend`, `backend/browser`, `WebNotes`, `BrowserFolderPicker`, `needsAccess`, `unsupported`, `WebExtras`, `make-demo` or `demo-photos` remains outside history docs, and a no-upstream test now pins that.
- Commits are all authored and committed by SWS-Chipkin with the trailer; `package.json` and the lock are at 0.1.39, one bump over integration.

### Check results (the seven asked)

1. **Nothing the desktop still uses was deleted.** The deleted `web/public/` was never shipped: `photobook-editor/vite.config.ts` had `publicDir: false` before this branch (confirmed against `issues-integration`), and `index.html` references only `./main.tsx`. Fonts, libheif, pdfium and the places data come from `shared/server/resources.ts`, untouched. The PDF path (`server/pdf.ts`, `photobook-editor/shared/pdfWriter.ts`, `flipbookViewer.ts`) only had comments changed. The only editor worker code lived in `backend/browser/` (`export.worker.ts`, `media.worker.ts`, `pool.ts`); the server importer's "worker" is a Promise pool, and HEIC decoding keeps its own worker in `shared/server/heic.ts`. Dropping `worker: { format: 'es' }` is correct because no page worker remains. `main.tsx` still mounts `VersionCheck`, which was the same behaviour because the define was false.
2. **No dead references**, with two leftovers (Minor 1, 2). Imports, routes, build config, scripts, workflows and docs were grepped. Historic docs (`docs/superpowers/*`, `docs/electron-plan.md`) still describe the old layout, which is acceptable as history.
3. **Supported formats are unchanged.** `SUPPORTED_EXTENSIONS` is the same six (asserted against the old set in both programs). HEIC: `heifHandler.preview` is the old `workingFile` body (darwin sips, otherwise `heicToJpeg`), `heifHandler.image` is `heicImage` on every platform as the shelf did. `scanner` stores `formatOf(path).id` (`heif`) when a decoded copy was used, as `isHeic ? 'heif'` did. `saveAs`, `copyOnly`, `withFormatExtension` and `editFormatFor` give the same results for every supported name. The extension-less, drive and slash cases are covered by the tests.
4. **The guard test works for the forms that were in the code**, with gaps (Minor 3). It is red-first, scans `shared/`, `photo-tool/`, `photobook-editor/` (skipping `tests`, `node_modules`, `public`), and has four allowed lines each with a reason. I ran the three patterns on extra shapes. Caught: `/\.(jpg|jpeg)$/`, `/\.png$/`, `/\.(?:png|jpg)$/`, `.endsWith('.png')`, `['jpg','png'].includes(e)`, a regex whose `\.(jpe?g|` is split over a line, new formats (`tif`, `cr3`, `avif`). Missed: a regex with no `\.` such as `/(jpe?g|png)$/`, `endsWith('png')`, a one-element list `['heic']`, `accept=".jpg,.png"` and MIME lists, and a list written one entry per line without dots (it scans line by line).
5. **The three tiny changes** are real and as described, all unreachable in practice. (a) A file named exactly `.png`/`.webp`: `editFormatFor` now gives `jpeg`; it cannot reach the editor because `isSupported` already excludes it (Node `extname('.png')` is empty). (b) `shelfPreview` refuses a file named `.jpg`, where the old regex let it through; the listing never offers one. (c) On Linux a backslash in a file name now splits the base name, which only matters for the `._` rule and the extension of a name like `x\._a.jpg`. One more of the same kind that the report does not list: a Windows drive-relative name such as `C:._a.jpg` is now treated as a photo (Node's `win32.basename` strips the drive, `baseOf` does not). Negligible. None needs a fix.
6. **`pdfjs-dist` and `fake-indexeddb` left in `package.json` is acceptable.** Neither is imported anywhere (grep), the desktop packager takes its module list from `scripts/desktop/build.mjs`'s `EXTERNAL`, not from `package.json`, so neither is packaged, and `make-notices` is given the program's module list. The cost is a lock/`npm ci` weight and, in the fallback path of `make-notices` ("every production dependency"), a notice for a package that is not shipped. It belongs in a small follow-up, as the commit message says. Please make sure that follow-up is actually filed.
7. **Boundary rules hold.** `boundaries.test.ts` passes. `shared/core/mediaFormats.ts` imports nothing; `photoEdit.ts` imports only it; `shared/server/mediaHandlers/*` import only `shared`; the programs import `shared` only. `photo-tool/web/store.ts` (browser code) imports the pure core module, which is what that file is for.

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)
None.

#### Minor (Nice to Have)

1. `photobook-editor/web/index.html:6`: the CSP still allows `worker-src 'self' blob:` (and `connect-src ... blob:`). Nothing in the page makes a worker now. Drop `worker-src` when the page is next touched; keep `blob:` for `img-src`/`connect-src` only if something still needs it.
2. `docs/ARCHITECTURE.md:37` (and the editor README) keep a paragraph about the removed mode "once shipped as a static web site ... IndexedDB and Web Workers". It is history, but a new reader does not need it; one sentence would do.
3. `shared/tests/media-formats-guard.test.ts:31-37`: the guard's gaps listed under check 4 (line-by-line scan; no-dot regexes; MIME and `accept` strings). Cheap hardening: also flag `endsWith\(['"]\.?(ext)['"]\)` and any `accept=` containing an extension, and scan the whole file text for a `[` list that spans lines. Not needed to merge.
4. `shared/core/mediaFormats.ts:28` and `shared/tests/media-formats.test.ts` ("by sharp's format names, as its catalogue stores it"): true for Photo Tool, not for the editor. `photobook-editor/server/importer.ts:288` stores `format` as the file extension (`'heic'`, `'heif'`, `'jpeg'`, `'png'`, `'webp'`). `app.ts:173` only works because `png` and `webp` happen to be both ids and extensions. For 6b (`.tif`, `.svg`) a lookup by the stored value will miss, so the importer should store `formatOf(path).id`, or the comment should say what the editor stores. No behaviour change now, since `'heic'` was never in `ALPHA_FORMATS`.
5. `shared/server/media.ts:36-37`: two blank lines were left where `ALPHA_FORMATS` was removed.
6. `acceptAttribute()`, `mime`, `kind` and `animated` have no caller yet. They are what the issue specifies, so this is not scope creep; just note that `acceptAttribute` is now tested but unused.

### Assessment

**Spec compliance:** ✅ Spec compliant (with the ⚠️ items above for the controller).

**Task quality:** Approved

**Reasoning:** Part A removes only the in-browser mode and nothing the served editor, the PDF path or the HEIC worker uses, and the types check. Part B moves every list and HEIC check into one table and one handler per format with no change in the supported set or in HEIC handling on any platform, and the tests compare it with the old functions. The remaining points are polish and one latent inconsistency to fix in 6b.

Counts: Critical 0, Important 0, Minor 6.
