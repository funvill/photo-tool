Remove the editor's in-browser mode; #6 Phase 1: one media format registry for both programs

Part of #6

This PR does two things, in separate commits: it removes the Photobook Editor's in-browser mode (Steven's decision: the editor is a desktop program from now on), then lands Phase 1 of #6, a media format registry that replaces every scattered image-extension list and HEIC special case in both programs. It adds no new formats and changes no behaviour.

## Part A: the editor is desktop only

- Deleted `photobook-editor/web/backend/browser/` (the IndexedDB store, in-page decoding, the export and media workers, its folder lists), `BrowserFolderPicker.tsx`, `WebNotes.tsx`, and the web demo (`web/demo/`, `web/public/`, `scripts/make-demo.ts` and the `demo-photos` npm script).
- Removed the `__BROWSER_BACKEND__` build switch, `Backend.kind`, `Backend.web` with its `WebExtras` / `StorageInfo` types, `needsAccess` / `unsupported`, and `isBrowserBackend`. Every caller keeps its local-server branch: the folder picker is the server one, Home has no demo projects, backup button or web notes, the Library has no "allow access" notice, and the Shelf has no browser picker paths. The demo and web-only CSS went with them.
- The served page and the desktop window are unchanged (editor e2e passes on the served page).
- Tests: deleted `browser-analysis`, `drop-web`, `web-demo` and `web-storage`, cut the tea-poster recipe case from `desktop-docs`, and renamed one `drop-result` case that said "(web version)". `no-upstream.test.ts` gains a test that the browser mode stays gone.
- Docs: `ARCHITECTURE.md` and the editor README say it is a desktop program; comments that mentioned "the web version" were updated.

## Part B: the media format registry (6a)

- `shared/core/mediaFormats.ts` (pure, browser-safe) has the format table, with `id`, `extensions`, `mime`, `kind`, `label` and `capabilities` (`editInPlace`, `alpha`, `saveAs`, `animated`). The ids are sharp's format names (`jpeg`, `png`, `webp`, `heif`), because the catalogues store those. It also has the helpers `isSupported`, `formatOf`, `formatById`, `extensionOf`, `acceptAttribute` and `SUPPORTED_EXTENSIONS`.
- `shared/server/mediaHandlers/{index,sharp,heic}.ts` has one handler per format, with `preview`, an optional `working` (which defaults to `preview`) and `image`, plus `handlerFor(file)` and `workingPath()`. `HandlerContext` holds the derived cache folder and a lazy `contentHash()`. The sharp handler works from the original. The heif handler wraps `shared/server/heic.ts` without changing it: it uses `sips` on macOS and libheif elsewhere, into `derived/<sha256>.jpg`. Its `image()` decodes in memory, as the shelf previews always did.
- `shared/server/media.ts`: `workingFile()` keeps its signature and result, and now goes through the handler. `contentHash` may also be a function, so callers no longer check for HEIC to decide whether to hash. `isSupported` and `SUPPORTED_EXTENSIONS` are re-exported from the registry.
- Replaced in Photo Tool:
  - the HEIC checks in `scanner.ts` and `app.ts` (`/full` via `workPathOf`, and `/image`);
  - `isHeic` and the `.jpg` / `.jpeg` / `.png` / `.webp` logic in `electron/editActions.ts`;
  - the save dialog filter in `electron/gallery.ts`;
  - the four HEIC checks in `web/store.ts` (`copyOnly` / `copyOnlyNote`, with the same text);
  - `editFormatFor` in `shared/core/photoEdit.ts`, which now uses `saveAs`.
  
  `walk.ts`, `scanner.refresh` and the editor's importer already called `isSupported`; it now comes from the registry.
- Replaced in the editor:
  - `PREVIEWABLE` and the HEIC regex in `server/shelf.ts`, which now uses `handlerFor` and `handler.image()`;
  - `ALPHA_FORMATS` in `server/app.ts`, which now uses `formatById(r.format)?.capabilities.alpha`;
  - the HEIC regex in the editor's `electron/selfTest.ts`.
  
  The in-page lists (`folders.ts`, `BrowserFolderPicker.tsx`) were deleted in Part A.

## Tests

- `shared/tests/media-formats.test.ts` has 12 tests:
  - the table reads exactly the six old extensions;
  - every extension belongs to exactly one format;
  - `isSupported` matches the old function on 32 odd names, including `._a.jpg`, `.jpg`, `a.`, `a.jpg.txt`, `C:\x\a.HEIC` and `dir.jpg/`;
  - `extensionOf` matches Node's `extname`;
  - HEIC detection matches the old checks;
  - the capabilities match the old special cases, including `ALPHA_FORMATS`;
  - `editFormatFor` matches the old function;
  - `acceptAttribute()` is checked;
  - there is exactly one handler per format;
  - every extension, in either case, maps to its format's handler;
  - there is no handler for unread files;
  - the sharp formats never hash the file.
- `shared/tests/media-formats-guard.test.ts` scans the code in `shared/`, `photo-tool/` and `photobook-editor/` (not `tests/` or `node_modules/`). It fails on an image-extension regex such as `/\.(jpe?g|png)$/i` or `/\.hei[cf]$/i`, on a lone extension string such as `'.heic'`, and on a bare-extension list such as `['jpg', 'jpeg']` outside the registry. Before the refactor it listed every site named in the issue, plus `gallery.ts` and the editor's self-test. Four lines are allowed, each with a reason: the OpenStreetMap tile URL regex, the thumbnail files' own types, and the editor's export choices in the dialog and in the self-test. Two more cases check that it catches each known form and leaves output file names alone.
- Existing tests pass unchanged, except the browser-mode tests removed or renamed in Part A.
- Results, at three points: the baseline on `5b992a4`; this work before the rebase; and after rebasing onto `issues-integration` (`3674fb9`, with #3 merged):
  - `npm run typecheck`: clean at all three.
  - `npx vitest run`: 78 files, 1136 passed, 5 skipped → 77 files, 1131 passed, 4 skipped → 78 files, 1168 passed, 4 skipped (#3 added tests). The one fewer skip is not a lost test: `photo-tool-shell`'s "built page loads nothing from the internet" is skipped until `dist/photo-tool/web` exists, and the Playwright runs built it.
  - Playwright, both projects, on ports 5810/5811: 43 passed, 1 skipped (perf) → the same → 48 passed, 1 skipped (#3 added 5). One full run after the rebase failed once in the editor's `draft-stars` (the import had shown no photos after 60 s). Its re-runs passed: the editor project alone (twice, with `--repeat-each=2`) and a second full run. I count it as load flakiness from the other agents' parallel runs; the editor import code is unchanged here.

## Checked by hand

- No app was launched by hand. The served pages were exercised by the Playwright runs above.

## Decisions I made

- **Dropped the "the browser can decode it" capability.** With the in-browser mode gone, no page decodes an original: the pages only show server-made thumbnails and `/full` JPEGs, and there is no image file input left. `acceptAttribute()` stays as a tested helper with no caller yet.
- **Format ids are sharp's format names** (`jpeg`, `png`, `webp`, `heif`), so stored `format` values (the scanner's `'heif'`, the editor's `ALPHA_FORMATS` lookup) map straight onto the table.
- **One handler per format id** (the sharp module makes the `jpeg`, `png` and `webp` handlers), which matches the issue's `id: string // matches mediaFormats`. Handlers gained `image(file)` (an upright in-memory sharp image), because the shelf previews decode HEIC in memory without the derived cache. Unifying that with `workingFile` would have changed behaviour.
- **The WebP label is `WEBP`**, so the save dialog keeps its exact text ("WEBP photo").
- **Deleted the demo inputs** (`web/public/`, `make-demo.ts`, the `demo-photos` script) along with the demo code, since only the in-browser mode used them.
- **Kept `pdfjs-dist` and `fake-indexeddb` in `package.json`**, though nothing imports them now. They are not packaged into the desktop app (the build bundles only its external list). Removing them changes `package-lock.json` and the notices, which is better done in its own small PR than here, where #4 also changes the lock.
- **The guard scans the programs' code only** (`shared/`, `photo-tool/`, `photobook-editor/`), not `scripts/`. Dev scripts pick files for their own reasons; for example, `scripts/tagging/measure.ts` measures JPEGs only.
- **File names are split on both slashes on every platform**, as Windows already did. On Linux, a file name containing a backslash is now split at it. This is a tiny change, and no real photo name has one.
- **Kept `photobook-editor/shared/`** (pdfWriter, textOutline, flipbookViewer) where it is. Only the server uses it now. Its comments say so; moving it would be churn.

## Not done

- Phases 2–6 of #6 (new formats, RAW, LibRaw, video, per-format scheduling).
- The `cost`, `sniff`, `metadata` and `probe` handler hooks, and a worker pool in `HandlerContext`. They come with the phases that need them; #5 extends `HandlerContext` for its `/full` cache and worker pool.
- Desktop CI self-tests were not run locally. The only desktop-side changes are the editor self-test's HEIC check and the Photo Tool save dialog filter, which builds the same filter as before.
- Two edges differ from the old code, and no code path reaches either, because a dot file is never catalogued as a photo. A file named exactly `.png` or `.webp` now gets `jpeg` from `editFormatFor`, where the old regex gave `png` / `webp`. And `shelfPreview` now refuses a file named exactly `.jpg`, which the old `PREVIEWABLE` regex accepted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
