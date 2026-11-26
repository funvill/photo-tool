# Plan: implementing every open issue on funvill/photo-tool

Issues: #2, #3, #4, #5, #6, #7, #9, #10, #11. Repo: `C:\Users\funvill\Documents\git\photobook_helper`, `main` at `4bad967` (the merged program split).
Every file named below was checked against `main` at 4bad967. Line numbers quoted in the issues were written against `split-programs`; re-check them.

## 0. Ground rules for every implementer

- **Base:** branch from `main` at the start of the wave, not from `split-programs` (several issue plans still say `split-programs`). One worktree, one branch and one PR into `main` per PR listed below.
- **Attribution:** `git -c user.name="SWS-Chipkin" -c user.email="sws-dev@chipkin.com" commit ...`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies are not hard-wrapped and end with the Claude Code line.
- **Data:** tests and manual checks use temp folders through `PHOTO_TOOL_*`, `PHOTOBOOK_*` and `PHOTOINFO_FALLBACK_DIR`. Never `photos/`, `data/`, `trial-output/` or the real `%APPDATA%`.
- **Version bump rule (applies to every pair of PRs).** Each issue says to run `npm version patch --no-git-tag-version` before each commit, so every PR changes `package.json` and `package-lock.json` and every pair of PRs conflicts there. The rule:
  - bump as the plans say while working;
  - before merging, rebase on `main`, take `main`'s `version` in both files, and bump once more in a final commit;
  - re-run `npm install --package-lock-only` only when the PR adds a dependency (#4 does).
  This pair of files is left out of the conflict matrix below.
- **Existing branches and worktrees, all read-only checks:**
  - `filter-panel` (#3): local and pushed, with a worktree at `../photobook_helper-filters`. It is one docs commit, `f41d73a` (the design and plan, plus a version bump). It is cut from `16c1b08`, a pre-merge `split-programs` commit, and is 9 commits behind `main`. It has no code. Reuse it by rebasing onto `main`; only the version bump conflicts.
  - `update-check` (#4): local only, with a worktree at `../photobook_helper-updates`. It holds 4 docs commits (the design and plan, F1 and F2 notes), also cut from `16c1b08`. Same treatment: rebase onto `main`, or cherry-pick the docs.
  - There are no open PRs. A detached worktree, `.claude/worktrees/bold-mendel-0d144a`, is already merged into `main` and can be ignored.
- **Stale notes in the issues:**
  - #4 Task 1 says the two shell test files "have uncommitted edits in the main checkout from another session". That no longer applies; `main` is clean.
  - #4 Task 5 implies `hostResolverRules` sits in `config.ts`. It lives in `shared/electron/netGuard.ts`.
  - The line numbers in #4, #5 and #6 were written against `split-programs`.
- **E2E file rule.** `photo-tool/tests/e2e/gallery.spec.ts` (1,206 lines, 41 top-level `test(...)` calls) is touched by #2, #3, #5, #6, #9 and #10.
  - Add new tests in your own `test.describe('<issue> …')` block at the end of the file, so additions merge cleanly.
  - Only #3 (two existing tests, which now open the Filters panel first) and #10 (the view switch) rewrite existing tests. That counts as a real conflict, and the matrix marks it.
- **Vitest:** `vitest.config.ts` includes `tests/**`, `shared/tests/**`, `photo-tool/tests/**` and `photobook-editor/tests/**`. Every new test path in the plans is covered (`tests/release-assets.test.ts`, `shared/tests/server-host.test.ts`, and so on).

---

## 1. Per issue

### #11 Desktop apps forget page settings on every restart (port changes each start)
- **Build:** the shared shell remembers the local server's last port in `<profileDir>/server-port.json` and asks for it again on the next start.
  - If that port is busy (`EADDRINUSE`) or refused (`EACCES`), it falls back to any free port.
  - The window still loads only from the port in the server's `ready` reply.
  - Development and self-tests keep today's ports.
  - This fixes lost `localStorage` (thumbnail size, panel widths, sections, the editor's last folder, Shelf) in both programs at once.
- **Size:** S.
- **Files:**
  - `shared/electron/serverHost.ts` (`StartMessage.fallbackToAny`, new `listenWithFallback`);
  - `shared/electron/config.ts` (`parseSavedPort`, `serverPortRequest`);
  - `shared/electron/runDesktopApp.ts` (`startServer`, which sends `port: devUrl ? … : 0` around line 281; the `ready` handling around line 587; saving beside `window-state.json` around line 355);
  - tests: `shared/tests/server-host.test.ts` (new), `shared/tests/desktop-config.test.ts`, `shared/tests/desktop-shell.test.ts`;
  - `docs/electron-plan.md`.
- **Design:** settled. No user questions.

### #2 Regenerate button for the auto-written description ("What's in it")
- **Build:** a **Regenerate** button under the description in `WhatsInIt.tsx`.
  - The Florence-2 caption is run again with sampling (`do_sample`, `temperature 0.7`, `top_k 50`) through the tagging worker's one-at-a-time chain. This also works while tagging is paused.
  - It replaces only the description in the catalogue's `tags` row; objects and keywords are kept.
  - Busy state; on failure, an error toast and the old text stays.
- **Size:** M.
- **Files:**
  - `photo-tool/server/tagging/worker.ts` (`op: 'caption'`, `sample`);
  - `photo-tool/server/tagging/backend.ts` (`caption()`);
  - `photo-tool/server/tagging/queue.ts` (`regenerate`);
  - `photo-tool/server/catalog.ts` (maybe `setDescription`);
  - `photo-tool/server/app.ts` (`POST /api/gallery/tagging/regenerate`);
  - `photo-tool/web/api.ts`, `photo-tool/web/store.ts` (one action), `photo-tool/web/components/WhatsInIt.tsx`;
  - tests: `photo-tool/tests/support/fakeTagging.ts`, `gallery-tagging-queue.test.ts`, `gallery-catalog.test.ts`, `gallery-tagging-app.test.ts`, `gallery-tags-store.test.ts`, the e2e spec.
- **Design:** settled. No user questions.

### #3 Filter panel, chips, query words, "Showing X of Y · Clear filter"
- **Build:**
  - **Bar:** Sort, Stack similar and search stay out in the open; a **Filters · N** button opens a grouped popover (Photo, When, Where, Content, Quality).
  - **Filtered row:** one removable chip per active filter, then "Showing X of Y" and **Clear filter**.
  - **Query words:** `key:value` words in the search box (`star:yes`, `shape:portrait`, `from:`, `has:people`, `tag:lake` …) become chips.
  - **One list:** a single list of filters in `photo-tool/core` drives the panel, chips, query words and `isFilterActive`.
- **Size:** L.
- **Files:**
  - new `photo-tool/core/galleryFilters.ts` and `photo-tool/core/galleryQuery.ts`;
  - `photo-tool/core/gallerySort.ts` (`isFilterActive` at line 41 delegates to the list);
  - `photo-tool/web/components/FilterBar.tsx` (`countText`, the bar);
  - new `photo-tool/web/components/FilterPanel.tsx` and `photo-tool/web/components/FilteredRow.tsx`;
  - `photo-tool/web/gallery.css`;
  - tests: `photo-tool/tests/gallery-filters.test.ts` (new), `photo-tool/tests/gallery-query.test.ts` (new), `photo-tool/tests/gallery-sort.test.ts`, the e2e spec (two existing tests change).
  - The plan forbids touching `store.ts`, `Details.tsx` and `WhatsInIt.tsx`.
- **Design:** settled. The design and plan docs are on `filter-panel` (see section 0). No user questions.

### #4 Check for updates, F1 About, F2 feedback on GitHub (both programs)
- **Build:** electron-updater in both programs.
  - **When:** a quiet daily check at start (packaged builds only, never in self-tests, can be turned off), plus Help › Check for updates….
  - **Flow:** Download / Release notes / Later, a progress bar, then a safe Restart now that keeps unsaved work.
  - **F1:** About, with version details and a Check for updates button.
  - **F2:** opens the repo's new-issue page with the program, version and platform filled in.
  - **Releases:** each program has its own update channel; CI puts each `v*` tag's installers in a draft release.
- **Size:** XL.
- **Files:**
  - `package.json` and lockfile (new runtime dependency `electron-updater`);
  - `photo-tool/electron-builder.config.cjs` and `photobook-editor/electron-builder.config.cjs` (`publish`);
  - maybe `scripts/desktop/build.mjs`;
  - new `shared/electron/updateRules.ts` and `shared/electron/updates.ts`;
  - `shared/electron/runDesktopApp.ts`: the Help submenu at line 471, `main()` after `loadURL`, `window-all-closed`, `before-quit`, the header comment;
  - `shared/electron/config.ts` (`describeAbout`, `feedbackUrl`);
  - `shared/electron/netGuard.ts` (`hostResolverRules` is used from here, not changed);
  - `photo-tool/electron/main.ts`, `photo-tool/electron/mapTiles.ts`, `photobook-editor/electron/main.ts`;
  - `photo-tool/product.json`, `photobook-editor/product.json`;
  - `.github/workflows/desktop.yml` (new `release` job, `*.yml` artifacts);
  - new `scripts/release/collect-assets.mjs`;
  - tests: `shared/tests/update-rules.test.ts` (new), `shared/tests/updates.test.ts` (new), `tests/release-assets.test.ts` (new), `shared/tests/desktop-shell.test.ts`, `shared/tests/desktop-config.test.ts`, `photo-tool/tests/photo-tool-shell.test.ts`, `photobook-editor/tests/editor-shell.test.ts`;
  - `README.md`, `docs/electron-plan.md`.
- **Design:** settled ("Design (agreed)"). No user questions.
  - Re-check the electron-updater and electron-builder versions, and confirm that electron-updater uses its own session, not `defaultSession` (Task 4 Step 4).

### #5 Fast gallery navigation (preload 20 ahead / 5 back) and 10,000+ photo albums
- **Build:**
  - **Phase 1:** a pure `preloadOrder` and one shared, decoded, LRU-bounded image cache. The viewer and the preview pane step from memory with no blank flash, and the grid warms the cache.
  - **Phase 2:** a faster server: the thumbnail route serves straight from disk, missing thumbnails are made on demand, `/full` gets a disk cache, and parallel requests are checked against the connection limit.
  - **Phase 3:** large albums: scan what is on screen first, batched catalogue writes, decoding off the main thread, a slim and incremental `/items`, cheaper selectors, and a grid overscan and tile-size fix.
  - Every phase is measured before and after with a synthetic-album harness.
- **Size:** XL.
- **Files:**
  - **Phase 1:** new `photo-tool/core/preloadWindow.ts` (replaces `viewerNeighbours` in `photo-tool/core/galleryViewer.ts:34`); new `photo-tool/web/imageCache.ts`; `photo-tool/web/components/Viewer.tsx`, `Preview.tsx`, `Grid.tsx`; tests `gallery-viewer.test.ts` and new tests; the e2e spec.
  - **Phase 2:** `photo-tool/server/app.ts` (thumbnail route, `/full`), `shared/server/media.ts`, maybe `photo-tool/electron/main.ts` (a custom protocol), `gallery-server.test.ts`.
    - After #6 Phase 1 merges, `workingFile()` and the HEIC cache sit behind `shared/server/mediaHandlers/` (`HandlerContext`). So step 7 (the `/full` cache, no HEIC re-hash) and step 11 (the worker pool) edit the handlers too. That is why #6 Phase 4 waits until after #5 (wave 6).
  - **Phase 3:**
    - server: `photo-tool/server/scanner.ts`, `photo-tool/server/walk.ts`, `photo-tool/server/catalog.ts`, `photo-tool/server/app.ts` (`/items`);
    - page: `photo-tool/web/store.ts` (selectors, `selectVisible` at line 1330, polling), `photo-tool/web/api.ts`, `photo-tool/core/gallerySort.ts`, `photo-tool/web/components/Details.tsx`, `WhatsInIt.tsx`, `Tile.tsx`, `Grid.tsx`, `photo-tool/web/virtualGrid.ts`;
    - a new perf script under `scripts/`.
- **Design:** Phases 1–2 are settled. The issue's "Risks and open questions" are mostly engineering ones, to settle by measuring:
  > "Memory: 25 decoded 1600 px images is about 250 MB of decoded pixels. The cache cap may need to adapt to the screen size, or `ImageBitmap`s should be closed on eviction."
  > "Edited photos (`EditedImage`) render differently and need their own preload path, or a cached rendered thumbnail."
- **One real design question for Phase 3 (found while checking the code; the user should answer):**
  - Step 12 says "Return a lean list (path, key, size, date, star, hidden, score inputs) and fetch `exif`, `analysis` and `tags` per photo when the details panel opens."
  - The lean list keeps the score inputs, but the grid's filters and search also need those fields for every photo:
    - `photo-tool/core/gallerySort.ts` reads `i.analysis` (line 186, the Low quality filter), `i.tags` (lines 203 and 231, keyword and object filters, text search) and `i.info` (lines 228 and 232, search over the photo's own text);
    - #3's chips and query words (`tag:`, `object:`, `is:lowquality`) filter on the same fields.
  - So the lean list must also carry the filter and search inputs (for example a compact form of the tags, the info text and the low-quality flag), or filtering and search move to the server.

### #6 Media format plug-ins: every image format, camera RAW, and video
- **Build:**
  - **Registry:** a browser-safe format table (`shared/core/mediaFormats.ts`) plus one server handler per format (`shared/server/mediaHandlers/`). It replaces every scattered extension list and HEIC special case in both programs.
  - **Then, phase by phase:**
    - Phase 2: the formats sharp already decodes (AVIF, TIFF, GIF, SVG, and maybe BMP and ICO);
    - Phase 3: RAW embedded previews, RAW+JPEG stacking, skipping `.xmp`;
    - Phase 4: a full RAW decode with LibRaw (after a spike);
    - Phase 5: video, with a poster frame, playback through a Range-capable `/media` route and a duration badge (after a spike);
    - Phase 6: per-format scheduling.
- **Size:** XL.
- **Files:**
  - **Phase 1:**
    - new `shared/core/mediaFormats.ts` and `shared/server/mediaHandlers/{index,sharp,heic}.ts`;
    - `shared/server/media.ts` (`SUPPORTED_EXTENSIONS`, `workingFile`), `shared/server/heic.ts`, `shared/core/photoEdit.ts` (one HEIC check);
    - `photo-tool/server/walk.ts`, `photo-tool/server/scanner.ts`, `photo-tool/server/app.ts`, `photo-tool/electron/editActions.ts`, `photo-tool/web/store.ts` (four HEIC checks);
    - `photobook-editor/server/shelf.ts`, `photobook-editor/server/importer.ts`, `photobook-editor/server/app.ts`, `photobook-editor/web/backend/browser/folders.ts`, `photobook-editor/web/components/BrowserFolderPicker.tsx`;
    - a new guard test beside `tests/import-graph.test.ts` / `shared/tests/boundaries.test.ts`.
  - **Phase 2:** `scripts/make-fixtures.ts`, the handlers, maybe `photo-tool/electron/selfTest.ts`.
  - **Phase 3:** a `raw` handler, `photo-tool/core/galleryStacks.ts`, `photo-tool/server/walk.ts`, fixtures.
  - **Phase 4:** the handler, `photo-tool/electron/selfTest.ts`, `scripts/desktop/build.mjs`, the builder configs, `.github/workflows/desktop.yml`.
  - **Phase 5:** `photo-tool/server/app.ts` (the `/media` route), `Viewer.tsx`, `Tile.tsx` / `Grid.tsx`, packaging (`extraResources`).
- **Design:** Phase 1 is settled. The issue's "Open questions" block Phases 4–5, and the fourth one is needed **before Phase 2 (wave 3)**:
  - The editor's browser backend lists only `jpe?g|png|heic|heif|webp` (`photobook-editor/web/backend/browser/folders.ts:14`, `BrowserFolderPicker.tsx:7`).
  - It decodes in the page, and already says "HEIC photos open in Safari only".
  - Chromium's `createImageBitmap` can't decode TIFF or RAW, while the issue's "Done when" asks for Phases 1–3 "in both programs".
  - So Phase 1 should give the registry a "the browser can decode it" capability and keep the in-page list unchanged. Phases 2–3 need the user's answer on the browser backend.

  The four questions, quoted:
  > "**LibRaw:** WebAssembly or native (Phase 4 spike)?"
  > "**Video tools:** ffmpeg binary or Chromium-only (Phase 5 spike)? Licence and installer size matter here (a static ffmpeg adds about 70–80 MB)."
  > "**Photobook Editor and video:** should the editor show videos on its shelf, or images only?"
  > "**The editor's browser-only backend:** it decodes in the page with `createImageBitmap`, so RAW and HEIC there would need the WebAssembly decoders in the browser. Is that in scope?"
  - Phase 3 also needs a decision on RAW fixtures: download them with pinned checksums, or check in up to 30 MB.

### #7 Speed up the build and test loop
- **Build:**
  - **Measure first:** per-file vitest times, e2e, and `dist:dir:*` / `dist:*`.
  - **Then:**
    - split the slow unit tests into a `test:slow` project that CI still runs;
    - make `dist:dir:*` the everyday packaged check;
    - cache npm, Playwright browsers and electron-builder in CI;
    - consider sharding Playwright and lowering NSIS compression for non-release builds;
    - stop rebuilding the installer just for the version bump.
  - Document a fast everyday loop and a full loop, with before and after numbers.
- **Size:** M.
- **Files:**
  - `vitest.config.ts` (projects), `playwright.config.ts`, `package.json` scripts;
  - `.github/workflows/test.yml`, `.github/workflows/desktop.yml` (caches, the slow project);
  - `photo-tool/electron-builder.config.cjs`, `photobook-editor/electron-builder.config.cjs` (compression);
  - the slow tests: `photo-tool/tests/gallery-tagging-queue.test.ts` ("a big folder…"), `photo-tool/tests/tagging-worker-ping.test.ts`, the "builds its own page" test, `tests/import-graph.test.ts`, `shared/tests/boundaries.test.ts`;
  - docs (README, or a short doc under `docs/`).
- **Design:** the goal is settled. Which ideas to adopt depends on the measurements, not on the user. No user questions.

### #9 Delete key, rotate/flip, light and colour, before/after, Ctrl+A/D, Ctrl+C, `?` overlay
- **Build:** seven gallery and editor features:
  - **Delete** sends the selected photos to the Recycle Bin;
  - **`[` / `]`** rotate and **Flip** without edit mode;
  - **Light and colour:** four sliders plus **Auto**, stored as one colour matrix, drawn on the page with an SVG `feColorMatrix` and by sharp `recomb`/`linear` on save, so the saved photo matches the preview;
  - **Hold `\`** to see the original;
  - **Ctrl+A / Ctrl+D** select all / none;
  - **Ctrl+C** copies one picture or several files;
  - **`?`** opens a shortcut overlay driven by one key table.
- **Size:** XL.
- **Files:**
  - Model and server: `shared/core/photoEdit.ts`, new `shared/core/colorAdjust.ts`, `shared/server/photoEditRender.ts`, `photo-tool/server/app.ts` (`/api/gallery/auto-adjust`).
  - Page: `photo-tool/web/store.ts`, `photo-tool/web/useReviewKeys.ts`, `PhotoMenu.tsx`, `EditPane.tsx`, `EditedImage.tsx`, `Tile.tsx`, `Preview.tsx`, `MiniMap.tsx`, `Viewer.tsx`, `photo-tool/web/GalleryApp.tsx`.
  - Copy: `photo-tool/electron/gallery.ts` (`gallery:copy-files`), `photo-tool/electron/fileActions.ts`, `photo-tool/electron/preload.ts`, `shared/desktop/desktopApi.ts`.
  - Overlay: new `photo-tool/web/shortcuts.ts`, new `shared/web/components/ShortcutOverlay.tsx`.
  - The Help menu item: `shared/electron/runDesktopApp.ts`. Today's `DesktopProgram` has only a `fileMenu` hook, so a program Help item needs a shell change.
  - Tests: `shared/tests/photo-edit.test.ts`, `shared/tests/photo-edit-render.test.ts`, `shared/tests/color-adjust.test.ts` (new), `photo-tool/tests/gallery-store.test.ts`, `photo-tool/tests/shortcuts.test.ts` (new), `photo-tool/tests/copy-files.test.ts` (new), `photo-tool/tests/photo-tool-shell.test.ts`, the e2e spec, `README.md`.
- **Design:** proposed, not confirmed. The issue says:
  > "## Decisions (proposed; change them before building if wrong)"
  - That table covers Delete, the keys `[ ] \ ?`, Ctrl+A/D/C, slider ranges and Auto. The user should confirm it.
  - The Ctrl+C multi-file mechanism is left to a spike: "Only Ctrl+C for several files is left to a spike, because the clipboard mechanism differs by OS and cannot be settled without trying it."
  - The overlay lists "F1 and F2 when those exist (see #4)".

### #10 Timeline view, reopen where I was, What's new after an update
- **Build:** three features.
  - **Timeline:** a third view, Grid | Timeline | Map.
    - Grouping is by day or by month, using the written `YYYY-MM-DD` of `effectiveDate`.
    - Sticky headings; clicking a heading selects that group.
    - A month rail; virtualised.
  - **Reopen where I was:**
    - a `ui_state` table in the catalogue, behind `GET/PUT /api/gallery/state`;
    - at start, reopens the last folder, photo, view and scroll;
    - a Settings checkbox turns it off.
  - **What's new:**
    - per-program `whats-new.json` files, a pure `notesToShow`;
    - a native dialog on the first start after an update;
    - Help › What's new.
- **Size:** XL.
- **Files:**
  - **Timeline:** new `photo-tool/core/timeline.ts`, new `photo-tool/web/components/Timeline.tsx`, `photo-tool/web/store.ts` (`view` union at lines 73 and 142, `timelineUnit`, `selectGroup`), `photo-tool/web/GalleryApp.tsx`, `photo-tool/web/components/FilterBar.tsx` (Sort greyed out), `photo-tool/web/useReviewKeys.ts`, `photo-tool/web/gallery.css`; tests `photo-tool/tests/gallery-timeline.test.ts` (new), `gallery-store.test.ts`, the e2e spec.
  - **Reopen:** `photo-tool/server/catalog.ts` (the `ui_state` table), `photo-tool/server/app.ts` (`/api/gallery/state`, `exists` on `/recent`), `photo-tool/web/api.ts`, `photo-tool/web/store.ts` (`restoreSession`, `thumbSize` at lines 251–283), `Splitter.tsx`, `Section.tsx`, `SettingsDialog.tsx`, `GalleryApp.tsx`; tests `gallery-catalog.test.ts`, `gallery-server.test.ts`, `gallery-store.test.ts`, the e2e spec.
  - **What's new:** new `shared/electron/whatsNew.ts`; new `photo-tool/whats-new.json` and `photobook-editor/whats-new.json`; `shared/electron/runDesktopApp.ts` (`DesktopProgram.whatsNew`, a check after the window shows, a Help item); `photo-tool/electron/main.ts`, `photobook-editor/electron/main.ts`; tests `shared/tests/whats-new.test.ts` (new), `desktop-shell.test.ts`, `photo-tool-shell.test.ts`, `editor-shell.test.ts`.
  - **Docs:** `README.md`.
- **Design:** proposed, not confirmed. The issue says:
  > "## Decisions (proposed; change them before building if wrong)"
  - Those decisions cover the Grid | Timeline | Map switch, the Day/Month default (90 days), heading text, oldest-first order with Sort greyed out, the "No date" group, click-to-select a group, the month rail, reopen on by default, and What's new as a native dialog.
- **A second question, raised by #11:**
  > "with this fixed, #10's 'Remember where I was' can keep small UI settings in `localStorage` … The `localStorage` migration step in #10 Task 4 becomes optional."
  - Once #11 merges, should `thumbSize`, the panel widths and the open sections still move to the server-side store (the plan's Global constraint: "Nothing new goes in `localStorage`"), or stay in `localStorage`?
  - Either way, `last` (folder, photo, view, scroll) goes in the server-side store.

---

## 2. Dependencies

| From → to | Kind | Why |
|---|---|---|
| #10 Reopen → #11 | **Soft (do #11 first)** | Not required: `last` lives in the server-side store either way. With #11 merged, `localStorage` survives restarts, so moving `thumbSize` / `Splitter` / `Section` to the server becomes optional (a user question). Doing #11 first shrinks #10's PR. |
| #10 What's new → #4 | **No code dependency, but must be serial** | `notesToShow` needs nothing from #4. Both add a hook after the window shows and a Help submenu item in `runDesktopApp.ts`, and #10 says the What's new check runs "before #4's update check if that exists, so two dialogs never open at once". Merge #4's shell PR first; #10's What's new PR then orders its check before `updates.checkAtStart`. Both add a "Releasing" note to the docs. |
| #9 overlay → #4 | Soft | The overlay lists F1 and F2 "when those exist". With #4 merged first, they go into the key table at once. |
| #9 Help › Keyboard shortcuts → #4, and before #10 What's new | **Serial (same lines)** | The Help submenu line (`runDesktopApp.ts:471`) is edited by #4 (update items, F2, F1), #9 (Keyboard shortcuts) and #10 (What's new). Three PRs on one line: run them one after another. |
| #10 Timeline → #3 | **Serial (same file)** | Timeline greys out Sort in `FilterBar.tsx`, which #3 rewrites. Build Timeline on top of #3. |
| #10 Timeline ↔ #9 | Serial (store, keys) | Both edit `store.ts`, `useReviewKeys.ts` and `GalleryApp.tsx`. If #9 merges first, Timeline adds its keys (Home/End in timeline order) to #9's `shortcuts.ts` table, and the "every handled key has an entry" test enforces it. |
| #9 colour → #6 Phase 1 | Serial (same file) | Both edit `shared/core/photoEdit.ts`. #6 changes one HEIC check; #9 adds `flip` and `adjust` to the model. |
| #5 Phase 3 → #3, #10, #2 | **Phase 3 must go last** | Slimming `/items` changes which fields every item has; #3's filters, #2's tags patch and #10's timeline all read items (see the #5 open question). |
| #6 Phase 6 ↔ #5 Phase 3 | Overlap in intent | Both move scanning to a worker pool and schedule by cost (`scanner.ts`). Do #5 Phase 3 step 11 first; #6 Phase 6 then adds per-handler `cost`. |
| #6 Phase 5 (video) → #5 Phases 1–2 | Serial (same files) | Video changes `Viewer.tsx`, `Tile.tsx` / `Grid.tsx` and adds a `/media` route to `app.ts`. |
| #7 ↔ #4 | Serial (same files) | `.github/workflows/desktop.yml` (#4 Task 8 adds a `release` job; #7 adds caches) and both electron-builder configs (#4 adds `publish`; #7 may change compression). |
| #7 ↔ #2 | Serial (same file) | #7 may move or tag "a big folder…" in `gallery-tagging-queue.test.ts`, which #2 adds tests to. |
| #2 ↔ #10 Reopen ↔ #5 Phase 2 | Serial (same files) | Each adds routes in `photo-tool/server/app.ts`; #2 and #10 also touch `catalog.ts` and `api.ts`. |

No issue blocks another in a way that stops work outright. All the ordering comes from shared files, plus #5 Phase 3's data-model change.

---

## 3. Conflict matrix

Each cell lists the files both issues edit (or the same part of a file). A dash means none.
`package.json` and the lockfile are left out (see the version bump rule).
`gallery.spec.ts` counts only where both issues rewrite existing tests; append-only blocks are fine.

**Short names used in the cells:**

| Short name | File |
|---|---|
| store | `photo-tool/web/store.ts` |
| keys | `photo-tool/web/useReviewKeys.ts` |
| App | `photo-tool/web/GalleryApp.tsx` |
| app.ts | `photo-tool/server/app.ts` |
| catalog | `photo-tool/server/catalog.ts` |
| api | `photo-tool/web/api.ts` |
| shell | `shared/electron/runDesktopApp.ts` |
| Help | the Help submenu line in `runDesktopApp.ts` |
| config | `shared/electron/config.ts` |
| shell tests | `shared/tests/desktop-shell.test.ts` / `desktop-config.test.ts` |
| prog tests | `photo-tool/tests/photo-tool-shell.test.ts` / `photobook-editor/tests/editor-shell.test.ts` |
| mains | `photo-tool/electron/main.ts` / `photobook-editor/electron/main.ts` |
| yml | `.github/workflows/desktop.yml` |
| builder | the two `electron-builder.config.cjs` files |
| css | `photo-tool/web/gallery.css` |
| photoEdit | `shared/core/photoEdit.ts` |
| media | `shared/server/media.ts` |
| scanner | `photo-tool/server/scanner.ts` |

|     | #2 | #3 | #4 | #5 | #6 | #7 | #9 | #10 | #11 |
|-----|----|----|----|----|----|----|----|-----|-----|
| **#2** | | css (maybe) | – | P2/P3: app.ts; P3: store, catalog, api, WhatsInIt | P1: app.ts, store | `gallery-tagging-queue.test.ts` | store, app.ts | Reopen: app.ts, catalog, api, store | – |
| **#3** | css (maybe) | | – | P3: `gallerySort.ts` | – | – | css | Timeline: `FilterBar.tsx`, css, e2e (rewrites) | – |
| **#4** | – | – | | P2 (only if custom protocol): `photo-tool/electron/main.ts` | P4: yml, builder | **yml, builder** | Help, shell, shell tests, `photo-tool-shell.test.ts` | What's new: **shell, Help, mains, shell tests, prog tests**, README | **shell, config, shell tests**, `docs/electron-plan.md` |
| **#5** | see #2 | see #3 | see #4 | | #6 P1: `app.ts`, `media.ts`, `scanner.ts`; #5 P2/P3 ∩ #6 P1/P4: `shared/server/mediaHandlers/` (`/full` cache, HEIC, worker pool); P3: `walk.ts`; #6 P5: Viewer, Grid/Tile, app.ts; #6 P6: scanner | – | P1: `Preview.tsx`, `Viewer.tsx`; P2/P3: app.ts; P3: store, `Tile.tsx` | Timeline: `Grid.tsx` patterns / `virtualGrid.ts`; P3: store, app.ts, catalog | – |
| **#6** | see #2 | – | see #4 | see #5 | | P4: yml, builder | P1: photoEdit, store, app.ts; P5: Viewer | P1: store; P5: Viewer | – |
| **#7** | see #2 | – | see #4 | – | see #6 | | – | – | – |
| **#9** | see #2 | see #3 | see #4 | see #5 | see #6 | – | | **store, keys, App**, css, Help, README | shell (9d's Help item) |
| **#10** | see #2 | see #3 | see #4 | see #5 | see #6 | – | see #9 | | **shell** (What's new), shell tests |
| **#11** | – | – | see #4 | – | – | – | see #9 | see #10 | |

**Hot spots, by file:**

| File | Issues that edit it |
|---|---|
| `photo-tool/web/store.ts` | #2 (small), #5 P3, #6 P1, #9, #10 |
| `photo-tool/server/app.ts` | #2, #5 P2/P3, #6 P1/P5, #9 (auto-adjust), #10 (state) |
| `shared/electron/runDesktopApp.ts` | #4, #9 (Help item), #10 (What's new), #11 |
| `photo-tool/web/useReviewKeys.ts` / `PhotoMenu.tsx` | #9, #10 Timeline |
| `photo-tool/web/components/FilterBar.tsx` | #3, #10 Timeline |
| `Preview.tsx` / `Viewer.tsx` / `Grid.tsx` / `Tile.tsx` | #5, #9, #6 P5 |
| `photo-tool/web/components/Details.tsx` | only #5 P3 (#3 is told not to touch it) |
| `.github/workflows/desktop.yml` + builder configs | #4, #7, #6 P4 |
| `README.md` / `docs/electron-plan.md` | #4, #9, #10, #11, #7 (docs sections; a merge, not a design conflict) |

---

## 4. Waves

At most 3 issues have a PR open in any wave. Each wave starts from `main` after the previous wave's PRs have merged. An XL issue is cut into several PRs (4a, 4b …); within one issue, its PRs are stacked and merged in order by the same implementer.

### Wave 1: three PRs, no shared files
| Issue | PRs | Why now |
|---|---|---|
| **#11** (S) | 1 PR | A user-facing bug in both programs. Clears `runDesktopApp.ts` before #4. |
| **#3** (L) | 1 PR (rebase `filter-panel`) | Photo Tool page only: `FilterBar.tsx`, new core files, css. Must land before #10 Timeline. |
| **#2** (M) | 1 PR | Tagging server, catalogue, one store action, `WhatsInIt.tsx`. No overlap with #3 or #11. |

Checks: #2 ∩ #3 is at most `gallery.css` (#2 reuses existing classes); both add e2e blocks only at the end. #11 touches only `shared/electron`.

### Wave 2
| Issue | PRs | Files |
|---|---|---|
| **#4** (XL) | 4a: Tasks 2–3 (pure rules and controller, new files only). 4b: Tasks 1, 4, 5 (dependency, builder publish, shell hooks, both programs opt in). 4c: Tasks 6–7 (F1 About, F2 feedback). 4d: Tasks 8–9 (CI draft release, docs). Task 10 is a manual check, noted in 4d. | shared/electron, mains, builder configs, yml |
| **#5 Phase 1** (part of XL) | 5a: `preloadOrder` + `imageCache` + Viewer/Preview/grid warming | `photo-tool/core`, `photo-tool/web` viewer, preview and grid; no server or store |
| **#6 Phase 1** (part of XL) | 6a: registry, no change in behaviour | shared media, scanner, walk, app.ts HEIC lines, editActions, store HEIC lines, editor server and browser lists |

Checks:
- #4 ∩ #5a: none.
- #4 ∩ #6a: none (#6 touches `editActions.ts`, not `main.ts`).
- #5a ∩ #6a: none (#5 Phase 1 is page-only; #6 Phase 1 touches only the store's HEIC checks, which #5a doesn't edit).

### Wave 3
| Issue | PRs | Files |
|---|---|---|
| **#9** (XL) | 9a: Tasks 1 and 5 (Ctrl+A/D, Delete). 9b: Tasks 2–4 (flip, colour model, colour on screen, saved and in the editor). 9c: Task 6 (spike, then Ctrl+C). 9d: Tasks 7–9 (before/after, `?` overlay including the Help › Keyboard shortcuts shell item after #4, docs). | store, keys, PhotoMenu, EditPane, Preview, Viewer, photoEdit, photoEditRender, app.ts (auto-adjust), electron gallery/preload, Help line |
| **#7** (M) | 7a: measurements plus the vitest `test:slow` split and scripts. 7b: CI caching and builder compression (after #4's `desktop.yml` is merged). | vitest/playwright config, scripts, CI yml, builder configs, slow test files |
| **#6 Phase 2** (part of XL) | 6b: AVIF/TIFF/GIF/SVG (+BMP/ICO) handlers and fixtures | `shared/server/mediaHandlers/*`, `shared/core/mediaFormats.ts`, `scripts/make-fixtures.ts` |

Checks:
- #9 ∩ #7: none (#7 doesn't touch the store or the edit files).
- #9 ∩ #6b: none (Phase 2 adds handlers and fixtures only; `photoEdit.ts` was settled in wave 2).
- #7 ∩ #6b: none.
- #7's "builds its own page" test is in `shared/tests/boundaries.test.ts`, which #6 Phase 1 (wave 2) sits beside. 7a should tag slow tests in place rather than move them, so the guard test 6a added doesn't conflict.
- #7 could move to wave 1 to speed every later loop, at the cost of a wave-1 slot; #7b has to wait for #4's `desktop.yml` anyway. Whether to swap #7 with #2 in wave 1 is the user's call.
- 6b (Phase 2) needs the user's answer on the editor's browser backend before it starts.

### Wave 4
| Issue | PRs | Files |
|---|---|---|
| **#10** (XL) | 10a: Tasks 1–2 (Timeline). 10b: Tasks 3–4 (`ui_state` store and reopen; drop or keep the `localStorage` move per the user's answer). 10c: Task 5 (What's new, after #4 and #9d have merged in the shell). 10d: Task 6 (docs). | timeline core, Timeline.tsx, store, keys, App, FilterBar, catalog, app.ts, api, Splitter, Section, SettingsDialog, shell, mains, whats-new.json |
| **#6 Phase 3** (part of XL) | 6c: RAW embedded previews, RAW+JPEG stacks, `.xmp` skipped | a `raw` handler, `galleryStacks.ts`, `walk.ts`, fixtures |
| *(third slot)* | **#6 Phase 4 and Phase 5 spikes only** (written comparisons posted on the issue: LibRaw WASM vs native, ffmpeg vs Chromium; no product code). These are part of #6's slot above, not a third issue. | – |

Checks:
- #10 ∩ #6c: none (#10 doesn't edit `galleryStacks.ts` or `walk.ts`).
- #5 Phase 2 is **not** in this wave because #10b edits `app.ts` routes as well.

### Wave 5
| Issue | PRs | Files |
|---|---|---|
| **#5 Phases 2–3** (part of XL) | 5b: Phase 2 (thumbnail fast path, on-demand thumbnails, `/full` disk cache, connection-limit check). 5c: Phase 3 steps 9–11 (scan order, batched writes, worker pool). 5d: Phase 3 steps 12–15 (slim/incremental `/items`, selectors, grid). 5d needs the user's answer on slim `/items`. | app.ts, media.ts, catalog, scanner, walk, store, api, Details, Tile, Grid, gallerySort |
| **#7b** (if not merged in wave 3) | CI caches and compression | yml, builder configs |

Wave 5 is mostly #5. #6 Phase 4 is **not** here: after 6a, #5 steps 7 and 11 edit `shared/server/mediaHandlers/` and `HandlerContext` (the derived cache, the worker pool), which is where LibRaw's `working()` would also go.

### Wave 6
| Issue | PRs | Files |
|---|---|---|
| **#6 Phases 4–6** (part of XL) | 6d: LibRaw `working()` + desktop self-test check. 6e: video (poster/probe, the `/media` route, `<video>` in the viewer, duration badge). 6f: per-format cost scheduling, on top of #5's worker pool. | the raw handler, `selfTest.ts`, `build.mjs`, builder configs, yml, app.ts, Viewer, Tile/Grid, scanner, packaging |

### Summary: wave per issue
| Issue | Size | Wave(s) |
|---|---|---|
| #11 | S | 1 |
| #3 | L | 1 |
| #2 | M | 1 |
| #4 | XL | 2 (4a–4d) |
| #5 | XL | 2 (Phase 1), 5 (Phases 2–3) |
| #6 | XL | 2 (Phase 1), 3 (Phase 2), 4 (Phase 3, + Phase 4/5 spikes), 6 (Phases 4–6) |
| #7 | M | 3 |
| #9 | XL | 3 (9a–9d) |
| #10 | XL | 4 (10a–10d) |

---

## 5. Implementer briefs

Each brief assumes section 0. "Done" for every PR also means: `npm test` and `npm run typecheck` pass; `npm run e2e:photo-tool` (or `e2e:editor`) passes when page code changed; the branch is rebased on `main`, with the version taken and bumped once.

**#11, Wave 1, branch `fix/stable-server-port`.**
- **First phase:** Task 1 (`listenWithFallback` in `shared/electron/serverHost.ts`, with a real occupied-port test and an `EACCES` fake), then Task 2 (`parseSavedPort`, `serverPortRequest` in `config.ts`; read and write `server-port.json` in `runDesktopApp.ts`), then Task 4 (the docs).
- **Done:** one PR.
  - Unit tests cover a free port, a busy port, `EACCES`, a corrupt port file and the four `serverPortRequest` cases.
  - Shell source tests show the window URL uses the `ready` port and nothing is saved in dev or self-test.
  - The Task 3 manual check (`dist:dir:*`, two starts, the same origin and `localStorage`) is recorded in the PR body.

**#3, Wave 1, branch `filter-panel` (rebased onto `main`).**
- **First phase:** Task 1, `photo-tool/core/galleryFilters.ts` with the "every `GalleryFilter` key has an entry" test. `isFilterActive` delegates to it.
- **Done:** one PR with Tasks 1–5. That means:
  - the core modules and tests;
  - `countText`;
  - `FilterBar` / `FilterPanel` / `FilteredRow`;
  - the CSS;
  - the two updated e2e tests and the four new ones;
  - an eye check at 1280 px in both themes, with a screenshot in the PR;
  - no changes to `store.ts`, `Details.tsx` or `WhatsInIt.tsx`.

**#2, Wave 1, branch `regenerate-description`.**
- **First phase:** worker plus backend (steps 1–2): `op: 'caption'` with sampling, `TaggerBackend.caption`, and a fake backend that returns changing text.
- **Done:** one PR with steps 1–8.
  - The queue's `regenerate`, with a retry on a lost backend and working while paused.
  - The route `POST /api/gallery/tagging/regenerate` returns 404 or 409 when it should.
  - The store action and the button with its busy state.
  - The e2e shows new text that survives a reload.

**#4, Wave 2, branch `update-check` (rebased onto `main`; then one branch per PR, stacked).**
- **First PR (4a):** Tasks 2–3. These are pure `shared/electron/updateRules.ts` and `shared/electron/updates.ts` with a fake updater; new files only. Done when `shared/tests/update-rules.test.ts` and `shared/tests/updates.test.ts` cover every Review Focus item (no release → up to date, silent offline start check, corrupt settings, one check in flight).
- **4b:** Tasks 1, 4, 5. Add the dependency and builder `publish`; the shell hooks (`installing`, `prepareInstall`, the start check, `UPDATE_FEED`); `updateChannel` in both mains; resolver rules via `netGuard.hostResolverRules`. Done when `resources/app-update.yml` exists in `dist:dir:photo-tool` and the shell source tests pass.
- **4c:** Tasks 6–7 (F1 About with Check for updates, F2 `feedbackUrl`). The Help submenu order is fixed here; later Help items (#9, #10) go after it.
- **4d:** Tasks 8–9 (`collect-assets.mjs` + test, the `release` job in `desktop.yml`, docs). Task 10's local-feed manual check is recorded in the PR body.

**#5, Wave 2, branch `fast-navigation`.**
- **First phase:** Phase 1 step 1, a pure `photo-tool/core/preloadWindow.ts` (`preloadOrder` with direction and short lists), replacing `viewerNeighbours`. Then `web/imageCache.ts` (in-flight cap, re-prioritise and cancel, LRU around 40, `decode()`), then Viewer and Preview use it with a `Map<path,index>`, then the grid warms the cache.
- **Done (5a):**
  - Vitest covers `preloadOrder` and `imageCache` (order, cap, cancel, evict).
  - The e2e shows the next 20 and previous 5 thumbnails requested, the next one first, and no request on a step.
  - The perf harness script and the before and after step-time numbers are in the PR.
  - No server or store changes.
- Phases 2 and 3 come in wave 5 as 5b–5d. 5d waits for the user's answer on slim `/items`.
- **Integration notes:**
  - 5d's grid and tile changes (overscan, tile thumbnail size) must also cover #10's `Timeline.tsx`.
  - #9b makes many more photos "edited", which makes the `EditedImage` preload risk bigger; plan a cached rendered thumbnail or a preload path for edited photos in 5b/5d.

**#6, Wave 2, branch `media-registry`.**
- **First phase:** Phase 1, `shared/core/mediaFormats.ts` plus `shared/server/mediaHandlers/{index,sharp,heic}.ts` that reproduce today's behaviour exactly. Every extension list and HEIC check named in the issue is replaced by `isSupported` / `formatOf` / `acceptAttribute` / `handlerFor` / capabilities, in both programs.
- **Done (6a):**
  - The existing tests pass unchanged.
  - A new guard test fails on any image-extension regex outside the registry.
  - Registry tests show every extension maps to one handler.
  - No new formats yet.
- Give the registry a "the browser can decode it" capability, so the editor's in-page list (`folders.ts`, `BrowserFolderPicker.tsx`) stays exactly as it is.
- Later PRs: 6b (Phase 2, wave 3, after the user's answer on the browser backend), 6c (Phase 3, wave 4), 6d–6f (Phases 4–6, wave 6, after the spikes and the user's answers).

**#7, Wave 3, branch `faster-loop`.**
- **First phase:** measure. Record per-file vitest times (JSON reporter), e2e wall time, and `dist:dir:*` vs `dist:*` times.
- Then split slow tests into a vitest project or script `test:slow` (the big-folder queue test, worker ping, "builds its own page", import-graph and boundaries), keeping `npx vitest run` fast and CI running both.
- **Done (7a):** before and after numbers are in the PR; README or docs have a "fast loop" vs "full loop" section; CI still runs every test.
- **7b:** CI caches (npm, Playwright, electron-builder), and maybe lower NSIS compression for non-release builds, rebased on #4's `desktop.yml`.

**#9, Wave 3, branch `gallery-keys-and-colour` (stacked PRs).**
- **Before starting:** get the user's confirmation of the proposed decisions table.
- **First PR (9a):** Task 1 (`selectAll` / `selectNone` in one `set`, Ctrl+A/D in `useReviewKeys`, skipped while typing) and Task 5 (`trashSelected` store action shared by the Delete key and `PhotoMenu`). Done when the store tests (only shown photos, next selection) and the e2e (Ctrl+A in the search field stays the field's own; Delete removes the tile) pass.
- **9b:** Tasks 2–4. Flip in the model, `[` / `]`, `colorAdjust.ts`, sharp `recomb`/`linear`, `<ColorFilter>`, the Auto endpoint. Done when the page vs server colour test is within ±3 and the editor import test shows the brighter photo.
- **9c:** Task 6. The spike result is posted on the issue, then `gallery:copy-files`.
- **9d:** Tasks 7–9. Before/after; the `shortcuts.ts` table with the "every handled key has an entry" test; the overlay; Help › Keyboard shortcuts, added after #4's Help items; docs.

**#10, Wave 4, branch `timeline-reopen-whatsnew` (stacked PRs).**
- **Before starting:** get the user's confirmation of the proposed decisions, and of the `localStorage` question after #11.
- **First PR (10a):** Task 1, a pure `photo-tool/core/timeline.ts` (`groupKey` without a time-zone shift, `groupTimeline`, `defaultUnit`, `timelineLayout`, `timelineWindow`, `rowOfItem`, 20,000 items in under 200 ms). Then Task 2, `Timeline.tsx`, the `view` union, `selectGroup`, Sort greyed out in #3's `FilterBar`, keys added to #9's shortcut table.
  - Done when the Timeline e2e passes, with headings, a heading selecting its group, Right stepping in date order, Day/Month, and around 3 screens of tiles at most.
  - The preview pane warms #5's image cache in timeline order (`preloadOrder` over the timeline's list).
- **10b:** Tasks 3–4 (the `ui_state` table, `/api/gallery/state`, `restoreSession`, the Settings checkbox). Keep or skip moving `thumbSize` / `Splitter` / `Section` per the user's answer.
- **10c:** Task 5 (`whatsNew.ts`, both JSON files, the shell check ordered before `updates.checkAtStart`, Help › What's new).
- **10d:** Task 6 (docs, the release note beside #4's).
