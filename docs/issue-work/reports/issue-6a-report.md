# Report: #6 Phase 1 (6a) and removing the editor's in-browser mode

**Status:** done. Everything is local only: nothing was pushed, no PR was opened, `gh auth` was not touched.

**Where:**
- Worktree: `C:\Users\funvill\Documents\git\photobook_helper-media`, branch `media-registry`.
- Rebased onto local `issues-integration` at `3674fb9` (#3 merged).
- Version: took integration's 0.1.38 and bumped once to 0.1.39 in the final commit.

**Commits** (all by SWS-Chipkin, each with the Claude co-author line):
1. `4245a2c` refactor(editor): remove the in-browser mode; desktop only
2. `3fe1d87` feat(media): one format registry for both programs (#6 Phase 1)
3. `3dc700c` chore: version 0.1.39 on top of issues-integration (final)

PR text: `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\issue-6a-pr.md`

## Part A: the editor's in-browser mode is gone (Steven's decision)

**Deleted:**
- `photobook-editor/web/backend/browser/` (16 files)
- `web/components/BrowserFolderPicker.tsx` and `web/components/WebNotes.tsx`
- `web/demo/`, `web/public/` (the demo photos, `demo-welcome.js`, `overview/`), `scripts/make-demo.ts` and the `demo-photos` script

**Removed:**
- the `__BROWSER_BACKEND__` define and its declaration
- `Backend.kind` and `Backend.web`, with `WebExtras` / `StorageInfo`
- `LinkedFolder.needsAccess`, `ShelfListing.unsupported` / `needsAccess`, and `isBrowserBackend`
- `worker: {format:'es'}` from the editor's Vite config (no worker remains in the page)

**Kept:** the local-server branch in Home, Editor, ExportDialog, Library, Shelf, FolderPicker and main. Demo and web-only CSS were removed.

**Tests:**
- Deleted `browser-analysis`, `drop-web`, `web-demo` and `web-storage`.
- Cut the tea-poster case from `desktop-docs`.
- Renamed one `drop-result` case.
- Added a test to `shared/tests/no-upstream.test.ts`: the browser mode's files stay gone, and nothing names `__BROWSER_BACKEND__`, `isBrowserBackend` or `backend/browser`. It was watched failing first.

**Docs:**
- `ARCHITECTURE.md`: "A desktop program only".
- Editor README: a note that it is a desktop program.
- Comments in `pdf.ts`, `pdfWriter.ts`, `flipbookViewer.ts`, `placesLogic.ts` and `make-notices.ts`.

**Leftover sweep:** the remaining "web version" mentions are intentional: READMEs saying there is none, and the no-upstream / desktop-docs tests that assert it.

## Part B: the registry

**New `shared/core/mediaFormats.ts`** (pure):
- `MEDIA_FORMATS`: `jpeg` (.jpg/.jpeg), `png`, `webp`, `heif` (.heic/.heif).
- Ids are sharp's format names.
- `capabilities`: `editInPlace`, `alpha`, `saveAs`, `animated`.
- Helpers: `formatOf`, `formatById`, `isSupported` (adds the `._` rule), `extensionOf` (matches Node's `extname`), `acceptAttribute`, `SUPPORTED_EXTENSIONS`.

**New `shared/server/mediaHandlers/{index,sharp,heic}.ts`:**
- `MediaHandler` has `id`, `preview`, `working?` and `image`.
- `HandlerContext` has `derivedDir` and a lazy `contentHash()`.
- Also exports `handlerFor`, `workingPath` and `mediaHandlers`.
- A load-time check that every format has a handler.
- The heif handler moved the `sips` / libheif logic out of `media.ts`. `heic.ts` is unchanged.

**Call sites replaced:**
- `shared/server/media.ts`: `workingFile` goes through the handler, with the same signature and result, and the hash may be a function. `isSupported` / `SUPPORTED_EXTENSIONS` are re-exported. `ALPHA_FORMATS` was removed; its only caller now uses the capability.
- `shared/core/photoEdit.ts`: `editFormatFor` uses `saveAs`; `EditFormat = SaveFormat`.
- `photo-tool/server/scanner.ts` and `app.ts` (`workPathOf` for `/full`, and `/image`): no `isHeic`, lazy hash, and `format` is taken from the registry when a decoded copy was used.
- `photo-tool/electron/editActions.ts`: `copyOnly` uses `editInPlace === false`; the extension logic uses the registry; the error text is identical.
- `photo-tool/electron/gallery.ts`: the save dialog filter is built from the registry. The WebP label is `WEBP`, so the text is identical.
- `photo-tool/web/store.ts`: the four HEIC checks became `copyOnly` / `copyOnlyNote`, with the same texts. No other store lines were touched.
- `photobook-editor/server/shelf.ts`: `handlerFor` + `handler.image()`, still decoded in memory.
- `photobook-editor/server/app.ts`: the alpha capability.
- `photobook-editor/electron/selfTest.ts`: the HEIC check.
- `walk.ts`, `scanner.refresh` and the editor `importer.ts` already used `isSupported`, which now comes from the registry.

**Tests (TDD):**
- `shared/tests/media-formats-guard.test.ts` was written first. Its red list included every site named in the issue, plus `gallery.ts` and the editor's self-test. Four lines are allowed, each with a reason: the map-tile URL regex, the thumbnail file types, and the export format choices in two places. Two more cases check that it catches each known form and ignores output names.
- `shared/tests/media-formats.test.ts` (12 tests) characterizes the registry against the old functions on 32 odd names, using `win32` basename/extname so it runs the same on Linux CI. It also checks one handler per format, that every extension maps to its handler, and that sharp formats never hash.

## Test results

| | typecheck | vitest | Playwright (5810/5811) |
| --- | --- | --- | --- |
| Baseline `5b992a4` | clean | 78 files, 1136 passed, 5 skipped | 43 passed, 1 skipped |
| After Part A | clean | editor + no-upstream: 504 passed, 2 skipped | editor: 3 passed, 1 skipped |
| Before the rebase | clean | 77 files, 1131 passed, 4 skipped | 43 passed, 1 skipped |
| After the rebase (final) | clean | 78 files, 1168 passed, 4 skipped | 48 passed, 1 skipped |

- **The 5 → 4 skips:** `photo-tool-shell`'s built-page test runs once `dist/photo-tool/web` exists, which the e2e runs built. No test was lost.
- **One flaky failure:** one full Playwright run after the rebase failed once, in `draft-stars`, where the import showed no photos within 60 s. The editor project alone then passed twice (`--repeat-each=2`; the repeat's second `milestone` failure is expected, because the same data directory already holds the photos), and a second full run passed. I put it down to machine load. Nothing in the import path changed.
- All servers were stopped; nothing is listening on 5810/5811.

## Decisions

- Dropped the "the browser can decode it" capability: no page decodes an original any more. `acceptAttribute()` stays as a tested helper with no caller.
- One handler per format id. Added `image()` to the handler interface for the shelf's in-memory previews; it keeps them separate from the derived cache, as before.
- Format ids are sharp's format names, so stored `format` values map straight onto the table.
- The guard scans `shared/`, `photo-tool/` and `photobook-editor/`, not `scripts/` or `tests/`.
- Deleted the demo inputs. Kept `pdfjs-dist` and `fake-indexeddb` in `package.json` (now unused and not packaged), to avoid lock churn alongside #4; they suit a small clean-up PR.
- Kept `photobook-editor/shared/` in place; only its comments changed.

## Concerns and follow-ups

- **Not checked locally:** no desktop bundle was built and no desktop self-test was run. The desktop-side changes are only the editor self-test's HEIC check and Photo Tool's save dialog filter; both type-check and build the same values.
- **Tiny edges, none reachable:**
  - A file named exactly `.png` or `.webp` now gets `jpeg` from `editFormatFor`.
  - `shelfPreview` refuses a file named exactly `.jpg`.
  - On Linux, file names containing a backslash are split at it.
- **Next phases:** 6b (Phase 2) can now add formats as table entries plus handlers. The editor question in the plan ("the browser backend") is settled by its removal. #5 will extend `HandlerContext`.
- **Other agents' files:** the only one touched was `photo-tool/web/store.ts`, in the HEIC lines only. It merged cleanly with #3's store changes.
