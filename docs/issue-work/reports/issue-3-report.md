# Issue #3 report: filter panel, chips, query words, "Showing X of Y · Clear filter"

**Status:** done, committed locally only. Following the coordinator's override, nothing was pushed, no PR was opened and there was no `gh auth switch`. `gh auth status` ran once, read-only, before the override arrived.

## Where the work is

- **Branch:** `filter-panel`
- **Worktree:** `C:\Users\funvill\Documents\git\photobook_helper-filters`
- **Final commit:** `f808281` (rebased onto local `main` at `4bad967`, which is the same as `origin/main`)
- **In place of the PR URL:** branch `filter-panel` @ `f808281`.
- **PR text I would have used:** `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\issue-3-pr.md`
- **Screenshots:** `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\issue-3-shots\`. There are 10 PNGs: the bar, the panel, the filtered row, the bad word and the panel over the map, each in light and dark.

`origin/filter-panel` still holds the old docs commit `f41d73a`, so the local branch has diverged from it. Pushing will need `--force-with-lease`.

## Commits (on top of main 4bad967)

1. `843390a` docs: design and plan (the original `f41d73a`, rebased; its version-bump conflict was resolved by taking main's version)
2. `a16a107` feat(photo-tool): one list of grid filters with chips (Task 1)
3. `4ef31d4` feat(photo-tool): key:value query words for the search box (Task 2)
4. `aaacc71` feat(photo-tool): Filters panel, active-filter chips and Showing X of Y (Tasks 3–4, plus one line in the design doc)
5. `f808281` chore: version 0.1.36 (main's 0.1.35, bumped once)

## What was built

- **`photo-tool/core/galleryFilters.ts`** is the one list of filters. Each entry has keys, group, chips, `isOn` and query words, and the file exports `FILTER_GROUPS`, `filterChips` and `activeFilterCount`.
  - `isFilterActive` in `gallerySort.ts` now delegates to it.
  - `galleryFilters.ts` imports only types from `gallerySort.ts`, so there is no import cycle at run time.
- **`photo-tool/core/galleryQuery.ts`** provides `takeQueryWords`, `searchTextOf` and `queryExamples`. It covers every word the issue lists, quoted values, the last word winning, bad words staying with a reason, and the folder word matching subfolders case-insensitively.
- **`FilterBar.tsx`** holds:
  - Sort and Stack similar;
  - the search box, with its examples or error line (`aria-describedby`);
  - the `Filters · N` button (`aria-expanded`, `aria-controls`);
  - "N photos" while nothing is filtered;
  - `countText`, which now gives "Showing X of Y".
- **`FilterPanel.tsx`** is a `role=dialog` popover, rendered only while open, with one fieldset per group holding today's controls and labels.
  - Esc closes it and stops there, and focus returns to the button.
  - A press outside it, or the button, also closes it.
  - Focus moves to its first control when it opens.
- **`FilteredRow.tsx`** is the "Active filters" region: chips with `Remove filter <text>` buttons, then "Showing X of Y · Clear filter". X is `useFilteredItems().length`.
- **`gallery.css`** replaces the one-row rules and adds the hint, button, panel, group and row styles. It uses only existing colour variables.
- **Off-limits files:** `store.ts`, `Details.tsx` and `WhatsInIt.tsx` are unchanged (`git diff main` confirms it).

## Tests

- New `photo-tool/tests/gallery-filters.test.ts`. It includes the test that every `GalleryFilter` key has an entry, built on a `Record<keyof GalleryFilter, true>`, so a new key is also a compile error.
- New `photo-tool/tests/gallery-query.test.ts`.
- `photo-tool/tests/gallery-sort.test.ts`: the count text test is updated.
- e2e (`photo-tool/tests/e2e/gallery.spec.ts`):
  - Two existing tests were updated: "H hides …" and "a portrait photo in a very wide window …".
  - Four new tests sit in `test.describe('#3 Filters panel, chips, query words and Showing X of Y')` at the end of the file.
  - Every new test was watched failing before the code was written.
- Final runs, before the version-only commit:
  - `npx tsc --noEmit`: clean.
  - `npx vitest run`: 79 files and 1140 tests passed (4 skipped).
  - `npx playwright test --project=photo-tool`: 44 passed.
- Playwright ran on other ports (`PHOTOBOOK_E2E_PORT=5395 PHOTO_TOOL_E2E_PORT=5396`, with its own data folders). Something else, probably another implementer, was holding the default ports 5185/5186. I didn't touch those processes.

## Eye check

This was done with Playwright screenshots, not computer use. The page was served by the e2e server with temp data folders and a temp copy of the generated trip fixture, at 1280 × 800 with `colorScheme` light and dark. The scratch spec was deleted before committing.

- The bar fits on one line (asserted).
- The panel stays inside the window (asserted). It opens leftwards from the Filters button in three columns.
- The chips in the filtered row are easy to read.
- The bad-word message shows in red under the box.
- On the Map tab the panel is drawn on top of the map (asserted with `elementFromPoint`).
- **Light and dark render the same dark theme.** The light shots I opened look the same as the dark ones. Photo Tool has only one dark theme (`shared/web/base.css` sets `color-scheme: dark` and has no light rules). I didn't add a light theme.

## Not checked by hand

- The Folder control and the `folder:` word are covered by unit tests only. The trip fixture has no subfolders, so neither was tried in the browser.

## Decisions I made

- **Enter makes a bad word search text.** After Enter, the whole remaining box (bad words like `star:maybe` included) becomes the search text, as the design says. While typing, an unfinished `key:` word is left out of the search, as `searchTextOf` in the plan says. The e2e checks the "Showing 0 of" result.
- **Clear filter empties the box itself.** With only a half-typed `shape:por` in the box, `filter.text` doesn't change on clear, so the plan's sync rule can't empty it. `FilterBar` passes `FilteredRow` an `onClear` that clears the store and the box. No store change.
- **The bar sits above the map only while the panel is open.** The bar gets z-index 1200 only then, over the map overlays (1100), so the photo viewer (z-index 55) still covers it.
- **The Content group says how to add a keyword when none is on.** One line is added to the design doc's panel table to match.
- **Version.** Each commit was bumped as the rules say. The final commit sets 0.1.36 (main's 0.1.35 + 1). Intermediate commits carry 0.1.36–0.1.38.

## Concerns

- `origin/filter-panel` has diverged (see above), so a later push needs `--force-with-lease`.
- The e2e suite's default ports were taken by another run on this machine. Parallel implementers may collide unless they set `PHOTOBOOK_E2E_PORT` / `PHOTO_TOOL_E2E_PORT`.
- The "light and dark" check can only show one look until the app has a light theme.
- `fixtures/generated/trip` was generated in the worktree (`npm run fixtures`). It is git-ignored.

## Fix round 1

These are fixes for the two Important review findings (`issue-3-review.md`). Everything is local only: no push and no `gh auth`.

1. **Prototype values were swallowed.** `choice()` in `photo-tool/core/galleryFilters.ts` now looks values up in a `Map` instead of a plain object.
   - New test in `photo-tool/tests/gallery-query.test.ts`: `star:constructor`, `shape:__proto__` and `has:toString` each stay as text with their hint error. `hidden:valueOf` and `is:hasOwnProperty` also stay as text.
   - I watched the test fail before the fix and pass after it.
2. **The panel is now driven from the list, so a filter can't be left out of it.**
   - `FilterDef` is now a union. An entry with a `group` must carry `controls: [PanelControl, ...PanelControl[]]`, so an entry without them does not compile. The search text entry (`group: null`) has none.
   - `PanelControl` is data: `select` (label, key, options), `date`, `check`, `folder` and `tags`.
   - `FilterPanel.tsx` no longer switches on the filter id. It draws each entry's controls with a switch over `kind` that ends in a `never` check, so a new kind does not compile until the panel draws it.
   - New test in `gallery-filters.test.ts`: every panel entry has at least one control, each control's key belongs to its own entry, and the labels match today's in panel order. I watched it fail first.
3. **Rebased onto local `issues-integration`** (4f42e0d, which holds #11 and #2).
   - `gallery.spec.ts` conflicted because both #2 and #3 add a describe block at the end. I kept both, with #2 first and then #3.
   - Version conflicts were resolved by taking issues-integration's version. The tip is at 0.1.38, which is issues-integration's 0.1.37 + 1. That version comes from the fix commit's own bump, so the old version-only commit dropped out as empty and a separate final bump commit would also have been empty.
   - Ran `npm ci` again after the rebase.
4. The review's Minor items are not done: stray quotes, reversed date ranges, the panel's max-height and focus trap, the live-region scope, moving `countText`, and the extra tests.

**Head:** `filter-panel` @ `8436ff6`.

**Fix round 1 test runs (on 8436ff6):**
- `npx tsc --noEmit`: clean.
- `npx vitest run`: 80 files and 1174 tests passed (4 skipped).
- `npx playwright test --project=photo-tool`, on ports 5550/5551: 45 passed. That count includes #2's new test.
