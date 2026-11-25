# Photo Tool: filter panel, chips and "Showing X of Y"

## Why

The grid's filter bar holds every control in one wrapping row (Sort, Stars, Shape, From, To,
Hidden, Folder, four checkboxes, Stack similar, search, keyword chips, a count and Clear). More
ways to filter are coming and that row cannot take them. The user also wants to see at a glance
that the grid is filtered, how much it hides, and to undo it in one click:
"Showing XXXX of XXX" with a "Clear filter" button next to it.

## Goals

- A layout that takes many more filter types without growing the bar.
- When the grid is filtered: one row that says so, shows each filter that is on as a chip that
  can be removed, and ends with "Showing 312 of 2,140 · Clear filter".
- Adding a filter type later means adding one entry to one list (the panel, the chips and
  "is anything filtered" all read it).
- Every filter there is today keeps working the same way.

## Non-goals

- No new filter types in this change.
- No autocomplete for query words (the examples line and the error line teach them).
- No saved or named filter sets; filters stay in memory for the session as today.
- No change to how filters match photos (`filterItems`) or to the store's filter actions.

## Anti-goals

- The common filters must not become hard to find: the panel shows them all at once, grouped,
  not behind a search or a type-it-in syntax.
- The search box and its search by meaning must not move behind a click.

## Approaches considered

- **A. Filters button + panel + chips (chosen), together with C.** The bar keeps Sort, Stack similar, search and a
  "Filters" button with a count of the filters that are on. The button opens a panel with the
  filters in groups. When the grid is filtered a second row shows chips and the count. Two clicks
  for a filter, but every filter is visible in one place and the bar never grows.
- B. "+ Add filter" menu (Notion/Linear style): each filter is added as a chip with its own small
  editor. Least room, scales to dozens, but the filters can't be seen until looked for and quick
  toggles take more clicks.
- **C. Query words in the search field (chosen as well, by the user).** `star:yes shape:portrait lake`
  in the search box. Fast for people who know it; a line of examples under the box teaches it, and
  the panel stays for everyone else. No autocomplete in this change.
- A left side panel (Lightroom style) was dropped: the preview pane already takes the right side.

## Design

### Bar (always shown when a folder is open)

```
[Sort: Date ▾] [☐ Stack similar] [🔍 Search descriptions…      ] [Filters · 3 ▾]      2,140 photos
```

- Sort and Stack similar change how the grid looks, not which photos pass, so they stay in the bar.
- The search box stays in the bar (it also runs the search by meaning). Under it, a line of small
  muted text with examples: `Try  star:yes  shape:portrait  from:2024-06-01  has:people  tag:lake`.
- "Filters" shows how many filters (other than the search text) are on, e.g. "Filters · 3".
- While nothing is filtered the bar's right end says "2,140 photos" as today.

### Panel

A popover under the Filters button (`role="dialog"`, labelled "Filters"), so the review keys
(F, H, E, arrows) ignore keys typed in it. It stays open while filters are changed; Esc, the
button again, or a click outside closes it. Groups, each with today's controls and labels:

| Group | Controls |
|---|---|
| Photo | Stars, Shape, Hidden |
| When | From, To |
| Where | Folder (only when there are subfolders), Has location |
| Content | Has people, keyword/object chips that are on |
| Quality | Low quality, Near-duplicates |

### Filtered row (only when any filter, the search text included, is on)

```
★ Starred ×   Portrait ×   2024-06-01 → 2024-06-09 ×   lake ×        Showing 312 of 2,140 · [Clear filter]
```

- One chip per filter that is on; × clears just that filter. Chip text (my calls):
  Starred / Not starred; Portrait / Landscape; dates "From 2024-06-01", "Until 2024-06-09" or
  "2024-06-01 → 2024-06-09" (one chip, × clears both); "Hidden shown" / "Only hidden";
  folder name or "Top folder"; Has location; Has people; Low quality; Near-duplicates; each
  keyword/object by its value, × named "Remove filter <value>" as today.
- The search text gets no chip: it is already in the search box. It still counts as filtered.
- Chip and × names must not contain a control's label word ("Shape", "Hidden" …) to keep
  `getByLabel` in tests unambiguous; × buttons are named "Remove filter <chip text>".
- "Showing X of Y": X is the photos that pass the filter with stacks unfolded
  (`useFilteredItems`, matches by meaning included), Y every photo in the folder. So with
  Stack similar on, X still counts photos, not tiles.
- "Clear filter" clears every filter and the search text (`clearFilter`, as today's Clear).

### Query words in the search box

- A word of the form `key:value` that names a known filter is a filter, not search text. When the
  user presses Enter, or types a space after such a word, it is taken out of the box and set as
  that filter (so it shows as a chip and in the panel). One source of truth: the filter state;
  the box holds only the free text, which is the search text as today.
- Words (my calls): `star:yes|no`, `shape:portrait|landscape`, `from:YYYY-MM-DD`,
  `to:YYYY-MM-DD`, `hidden:show|only`, `folder:<name>` (`folder:top` for the top folder),
  `has:location`, `has:people`, `is:lowquality`, `is:duplicate`, `tag:<word>` (keyword) and
  `object:<word>`. Keys are case-insensitive; a value with spaces is quoted (`folder:"Day 2"`).
- A word that looks like `key:value` but names no filter or has a value the filter doesn't take
  (`star:maybe`, `from:june`) stays in the box as search text, and the line under the box says
  why in place of the examples (e.g. `"star:maybe" isn't a filter: try star:yes or star:no`).
- Each entry in the list of filters (below) gives its words, so a new filter gets its query word
  in the same place as its chip and panel control, and the examples line can be built from it.

### One list of filters

A pure list in `photo-tool/core/galleryFilters.ts`: each entry names the `GalleryFilter` keys it
owns, its panel group, its chip text (or none when off) and the patch that clears it.
`isFilterActive` and the chips are worked out from it. A Vitest test fails when a
`GalleryFilter` key belongs to no entry, so a new filter can't be added without its chip and
panel place.

### Left to the builder

Exact styling (matching the existing `gallery-chip`, `btn` and panel looks in `gallery.css`),
popover placement, and the e2e test updates (tests that use Hidden or Shape open the panel first).
`store.ts`, `WhatsInIt.tsx` and `Details.tsx` are not changed.
