# Gallery: photo score, score nudges, undo, version in the bar, no preview scroll bar

**Date:** 2026-11-24
**Builds on:** `2026-11-24-gallery-edit-and-zoom-design.md`

## Why

Steven sorts a trip's photos for the book in the gallery. A score per photo, which he can push up or
down with one key, lets him rank the album quickly and later sort by it. Undo makes fast keyboard
review safe. The version number in the bar lets him name exactly which build he is talking about.

## Goals

1. **No scroll bar on the preview**, ever — a portrait photo in a full-screen wide window included.
2. **Version** in the gallery's top bar ("v0.1.1"); the patch number in `package.json` goes up once per
   commit the agent makes.
3. **Photo score** at the top of the info pane, with a hover pop-up listing what made it; also a badge in
   each grid tile's bottom-right corner. Favourite +50, hidden −50.
4. **Up / Down** nudge the selected photo's (or every selected photo's) score by ±1, with a toast on the
   preview: green "+1 · 74", red "−1 · 72". **Left / Right** move through the photos; Up/Down no longer
   move by a grid row.
5. **Ctrl+Z** undoes the last change, newest first.

## Non-goals

- Sorting by score (later). No redo. No "is this interesting" model — cheap stand-ins only.

## Anti-goals

- Ctrl+Z in a text field stays the field's own undo.
- Undo never claims to undo what it can't: trashing photos and saving into the photo file are not in
  the undo list (the Recycle Bin is their undo).

## Approaches

One sensible way: a pure scoring function in `src/core` run in the page over the open folder's photos
(sharpness is ranked within the folder, so it needs the whole list), the manual part stored per photo in
`photoinfo.json` like the star. A server-side score was ruled out: it would need re-scoring on every
star, hide and nudge, and the page already holds everything the score needs.

## Decisions

### Score (whole number, no cap; a plain photo lands roughly 30–90)
| Line | Points |
|---|---|
| Focus | 0–35 — sharpness percentile within the open folder |
| Exposure | 0–20 — mean brightness near the middle |
| Clipping | 0 to −15 — only when more than 2 % of pixels are blown or crushed |
| Interest | 0–25 — colour variety across the 3×3 colour grid (0–10), subject off-centre towards the thirds (0–5), +5 per tagged person (most 10) |
| Size | 0–10 — megapixels (8 MP = full) |
| Weaker burst shot | −10 — a near-duplicate that is not the sharpest of its group |
| Favourite / Hidden | +50 / −50 |
| Your nudges | ±1 each (`scoreAdjust`) |

A photo the scan has not analysed yet scores from what is known and shows "–" on its badge until then.
The pop-up lists every non-zero line and the total.

### Nudges
`scoreAdjust` (integer) in the photo's `photoinfo.json` entry, written through the existing info PATCH;
0 removes the field. Toast centred on the preview for about one second. With several photos selected,
each is nudged and the toast says "+1 · 4 photos".

### Undo
A page-side stack of the last 100 changes, each holding the info fields before and after, for one or
more photos: star, hide, nudges, Edit → Done (the unsaved edit before / after), Revert to original,
fields typed in the info pane, and a Save in info-file mode. Ctrl+Z restores the "before" values through
the same PATCH (or unsaved-edit state) and toasts "Undid: hide". Keys typed in a field, dialogs, edit
mode and the viewer are left alone.

### Version
Built into the page from `package.json` (`__APP_VERSION__` define in Vite); shown after the folder
name. The desktop app's `version` is the same number.

### Preview scroll bar
Root cause and fix found while building; pinned by an e2e test with a portrait photo in a very wide
window.

## Left to the builder
File layout, exact CSS, colour-variety and thirds formulas within the ranges above, tests in the style
the gallery already uses (Vitest for pure helpers and the store, Playwright for the screen).
