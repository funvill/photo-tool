Photo Tool: preload 20 ahead / 5 back from one shared image cache (#5, phase 1)

Part of #5

## What this does

Phase 1 of #5. The viewer and the preview pane now step through photos from one shared cache of decoded images. Phases 2 and 3 (the server and large albums) come later.

- **`photo-tool/core/preloadWindow.ts`** (pure). `preloadOrder(index, count, { ahead: 20, behind: 5, direction })` gives the places to load in priority order: the next 3, the previous 1, the rest of the 20 ahead, then the rest of the 5 behind. After a step back, ahead and behind swap. Short lists and both ends of the list are handled. It replaces `viewerNeighbours`, which loaded two each way without decoding them. `pathIndex(list)` maps each path to its place, built once per list through a `WeakMap`, and replaces `findIndex`/`find` in the Viewer, the Preview and the grid.
- **`photo-tool/web/imageCache.ts`**:
  - One cache, keyed by URL, holding `HTMLImageElement`s that have been `decode()`d.
  - At most 4 loads run at once, under Chrome's 6 connections per host. The most wanted photo may start as a 5th, so the photo on screen never waits behind preloads.
  - `fetchPriority` is `high` for the first photo and `low` for the rest.
  - Each `want(urls)` call reorders the queue and cancels loads that are no longer wanted (`src = ''`). Holding an arrow key down never piles up stale loads.
  - LRU eviction past 40 decoded images. A photo that is still wanted is never evicted.
  - A failed URL is not asked for again for 15 s, then it is tried again. A passing server error does not stick. If `decode()` rejects on an image that has pixels, the image is still shown.
  - `load(url, signal)` pins the photo on screen so it keeps loading whatever `want()` says. When that photo is stepped past, the signal lets it go, so a held key never leaves a trail of loads that cannot be cancelled.
  - `usePicture()` shows each photo's own picture: the decoded 1600 px one at once if it is in the cache, otherwise the photo's 400 px one until the 1600 px one has loaded. That is also the fallback when the 1600 px one is missing. The picture never belongs to a different photo from the caption and its S/F/H and Save actions.
- **Viewer**:
  - On every step it asks for the photo shown, plus `preloadOrder` around it, in the direction of the last step.
  - Each photo gets its own `<img>`. It shows the cached 1600 px picture at once, or the photo's 400 px one until then.
- **Preview**:
  - Shows from the same cache.
  - A new stage is placed from the cached picture's size on its first frame.
  - The stage measures its pane in a layout effect. Before, it measured after painting, so each new photo was drawn hidden for one frame.
- **Grid**: when the grid unmounts (map view, or another folder), it releases its window with `want([])`. While the viewer is closed, the grid warms the cache around the selected photo in grid order, the same way. The preview pane, the main way people step, now has its neighbours ready. While the viewer is open, the grid leaves the cache alone, so the two never cancel each other.

No server or store changes.

## Tests

- Vitest `photo-tool/tests/preload-window.test.ts`: the order forward and backward, other window sizes, both ends, short lists, an index out of range, and `pathIndex`.
- Vitest `photo-tool/tests/image-cache.test.ts`, using a fake `Image`: the order, the in-flight cap, the first photo going past the cap, reordering, cancelling, a held key, no repeat request, eviction (LRU, never a wanted photo), a failed load, a decode that fails, `load()` pinning and rejecting, and a `load()` that is let go then cancelled, including while a key is held.
- A second e2e holds one photo's 1600 px picture back for 4 s, then jumps past the warmed window to it: End in the preview, and 25 fast steps in the viewer. In both, the picture on screen is that photo's own (by key and alt), not the previous photo's.
- E2E `#5 fast navigation` (`photo-tool/tests/e2e/gallery.spec.ts`), on a 60-photo synthetic album with stacking off:
  - On open, photo 0 and the next 20 large pictures are requested.
  - Selecting photo 30 requests exactly photos 30–50 and 29–25, with photo 30 then photo 31 first, and the previous photo before the far end of the ones ahead.
  - A step right in the preview requests only the photo that came into the window (51), not photo 31.
  - Enter opens the viewer on 31, and a step right there requests only photo 52.
  - After the folder is read, no large picture is requested twice.
  - Against the old components the test fails: the window is never requested.
- `npm run typecheck`, `npx vitest run` (1193 passed, 5 skipped, on top of #6a) and `npx playwright test --project=photo-tool` (47 passed) pass.

## Step time, before and after

`scripts/perf-step.ts` builds the page and makes a temp album of 200 synthetic 2400×1600 JPEGs in temp data folders. It serves the album from Photo Tool's own server and drives the system Chrome. It times each step from keydown to the next photo loaded, decoded and drawn (one requestAnimationFrame later). It also reports when the page puts the new photo in.

- "Dwell" is the pause between steps.
- "Latency" is added with Chrome's network emulation.
- Each line is 30 steps; the figures are median / p90 / steps over one frame.
- "Before" is the same harness run against the old components.
- "After" is the final commit of this branch.

| Setting | Viewer before | Viewer after | Preview before | Preview after |
|---|---|---|---|---|
| dwell 250 ms | 13.2 / 17.4 ms / 4 of 30 | 10.2 / 10.7 ms / 1 of 30 | 53.5 / 60.1 ms / 30 of 30 | 22.3 / 26.9 ms / 23 of 30 |
| dwell 0 | 15.6 / 17.7 ms / 8 of 30 | 15.2 / 15.8 ms / 0 of 30 | 53.1 / 58.6 ms / 30 of 30 | 18.0 / 31.1 ms / 15 of 30 |
| dwell 250, +20 ms latency | 10.8 / 13.7 ms / 0 of 30 | 9.9 / 10.5 ms / 0 of 30 | 73.5 / 80.1 ms / 30 of 30 | 25.0 / 30.2 ms / 23 of 30 |
| dwell 0, +20 ms latency | 14.9 / 25.3 ms / 4 of 30 | 15.2 / 16.1 ms / 0 of 30 | 70.3 / 76.5 ms / 30 of 30 | 23.2 / 30.1 ms / 19 of 30 |

These figures are from localhost, where the network wait is small to start with.

- **Viewer**: the old code already preloaded two each way. The gain is mostly the decode done ahead: the slow tail and the steps over one frame go away. The added latency no longer shows.
- **Preview**: it had no preloading at all, and drops from about 53–74 ms to about 18–25 ms. The added latency no longer shows.
- **Where the preview's remaining time goes:**
  - The harness puts the new photo in after a median of about 6–8 ms in the preview and 1–6 ms in the viewer. That is React's work for the step.
  - The rest of the preview's time comes after the new photo is put in. The preview stage still mounts a fresh `<img>` for each photo, which the browser decodes and draws again. Then the harness waits for the next frame.
  - The viewer keeps one `<img>` and shows no such cost.
  - Keeping one `<img>` across photos in the preview stage (as the viewer now does), or drawing the cached image itself, is the likely next step. I did not profile it further.

## Checked by hand

Only through the harness and the e2e, which run the real built page in Chrome. The desktop app was not run.

## Decisions I made

- `preloadOrder` leaves out the photo itself. Callers put it first in `want()`, so it gets the high fetch priority.
- The most wanted photo may start past the in-flight cap. Otherwise a step during a full queue would wait behind preloads.
- While a photo's 1600 px picture loads, the photo's own 400 px picture is shown instead of holding the previous photo. A held-over frame would sit under the wrong caption.
- The cache never evicts a wanted photo. The LRU applies only to photos no longer wanted.
- The grid's warming is turned off while the viewer is open. The viewer asks for its own window, and one shared `want()` list must have one owner at a time.
- The images are shown through ordinary `<img src>`. The browser reuses the decoded image held by the cache, with no new request (the e2e checks this). No `ImageBitmap` or canvas was needed.

## Not done (later phases)

- Phases 2 and 3 of #5: the server fast paths, thumbnails on demand, the `/full` disk cache, the connection-limit check, large-album scanning, slim and incremental `/items`, cheaper selectors, and grid overscan and tile size.
- **Edited photos**: `EditedImage` still waits for its own load event before showing, so an edited photo can still flash for a frame. It needs a preload path of its own, or a cached rendered thumbnail. This matters more once #9b makes more photos edited.
- **Map view**: the grid is not shown there, so the photos next to the selected one are not warmed. The preview still shows the selected photo through the cache.
- **Memory cap**: the cap is a fixed 40 decoded images, about 400 MB at 1600 px in the worst case. It does not adapt to the screen size yet.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
