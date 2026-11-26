### Spec Compliance

- ✅ Spec compliant. Every requirement in the issue has matching code in the diff.
- ⚠️ Cannot verify from diff: the Folder control and `folder:` word were never exercised in a browser (the report says so; unit tests only). The "fits on one line at 1280 px" and "panel stays inside the window" claims rest on the implementer's own screenshots and asserts. The unchanged `store.ts` selectors were read to check the count (see below).

Checks run (read-only):
- Count: `selectFiltered` in `photo-tool/web/store.ts:1378` returns the sorted list with stacks unfolded plus the meaning matches. FilteredRow.tsx:1554 uses it for X, and `items.length` for Y. X is correct with Stack similar on, and the e2e asserts it (`Showing 4 of total`, same after unstacking). Hidden photos are left out of X unless the Hidden filter is set, but they are inside Y (`items.length`).
- Every old filter has an entry in `FILTERS`: starred, orientation, from/to, hidden, relDir, the four checkboxes, text and tags. The key-coverage test is compile-checked through `Record<keyof GalleryFilter, true>`. `isFilterActive` now delegates to the list. Each one has a panel control, a chip (text has none by design) and a query word.
- Chips and panel share one source (the store `filter`). Chip × calls `setFilter(chip.clear)`. `FilteredRow` and `FilterPanel` both read `useGallery(s => s.filter)`, so they cannot drift. The box follows outside changes through the effect at FilterBar.tsx:1194, and `onClear` empties a half-typed word.
- Esc and keys: `useReviewKeys.ts:6` treats `input`, `select` and `[role="dialog"]` as typing, so f and h in the panel are inert, checkboxes included. The panel's Esc handler calls `preventDefault` and `stopPropagation`, and the review key handler also bails on `defaultPrevented`. Focus goes to the first control on open and back to the button on close.

### Strengths

- A single list in `core` with a compile-time key check and a runtime test. `isFilterActive` can no longer drift from the chips and badge. Core has no React, so it is unit-testable.
- `takeQueryWords` is a clean split/keyOf/parse pipeline. Quotes, the last word winning, unknown keys passing through as text, the `folder:` existence check with the exact `relDir` back, and `final` versus typing are all handled and tested.
- Bad words stay as text with a specific reason. Error text is rendered as a React text node, so there is no injection.
- The popover is a real dialog with `aria-expanded`/`aria-controls`/`aria-describedby`, focus in and out, and an outside-pointer close that does not refocus. Plan decisions that were underspecified (Clear also empties the box, the bar raised only while open) were made sensibly and documented.
- e2e covers chip, count, × / Clear / Esc / outside click, stacked count, query words and a panel keystroke leak.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

1. **Query values that name an `Object.prototype` member are silently swallowed.** `photo-tool/core/galleryFilters.ts:439` (`choice`): `values[v.toLowerCase()]` indexes a plain object literal. `star:constructor`, `shape:__proto__`, `has:toString` and `hidden:valueOf` (any case) return the inherited function or object, which is truthy. `takeQueryWords` (galleryQuery.ts:613-620) then treats it as a match: `isTag` is false, `Object.assign(patch, fn)` copies nothing, and the word is dropped from `rest` with no filter set and no error. The user's text vanishes silently, which breaks the "a bad word stays as text and says why" rule. It is not an injection, because `Object.assign` copies only own enumerable keys. Fix: look up with `Object.hasOwn(values, k)` or build the table with `Object.create(null)`/a `Map`. Add tests for `star:constructor` and `has:__proto__`.
2. **The "one list drives the panel" claim is only half true; a new filter fails silently in the panel.** `photo-tool/web/components/FilterPanel.tsx:1403-1484` (`Control`) is a hand-written `switch (id)` with `default: return null`. A new `FilterDef` with a group, chips and a query word gets a chip, a badge count and a query word but no control in the panel, and no test catches it. The issue's scaling story is "add one entry and a test fails when it is missing". Fix: put the control (or a small descriptor: label, kind, options) on `FilterDef`, or add a test that every `group !== null` id has a `Control` case, or make `default` throw in dev.

#### Minor (Nice to Have)

1. A stray odd double quote in plain text (for example `12" pizza `) makes `endsWord` (FilterBar.tsx:1169) and `split` (galleryQuery.ts:572) treat the rest of the box as quoted. Later query words then never commit on space, and on Enter they merge into one word. Tolerate an unclosed quote only when it follows `key:`.
2. `from:` and `to:` accept a reversed range (galleryFilters.ts:450). The panel's `min`/`max` prevent this but the box does not. The result is a zero-result grid with a chip like `2024-06-09 → 2024-06-01`. Reject or swap it.
3. The panel (gallery.css:1612) has no `max-height` or `overflow-y`. With many more groups it will run off the bottom of short windows, which is the scaling the issue asks for. It also is not a focus trap and does not close on Tab-out, so Esc only works while focus is inside it.
4. `#gallery-search-hint` (FilterBar.tsx:1329) is a polite live region that also holds the always-present examples. Only the error should be live. The `Showing X of Y` span is a second live region.
5. `FilteredRow.tsx:1544` imports `countText` from `FilterBar.tsx`, which imports `FilteredRow` (a circular import, harmless today because it is used at render time). Move `countText` to a small module, or to core.
6. Y counts hidden photos (`items.length`), as the issue says, so a filtered grid can read "Showing 3 of 100" while the unfiltered grid already shows fewer than 100 under "100 photos". This matches the issue and the old behaviour, but it is worth a one-line note in the UI copy or the docs.
7. Test gaps: no browser test of a valid query word taken on Enter, of `tag:` deduping against the store, or of the Folder control. The e2e fixture has no subfolders, so `folder:` is unit-tested only.

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The design is sound and every requirement is met, with correct counts, chips that stay in step with the panel, and good keyboard handling. Two Important defects remain: the query parser silently eats `constructor`/`__proto__`-style values, and the single-list guarantee does not reach the panel, where a hand-written switch silently drops any new filter.
