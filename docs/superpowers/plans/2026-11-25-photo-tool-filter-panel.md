# Photo Tool filter panel, chips, query words and "Showing X of Y": Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Photo Tool's one-row filter bar with a Filters button and grouped panel, removable chips with "Showing X of Y · Clear filter", and `key:value` query words in the search box, all driven by one list of filters.

**Architecture:** Two new pure modules in `photo-tool/core`. `galleryFilters.ts` is the list of filters: each entry knows its `GalleryFilter` keys, its panel group, its chip text, how to clear it and its query words. `galleryQuery.ts` parses query words out of the search box. `isFilterActive` is worked out from the list. The React side (`FilterBar.tsx` and new `FilterPanel.tsx` and `FilteredRow.tsx`) only reads them. The store's `setFilter`, `clearFilter` and `toggleTagFilter` are used as they are.

**Tech Stack:** React 19, Zustand store, Vite, TypeScript, Vitest (pure logic, no DOM), Playwright e2e (`npm run e2e:photo-tool`).

**Spec:** `docs/superpowers/specs/2026-11-25-photo-tool-filter-panel-design.md`

## Global Constraints

- Branch `filter-panel` (from `split-programs`), worktree `../photobook_helper-filters`.
- Before each commit: `npm version patch --no-git-tag-version`. Commit as `git -c user.name="SWS-Chipkin" -c user.email="sws-dev@chipkin.com" commit` with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. (The version bump will conflict with other branches' bumps in `package.json` and `package-lock.json` on merge; take the higher version.)
- Do not change `photo-tool/web/store.ts`, `photo-tool/web/components/WhatsInIt.tsx` or `photo-tool/web/components/Details.tsx`. No new filter types. `filterItems` matching stays as it is.
- Tests never read `photos/`, `data/`, `trial-output/` or the real `%APPDATA%`; e2e uses the generated `fixtures/generated/trip` copy as today.
- Copy is exact: button "Filters" (with ` · N` when N > 0), count "Showing 312 of 2,140", button "Clear filter", unfiltered count "2,140 photos" / "1 photo", examples line starting "Try".
- Labels kept for tests: "Sort", "Stack similar", "Search photos", and in the panel "Stars", "Shape", "From", "To", "Hidden", "Folder", "Low quality", "Near-duplicates", "Has location", "Has people". Chip remove buttons are named `Remove filter <chip text>`; chip texts never contain a panel label word ("Shape", "Hidden", "Stars", "Folder").

## Review Focus

- A space inside an open quote (`folder:"Day 2`) must not commit the word; the space after the closing quote does. (Task 2 test.)
- Clear filter while the box holds a half-typed `star:ye` must empty the box too, and the box must follow any other change to `filter.text` from outside. (Task 4 e2e.)
- `star:yes star:no` in one go: the last one wins, no error. (Task 2 test.)
- `folder:` with a name that isn't a subfolder of the open folder must stay as text with an error, not set a folder that shows nothing; matching is case-insensitive and gives back the folder's exact `relDir`. (Task 2 test.)
- Esc in the panel closes it and nothing else: the review keys don't see it, and the selection and viewer don't change. (Task 4 e2e.)

---

### Task 1: The list of filters (`galleryFilters.ts`)

**Files:**
- Create: `photo-tool/core/galleryFilters.ts`
- Modify: `photo-tool/core/gallerySort.ts` (`isFilterActive` delegates to the list; keep its export so callers don't change)
- Test: `photo-tool/tests/gallery-filters.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FilterGroup = 'Photo' | 'When' | 'Where' | 'Content' | 'Quality';
  export interface FilterChip { id: string; text: string; clear: Partial<GalleryFilter> }
  export interface FilterDef {
    id: string;                                   // 'starred' | 'orientation' | 'dates' | 'hidden' | 'relDir' | 'hasLocation' | 'hasPeople' | 'lowQuality' | 'nearDuplicates' | 'tags' | 'text'
    keys: (keyof GalleryFilter)[];                // the GalleryFilter keys it owns
    group: FilterGroup | null;                    // null: not in the panel ('text' lives in the search box)
    chips(f: GalleryFilter): FilterChip[];        // [] while off; 'tags' gives one chip per tag; 'text' gives none
    isOn(f: GalleryFilter): boolean;
  }
  export const FILTERS: readonly FilterDef[];
  export const FILTER_GROUPS: readonly FilterGroup[];          // panel order: Photo, When, Where, Content, Quality
  export function filterChips(f: GalleryFilter): FilterChip[]; // every chip, in FILTERS order
  export function activeFilterCount(f: GalleryFilter): number; // entries that are on, 'text' left out (the Filters · N badge)
  ```
  Query words are added to `FilterDef` in Task 2.

- [ ] **Step 1: Write the failing tests** in `gallery-filters.test.ts`:
  - `every GalleryFilter key belongs to exactly one filter`: build a `Record<keyof GalleryFilter, true>` literal listing every key (a compile error when a key is added to `GalleryFilter` and not here), then `expect(FILTERS.flatMap(d => d.keys).sort()).toEqual(Object.keys(ALL_KEYS).sort())`.
  - `chip text`: `filterChips({ starred: 'yes' })[0].text === 'Starred'`; `'no'` → `'Not starred'`; `orientation: 'portrait'` → `'Portrait'`; `{ from: '2024-06-01' }` → `'From 2024-06-01'`; `{ to: '2024-06-09' }` → `'Until 2024-06-09'`; both → one chip `'2024-06-01 → 2024-06-09'` whose `clear` is `{ from: undefined, to: undefined }`; `hidden: 'show'` → `'Hidden shown'`, `'only'` → `'Only hidden'`; `relDir: ''` → `'Top folder'`, `relDir: 'Day 2'` → `'Day 2'`; `hasLocation` → `'Has location'`; `hasPeople` → `'Has people'`; `lowQuality` → `'Low quality'`; `nearDuplicates` → `'Near-duplicates'`; `tags: [{kind:'keyword',value:'lake'},{kind:'object',value:'boat'}]` → two chips `'lake'`, `'boat'`, and the `lake` chip's `clear` is `{ tags: [{kind:'object',value:'boat'}] }` (the last one's is `{ tags: undefined }`); `{ text: 'x' }` → no chips.
  - `count leaves the search text out`: `activeFilterCount({ starred: 'yes', from: 'a', to: 'b', text: 'x' }) === 2`; `activeFilterCount({}) === 0`.
  - `isFilterActive agrees with the list`: for each of these, `isFilterActive(f) === FILTERS.some(d => d.isOn(f))`: `{}`, `{ text: '  ' }` (false), `{ text: 'x' }`, `{ relDir: '' }` (true), `{ tags: [] }` (false), and each single-filter case above.
  - Note: "Hidden shown" contains "Hidden". That is why remove buttons are named `Remove filter Hidden shown` and the panel control is found with `getByRole('combobox', { name: 'Hidden', exact: true })` in e2e (Task 4).

- [ ] **Step 2: Run** `npx vitest run photo-tool/tests/gallery-filters.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `galleryFilters.ts` as above, and change `isFilterActive` in `gallerySort.ts` to `FILTERS.some((d) => d.isOn(f))`. To avoid an import cycle, `galleryFilters.ts` imports only types from `gallerySort.ts`, and `gallerySort.ts` imports `FILTERS` (type imports are erased).

- [ ] **Step 4: Run** `npx vitest run photo-tool/tests/gallery-filters.test.ts photo-tool/tests/gallery-sort.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** (`feat(photo-tool): one list of grid filters with chips`).

### Task 2: Query words (`galleryQuery.ts`)

**Files:**
- Create: `photo-tool/core/galleryQuery.ts`
- Modify: `photo-tool/core/galleryFilters.ts` (add `query?` to `FilterDef` and to the entries)
- Test: `photo-tool/tests/gallery-query.test.ts`

**Interfaces:**
- Consumes: `FILTERS`, `FilterDef` (Task 1).
- Produces:
  ```ts
  // On FilterDef (Task 1's file); 'dates' has two (from:, to:), 'text' none:
  query?: QueryWord[];
  export interface QueryWord {
    key: string;                 // lower case, without the colon: 'star', 'has', ...
    hint(value: string, ctx: QueryContext): string; // after "isn't a filter: ", e.g. 'try star:yes or star:no'
    example?: string;            // shown in the examples line when set
    parse(value: string, ctx: QueryContext): Partial<GalleryFilter> | TagFilter | null; // null: not this word's value
  }
  // galleryQuery.ts:
  export interface QueryContext { dirs: string[] }              // the open folder's relDirs ('' is the top folder)
  export interface QueryResult {
    patch: Partial<GalleryFilter>;   // filters to set (tags not included)
    tags: TagFilter[];               // tags to add (deduped against each other, not against the store)
    rest: string;                    // what stays in the box: free text, bad words and an unfinished last word
    error: string | null;            // the first bad word's message, or null
  }
  export function takeQueryWords(box: string, ctx: QueryContext, final: boolean): QueryResult;
  export function searchTextOf(box: string): string | undefined; // the box minus a trailing unfinished word that starts with a known key:, trimmed; undefined when empty
  export function queryExamples(): string[];                       // FILTERS' examples in FILTERS order
  ```
- Words (exact): `star:yes|no`, `shape:portrait|landscape`, `from:YYYY-MM-DD`, `to:YYYY-MM-DD`, `hidden:show|only`, `folder:<name>` (`folder:top` is `''`), `has:location`, `has:people`, `is:lowquality`, `is:duplicate`, `tag:<word>` (keyword), `object:<word>`. `has:` and `is:` are shared keys: their value picks the filter. Keys and fixed values are case-insensitive. `tag:`/`object:` values are lower-cased. Values may be double-quoted.
- Example line order: `star:yes  shape:portrait  from:2024-06-01  has:people  tag:lake` (the `example` of those five entries; `queryExamples()` returns only entries whose `example` is set, so keep the others' empty).

- [ ] **Step 1: Write the failing tests** in `gallery-query.test.ts` (`ctx = { dirs: ['', 'Day 2', 'day3'] }`):
  - `takes known words out on Enter`: `takeQueryWords('star:yes lake shape:Portrait', ctx, true)` → `{ patch: { starred: 'yes', orientation: 'portrait' }, tags: [], rest: 'lake', error: null }`.
  - `every word`: one assertion each: `from:2024-06-01` → `{ from: '2024-06-01' }`; `to:2024-06-09` → `{ to: '2024-06-09' }`; `hidden:only` → `{ hidden: 'only' }`; `folder:top` → `{ relDir: '' }`; `folder:"day 2"` → `{ relDir: 'Day 2' }`; `has:location` → `{ hasLocation: true }`; `HAS:People` → `{ hasPeople: true }`; `is:lowquality` → `{ lowQuality: true }`; `is:duplicate` → `{ nearDuplicates: true }`; `tag:Lake` → tags `[{ kind: 'keyword', value: 'lake' }]`; `object:boat` → tags `[{ kind: 'object', value: 'boat' }]`.
  - `last one wins`: `'star:yes star:no'` → `patch.starred === 'no'`, `error === null`.
  - `bad words stay as text with a reason`: `'star:maybe lake'` → `patch {}`, `rest 'star:maybe lake'`, `error === '"star:maybe" isn\'t a filter: try star:yes or star:no'`; `from:june` → error `'"from:june" isn\'t a filter: try from:YYYY-MM-DD'`; `folder:nowhere` → error `'"folder:nowhere" isn\'t a filter: no folder named nowhere'`; `has:dogs` → error `'"has:dogs" isn\'t a filter: try has:location or has:people'`.
  - `unknown keys are plain text`: `'http://x a:b'` → `patch {}`, `rest 'http://x a:b'`, `error null`.
  - `while typing, the last word waits`: `takeQueryWords('star:yes shape:por', ctx, false)` → `patch { starred: 'yes' }`, `rest 'shape:por'`; `takeQueryWords('star:yes ', ctx, false)` → `patch { starred: 'yes' }`, `rest ''`.
  - `a space inside quotes doesn't finish the word`: `takeQueryWords('folder:"Day ', ctx, false)` → `patch {}`, `rest 'folder:"Day '`; `takeQueryWords('folder:"Day 2" ', ctx, false)` → `patch { relDir: 'Day 2' }`.
  - `search text leaves out an unfinished filter word`: `searchTextOf('lake star:ye') === 'lake'`; `searchTextOf('star:') === undefined`; `searchTextOf('lake ') === 'lake'`; `searchTextOf('a:b') === 'a:b'`.
  - `examples`: `queryExamples()` equals `['star:yes', 'shape:portrait', 'from:2024-06-01', 'has:people', 'tag:lake']`.
  - `every panel filter has a query word`: every `FILTERS` entry with `group !== null` has a non-empty `query`.

- [ ] **Step 2: Run** `npx vitest run photo-tool/tests/gallery-query.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Split the box into words on spaces outside double quotes, keeping each word's raw text so `rest` keeps the user's spelling. A word is a query word when it matches `/^([a-z]+):(.*)$/i` and its lower-cased key is the key of some `QueryWord`. For shared keys (`has`, `is`) try each `QueryWord` with that key and use the first `parse` that isn't null. When `final` is false and the box doesn't end with a space outside quotes, the last word is left in `rest` untouched. Join `rest` with single spaces.

- [ ] **Step 4: Run** `npx vitest run photo-tool/tests/gallery-query.test.ts photo-tool/tests/gallery-filters.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** (`feat(photo-tool): key:value query words for the search box`).

### Task 3: Count text

**Files:**
- Modify: `photo-tool/web/components/FilterBar.tsx` (`countText`)
- Test: `photo-tool/tests/gallery-sort.test.ts` (the `count text` describe)

**Interfaces:**
- Produces: `countText(shown: number, total: number, filtered: boolean): string`, same signature, new filtered copy.

- [ ] **Step 1: Change the test**: `countText(312, 2140, true) === 'Showing 312 of 2,140'`; `countText(2140, 2140, false) === '2,140 photos'`; `countText(1, 1, false) === '1 photo'`.
- [ ] **Step 2: Run** `npx vitest run photo-tool/tests/gallery-sort.test.ts`. Expected: FAIL on the first assertion.
- [ ] **Step 3: Implement** the new copy.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5:** No commit yet; it ships with Task 4 (the copy only makes sense with the new row).

### Task 4: The bar, panel and filtered row (UI) with e2e

**Files:**
- Modify: `photo-tool/web/components/FilterBar.tsx` (bar: Sort, Stack similar, search with examples line, Filters button, unfiltered count; renders the panel and the row)
- Create: `photo-tool/web/components/FilterPanel.tsx`
- Create: `photo-tool/web/components/FilteredRow.tsx`
- Modify: `photo-tool/web/gallery.css` (replace `.gallery-filters` rules; add `.gallery-filter-panel`, `.gallery-filter-group`, `.gallery-filtered-row`, `.gallery-search-hint`, `.gallery-search-hint.error`; reuse `.gallery-chip`, `.gallery-filter-chip`, `.btn`)
- Test: `photo-tool/tests/e2e/gallery.spec.ts`

**Interfaces:**
- Consumes: `FILTERS`, `FILTER_GROUPS`, `filterChips`, `activeFilterCount` (Task 1); `takeQueryWords`, `searchTextOf`, `queryExamples` (Task 2); `countText` (Task 3); store `setFilter`, `clearFilter`, `toggleTagFilter`, `useFilteredItems`, `useGallery`.
- Behaviour:
  - Search box: local `draft` state. `onChange`: `setDraft(v)`; `setFilter({ text: searchTextOf(v) })`; if `v` ends with a space outside quotes, run `takeQueryWords(v, { dirs }, false)` and, when its `patch` or `tags` aren't empty, `setFilter({ ...patch, text: searchTextOf(rest), tags: merged })` (merged = store tags plus new ones, deduped by kind+value; `undefined` when empty) and `setDraft(rest)`. `Enter`: the same with `final: true`. `error` shows in place of the examples line until the next change. When `filter.text` changes and isn't `searchTextOf(draft)` (Clear filter, chip ×), set `draft` to `filter.text ?? ''`.
  - Examples line under the box: `Try` then each of `queryExamples()` in `<code>`, `id="gallery-search-hint"`, and the box has `aria-describedby="gallery-search-hint"`.
  - Filters button: `aria-expanded`, `aria-controls` the panel, text `Filters` or `Filters · N` (`activeFilterCount`).
  - Panel: `role="dialog"`, `aria-label="Filters"`, one `<fieldset>` per `FILTER_GROUPS` with `<legend>`; the controls are today's controls with today's labels; the Content group also shows the tag chips that are on. Esc (handled on the panel, `preventDefault` + `stopPropagation`), the button or a `pointerdown` outside the panel and the button close it. Focus moves to the panel's first control on open and back to the button on close.
  - Filtered row (only when `isFilterActive(filter)`): `role="region"`, `aria-label="Active filters"`; one chip per `filterChips(filter)` with a × button named `Remove filter <text>` calling `setFilter(chip.clear)`; then `countText(useFilteredItems().length, items.length, true)` with `aria-live="polite"` and a `Clear filter` button calling `clearFilter()`.
  - Unfiltered: the bar's right end shows `countText(..., false)`.

- [ ] **Step 1: Update the existing e2e tests**: `H hides the photo …` opens Filters before `getByRole('combobox', { name: 'Hidden', exact: true })`; `a portrait photo in a very wide window …` opens Filters, picks Portrait, then closes the panel with Esc before measuring. "Stack similar" and "Search photos" stay in the bar, so those tests don't change. The `What's in it` test's `Remove filter lake` still passes.

- [ ] **Step 2: Write the new e2e tests** in `gallery.spec.ts` (open the trip fixture with `openTrip`, uncheck Stack similar, read the total from the `N photos` text):
  - `Filters opens a panel; a filter shows a chip and Showing X of Y; × and Clear filter undo it`: no `Active filters` region at first; click `Filters`; panel `Filters` is visible with legends Photo, When, Where, Content, Quality; pick Shape → Portrait; the button reads `Filters · 1`; the region shows a `Portrait` chip and `Showing <tiles> of <total>`, where `<tiles>` equals the tile count; press Escape: the panel closes and the selected tile is unchanged; click `Remove filter Portrait`: all tiles back, no region; set Shape again, then `Clear filter`: no region and the button reads `Filters`.
  - `Showing X counts photos, not tiles, with Stack similar on`: Stack similar on, type `lake` in the search box (no chip, region shows), the `Showing` number equals the count with Stack similar off for the same search.
  - `query words in the search box become chips`: the hint shows `star:yes` and `tag:lake`; type `shape:portrait ` (trailing space): the box is empty, a `Portrait` chip is there and the panel's Shape shows Portrait; type `star:maybe` and press Enter: the text stays and the hint reads `"star:maybe" isn't a filter: try star:yes or star:no`; type `shape:por`, click `Clear filter`: the box is empty.
  - `keys typed in the panel don't star or hide`: select a tile, open Filters, focus the From date input and press `f` and `h`: the tile has no star badge and the tile count is unchanged.

- [ ] **Step 3: Run** `npm run e2e:photo-tool -- -g "Filters opens|counts photos|query words|keys typed in the panel"`. Expected: FAIL (no Filters button).

- [ ] **Step 4: Implement** the three components and the CSS as above.

- [ ] **Step 5: Run** `npx vitest run photo-tool` and `npm run e2e:photo-tool`. Expected: all PASS.

- [ ] **Step 6: Check by eye** in the dev server (`.claude/launch.json` photo-tool entry, with `PHOTO_TOOL_DATA_DIR`, `PHOTO_TOOL_PROFILE_DIR` and `PHOTOINFO_FALLBACK_DIR` pointing at temp folders): the bar fits on one line at 1280 px wide, the panel doesn't run off the right edge, and dark and light themes both read. Take a screenshot of the filtered row.

- [ ] **Step 7: Commit** (`feat(photo-tool): Filters panel, active-filter chips and Showing X of Y`).

### Task 5: Full check

- [ ] **Step 1: Run** `npm test` and `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 2: Run** `npm run e2e:photo-tool`. Expected: PASS.
- [ ] **Step 3:** Update the spec if anything changed while building; commit if so.
