Title: Photo Tool: Filters panel, chips, query words and "Showing X of Y · Clear filter"
Head: filter-panel @ f808281 (local only, not pushed) → base: main @ 4bad967

Closes #3

Photo Tool's one-row filter bar is now a short bar plus a Filters panel. While the grid is filtered, a row of removable chips ends with "Showing X of Y · Clear filter". Words like `star:yes` typed in the search box become filters. One list of filters in `photo-tool/core` drives all of it.

## What was built

- **One list of filters** (`photo-tool/core/galleryFilters.ts`). Each entry holds its `GalleryFilter` keys, its panel group, its chip text, the patch that clears it, whether it is on, and its query words. `isFilterActive` in `gallerySort.ts` now delegates to it (`FILTERS.some(d => d.isOn(f))`), and its export is unchanged. A test fails when a `GalleryFilter` key belongs to no entry.
- **Query words** (`photo-tool/core/galleryQuery.ts`):
  - The words are `star:yes|no`, `shape:portrait|landscape`, `from:`/`to:YYYY-MM-DD`, `hidden:show|only`, `folder:<name>` (`folder:top`), `has:location|people`, `is:lowquality|duplicate`, `tag:<word>` and `object:<word>`.
  - Keys are case-insensitive, and a value with spaces is quoted.
  - On Enter, or a space after the word (outside quotes), the word leaves the box and becomes a filter.
  - A bad word stays in the box as text, and the line under the box says why.
  - When a word is repeated, the last one wins.
  - `folder:` only accepts a subfolder of the open folder, matched case-insensitively.
- **Bar** (`FilterBar.tsx`): Sort, Stack similar, and the search box with the examples line `Try star:yes shape:portrait from:2024-06-01 has:people tag:lake` (`aria-describedby`). Then the **Filters** button (`Filters · N`, with `aria-expanded` and `aria-controls`). The bar's right end reads "N photos" while nothing is filtered.
- **Panel** (`FilterPanel.tsx`): a `role="dialog"` popover named "Filters", with one fieldset per group (Photo, When, Where, Content, Quality) holding today's controls and labels.
  - It stays open while filters change.
  - Esc closes it and does nothing else (`preventDefault` + `stopPropagation`; the review keys skip dialogs anyway), and focus returns to the button.
  - A press outside it, or the button, also closes it.
  - Focus moves to its first control when it opens.
  - It is only rendered while open.
- **Filtered row** (`FilteredRow.tsx`, a region named "Active filters"): one chip per filter that is on, each with × named `Remove filter <chip text>`, then `Showing X of Y · Clear filter`. X is `useFilteredItems().length` (stacks unfolded, matches by meaning included) and Y is every photo in the folder.
- **`countText`**: "Showing 312 of 2,140" while filtered, "2,140 photos" or "1 photo" otherwise.
- **CSS** (`gallery.css`): the old `.gallery-filters` rules are replaced, and new rules cover the search hint (and its error state), the Filters button, the panel and its groups, and the filtered row. Only existing colour variables are used.

`store.ts`, `Details.tsx` and `WhatsInIt.tsx` are not changed.

## Tests

- `photo-tool/tests/gallery-filters.test.ts` (new):
  - every key has exactly one entry;
  - groups and their order;
  - every chip text and its `clear` patch;
  - chip order and ids;
  - the Filters · N count leaves the search text out;
  - `isFilterActive` agrees with the list.
- `photo-tool/tests/gallery-query.test.ts` (new):
  - every word;
  - the last word wins;
  - bad words and their messages;
  - unknown keys stay plain text;
  - the last word waits while typing;
  - a space inside quotes doesn't end the word;
  - `searchTextOf`;
  - the examples line;
  - every panel filter has a query word.
- `photo-tool/tests/gallery-sort.test.ts`: the count text test is updated to the new wording.
- `photo-tool/tests/e2e/gallery.spec.ts`:
  - Two existing tests now open Filters first: "H hides …" (finds Hidden with `exact: true`) and "a portrait photo in a very wide window …" (picks Portrait, then Esc).
  - A new `test.describe('#3 …')` block at the end has four tests: the panel, chip, × and Clear filter flow (with Esc leaving the selection and viewer alone, and a click outside closing the panel); Showing X counting photos, not tiles, with Stack similar on (seeded descriptions on a burst); query words becoming chips, a bad word's message, and Clear filter emptying a half-typed box; and f/h typed in the panel not starring or hiding.
- `npm run typecheck`, `npx vitest run` and `npm run e2e:photo-tool` all pass.

## Checked by hand

Checked with Playwright screenshots at 1280 × 800, `colorScheme` light and dark, served by the e2e server with temp data folders and a temp copy of the generated trip fixture:

- The bar fits on one line (every child's top is the same; asserted).
- The panel's right edge is inside the window (asserted). It opens from the Filters button towards the left, in three columns (Photo / When / Where, then Content / Quality).
- The filtered row shows the amber chips `Not starred × Portrait × From 2026-03-14 × Has location ×`, then `Showing 0 of 21 · Clear filter` at the right.
- `star:maybe` + Enter keeps the text, and the line under the box turns red with the reason.
- On the Map tab the panel sits on top of the map (checked with `elementFromPoint`).

Light and dark render the same dark theme. Photo Tool has one dark theme (`shared/web/base.css` sets `color-scheme: dark` and has no light rules), so the page doesn't change with the system setting. I didn't add a light theme.

Screenshots (local, not attached because nothing was pushed): `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\issue-3-shots\`

Not checked by hand: the Folder control and the `folder:` word. The trip fixture has no subfolders, so they are covered by unit tests only.

## Decisions I made

- **Enter makes a bad word search text.** After Enter, what stays in the box (a bad word like `star:maybe` included) is the search text, as the design says. While typing, an unfinished `key:` word is left out of the search, as `searchTextOf` in the plan says.
- **Clear filter empties the box itself.** With only a half-typed `shape:por` in the box, the store's `filter.text` doesn't change on clear, so syncing from the store can't empty the box. `FilterBar` passes `FilteredRow` an `onClear` that clears the store and the box. No store change.
- **The bar sits above the map only while the panel is open.** The bar is raised to z-index 1200 only then. The map's own overlays use 1100, and keeping the bar raised all the time would have put it over the photo viewer.
- **The Content group says how to add a keyword when none is on.** The line reads "Pick a keyword under What's in it, or type tag:word in the search box." The design doc's panel table is updated to match.

## Not done

- No new filter types, saved filter sets or autocomplete (out of scope in the issue).
- No light theme (there is none in the app).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
