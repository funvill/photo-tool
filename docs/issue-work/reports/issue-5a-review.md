# Review: issue #5, Phase 1 (5a), branch `fast-navigation`

Method: task-reviewer-prompt.md. Read the diff package once. Outside the diff I made one focused check: how `PreviewStage` and `EditedImage` use `src`, to judge the edited-photo path. Nothing was run, modified or pushed.

### Spec Compliance

- ✅ Spec compliant with the 5a brief and Phase 1 steps 1-4.
  - `preloadOrder` has direction and short lists (`photo-tool/core/preloadWindow.ts:123`). It replaces `viewerNeighbours`.
  - The cache is shared, keyed by url and decoded. It caps loads at 6 in flight, reorders and cancels, uses LRU at 40, and sets `fetchPriority`.
  - The Viewer and Preview use it with `pathIndex`. The Grid warms it.
  - There are no server or store changes.
  - The e2e checks the 20/5 window, the order, and no request on a step. The perf harness is included.
- ⚠️ Cannot verify from the diff:
  - The issue's "Done when" says a step paints in under one frame for the preview too. The report's own numbers show the preview at 18-25 ms median, with 15-23 of 30 steps over a frame. The 5a brief's done-list does not require this. The PR should say so plainly, not just "5a done".
  - Whether `img.src = ''` really cancels an in-flight request in Chrome. See Minor 3.

### Strengths

- `preloadOrder` is pure and thoroughly tested at both ends, in both directions and on short lists.
- `ImageCache` is carefully built:
  - `settle` ignores a cancelled entry (`imageCache.ts:1147`), so a late decode cannot resurrect it.
  - `loads` is kept consistent on cancel, failure and success.
  - `pinned` has reference counts and an abort path.
  - The failed set is bounded (500).
  - There are no object URLs and no unbounded maps.
- The abort-on-step-past fix (commit 5604d9f) is the right answer to the "hold the key down" pile-up.
- `useDecodedSwap` never blanks the frame. A late load of a stepped-past photo is dropped (`show` checks `gone.signal.aborted`).
- The edited-photo path still works. `PreviewStage` still hands `edit` to `EditedImage` with `src` (`Preview.tsx:166-188`). Only the stage's initial `natural` and `small` come from the cache.
- The e2e was checked against the old components, and it failed there.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

1. **A failed picture never recovers** (`imageCache.ts:1145-1158`, `:1208`).
   - `failedUrls` is only trimmed at 500 entries. `useDecodedSwap` then pins a failed url to the 400 px fallback, and `pump` never asks for it again.
   - Any transient error sticks until a reload. Examples: a server hiccup, a connection reset, a 5xx under scan load, Electron's per-host limit. Preloading raises the chance of this, because 25 low-priority requests run at once.
   - Before, `onError` retried the 1600 px picture on every mount. This is a regression, and it also makes the photo look low-res for good.
   - Fix: give failures a short TTL (about 10-30 s) or clear them on an explicit `load()` or a new `want()` after a delay.
   - Add a test with a fake clock.

2. **The caption and actions refer to a different photo than the picture on screen while the new one loads** (`Viewer.tsx:906-913`, `Preview.tsx:764-784`).
   - The picture stays on the previous photo, as intended, but `item` (name, star, hidden, details, and the keys S/F/H and Save) is already the new one.
   - A fast step past the warmed window, or a slow disk, shows photo A's picture under photo B's name. Pressing S stars B blind.
   - Before, the new photo showed blank or loading under its own name.
   - Fix: either feed the bar and the details from `shown.value`, which the hook already carries, or dim the stale picture and make it clear it is the previous one.
   - Add an e2e or hook test for "stepping past the window".

#### Minor (Nice to Have)

1. **A load can saturate the connections.**
   - `maxInFlight` 6 equals Chrome's per-host HTTP/1.1 limit (`imageCache.ts:991`).
   - The "high" load that may start past the cap becomes the 7th connection and queues behind in-flight low-priority 1600 px downloads. The grid's own lazy 400 px tiles queue there too.
   - Use 4 (the plan says 4-6) until Phase 2 step 8 settles it.
2. **Nothing releases the window when its owner goes away.** `wanted` stays set after the Grid unmounts (map view) or the folder changes, so up to 26 decoded images are held and kept loading. Call `want([])` in an unmount cleanup. The memory cap is also fixed at 40. Holding an `HTMLImageElement` does not guarantee Chrome keeps the decoded pixels (this is a risk for the issue's "no decode stall" claim), and the cap does not adapt to the screen. The report records the latter.
3. **Cancellation by `img.src = ''`** (`:1162-1167`) is not tested against a real network.
   - The unit tests use a fake image, and the e2e only counts `requestfailed` as settled.
   - Removing the attribute is the more portable form (`removeAttribute('src')`).
   - Add one e2e that steps away and asserts a `requestfailed` for an unwanted url.
4. **`useDecodedSwap` has no direct test.** The ordering, stale-drop and fallback logic is the delicate part. A test with a fake cache would also cover Important 1 and 2.
5. **Direction is inferred from index deltas** (`Grid.tsx:666-674`, `Viewer.tsx:868-870`). A scan append, filter or star that shifts the index reads as a step and can flip the direction (so the window leans the wrong way). The Viewer also writes a ref during render.
6. **Preview step time is over one frame** (`PreviewStage` remounts an `<img>` per photo, and `EditedImage` waits for its own load). The report discloses this, and it is the first thing to fix in 5b or later. Edited photos are not preloaded, and an edited photo waits twice (the cache first, then `EditedImage`).
7. **The Map view does not warm the cache.** This is disclosed in the report.

### Assessment

**Spec verdict:** ✅ Spec compliant (the preview's under-one-frame goal is not met; see the ⚠️ above).

**Task quality:** Needs fixes. This is mainly the two Important items: the failed picture that never recovers, and the caption that does not match the picture. Memory, cancellation logic, stale loads and the edited-photo path are otherwise sound.

---

## Re-review 1 (fix round, dd395e6..5655cd9)

Scope: only my 2 Important findings and the lines the fixes touch. Read the fix diff once; nothing run, modified or pushed.

### Important 1: a failed picture never recovers: FIXED

- `failedUrls` is now a `Map<url, retryAt>` with a 15 s TTL (`imageCache.ts`: `FAILED_FOR_MS`, `failed()`). `failed()` expires entries lazily, and both `load()` and `pump()` go through it, so an expired failure is asked for again on the next `want()` or `load()`.
- A persistent 404 is not hammered: `settle` records the failure before `pump()` runs, so a failed url is skipped, and it is retried at most once per 15 s and only when something calls `want()` or `load()`.
- Tests with a fake clock cover both paths (`want` and `load`). The `img()` helper now uses `findLast`, which is correct for a re-created image.
- Caveat (Minor, not blocking): `usePicture` has no retry timer. While the user stays on the same photo, a failed large picture stays on the 400 px stand-in. The retry happens on the next `want()` or `load()` after 15 s (stepping away and back, or the next grid or items change). This matches the implementer's "on a later visit".

### Important 2: caption and actions do not match the picture: FIXED

- `usePicture(large, small)` returns the photo's own large picture when it is decoded in the cache, else its own small one. It never returns another photo's picture.
- The viewer's `ViewerImage` is now keyed by `item.key`, and `alt` comes from `item`. The preview passes `item` and `edit` straight to the stage. `shown.value` is gone, so no stale item or edit can leak.
- The stale-load guard is kept: `loaded()` is skipped when `gone.signal.aborted`, and the effect cleanup aborts so the next `want()` can cancel the load.
- The new e2e holds the large picture back for 4 s and asserts that the `alt` and the `key=` in the `src` are the photo's own, for both the preview (End key) and the viewer (25 steps). That is a real test of the finding.

### In-flight cap and grid release

- The default cap is now 4 (`imageCache.ts`), under Chrome's 6 per host. This covers Minor 1.
- `Grid.tsx` adds `useEffect(() => () => imageCache.want([]), [])`. This covers Minor 2's release.
  - It is safe with the viewer: the Grid stays mounted under it.
  - It is safe in StrictMode: the effects re-run and `want` is called again.
  - It does not cancel a load pinned by a mounted picture.

### New issues in the touched lines

No new Critical or Important findings. Minor only:

1. The preview shows the 400 px stand-in, then swaps `src` to the large one. If the 400 px picture is not in the cache or the HTTP cache, `natural` starts as `null` and the stage is `visibility:hidden` until it loads (a frame or two of blank). The 1600 px load then fires `onPicture` or `onLoad` a second time and re-measures. The aspect ratio is the same, but the fit and zoom state may be recomputed. The new e2e does not assert this and I did not observe it.
2. `usePicture` reads `cache.get(large)` at render time. If the cache later drops an on-screen photo's large picture (for example a `want([])` from the Grid unmounting while the preview is still shown, then a settle that evicts), the next render falls back to the 400 px picture for a photo that was sharp. This is rare and cosmetic.
3. Still open from the first review, unchanged: Minor 3 (cancellation via `src = ''` is untested against a real network), Minor 4 (no direct hook test; the e2e now covers the stale case), Minor 5 (direction inferred from index deltas), and Minor 6 (preview step over one frame).

### Re-review verdict

Both Important findings are fixed. No new Critical or Important findings. **Task quality: Approved.**
