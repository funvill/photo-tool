# Issue #5a report: preload window and shared image cache (Phase 1)

**Status:** done; local only, nothing pushed.

- **Branch:** `fast-navigation`, in the worktree `C:\Users\funvill\Documents\git\photobook_helper-nav`.
- **Base:** rebased onto the local `issues-integration` (3674fb9, which includes #3).
- **Final commit:** `78a36f6`, after fix round 1 (see the end).
- **Version:** 0.1.40. That is the integration branch's 0.1.39 (3064692), bumped once in a final commit.

## Commits (on top of issues-integration)

1. `e7df930` feat: `preloadOrder` and `pathIndex` (`photo-tool/core/preloadWindow.ts`), with their tests.
2. `043148f` feat: the shared image cache (`photo-tool/web/imageCache.ts`) and the `useDecodedSwap` hook, with their tests.
3. `e449f2d` feat: the Viewer and Preview use the cache, and the Grid warms it. `viewerNeighbours` is removed, with its test.
4. `4e85014` test: the e2e `#5 fast navigation` block and the harness `scripts/perf-step.ts`.
5. `1cf00b2` fix: the preview stage measures its pane in a layout effect. Before, it was drawn hidden for one frame on each new photo.
6. `5604d9f` fix, and the version:
   - `load()` takes an `AbortSignal`, and `useDecodedSwap` lets go of the photo on screen when it is stepped past.
   - Before, holding a key past the warmed photos queued one uncancellable high-priority load per photo. The advisor's review caught it.
   - The harness now reports when the new photo is put in, as well as the total.
   - The commit also sets the version to 0.1.39.

## Files

- **New:**
  - `photo-tool/core/preloadWindow.ts`
  - `photo-tool/web/imageCache.ts`
  - `photo-tool/tests/preload-window.test.ts`
  - `photo-tool/tests/image-cache.test.ts`
  - `scripts/perf-step.ts`
- **Changed:**
  - `photo-tool/core/galleryViewer.ts` (`viewerNeighbours` removed)
  - `photo-tool/tests/gallery-viewer.test.ts`
  - `photo-tool/web/components/Viewer.tsx`
  - `Preview.tsx`
  - `Grid.tsx`
  - `usePreviewZoom.ts`
  - `photo-tool/tests/e2e/gallery.spec.ts` (a new describe block at the end only)
- **Not touched:** no server or store changes, and nothing in `shared/`, `FilterBar` or the CSS.

## Tests

- `npm run typecheck`: clean.
- `npx vitest run`: 1198 passed, 4 skipped.
- `npx playwright test --project=photo-tool` on ports 5751/5752: 46 passed. That includes #2's and #3's blocks after the rebase.

## How the e2e works

- **Album and request log:**
  - It builds a 60-photo synthetic album with sharp, imported dynamically so the import header stays untouched for #6.
  - Stacking is turned off.
  - The grid order is read from the tiles.
  - Every `size=m` request is logged with `page.on('request')`, from before the page loads.
- **On open:** photos 0–20 are requested.
- **Selecting photo 30:** the requests are exactly 30–50 and 29–25. Photo 30 then photo 31 come first, and photo 29 comes before photo 40.
- **A step right in the preview:**
  - Only photo 51 is requested.
  - The preview `src` is photo 31's `m` URL.
  - Reusing the cached image produces no request event.
- **The viewer:** Enter opens it on photo 31, and a step right there requests only photo 52.
- **No repeats:** no URL is requested twice after the folder is read.
- **Checked against the old code:** I stashed the component changes and ran the test against the old components. It failed, as expected.

## Step-time numbers (scripts/perf-step.ts, 200 photos, 30 steps)

The figures are median / p90 / steps over one frame. The time runs from keydown to the next photo loaded, decoded and drawn. "Before" is the same harness run against the old components (stashed). "After" is the final commit.

| Setting | Viewer before | Viewer after | Preview before | Preview after |
|---|---|---|---|---|
| dwell 250 | 13.2 / 17.4 / 4 | 10.2 / 10.7 / 1 | 53.5 / 60.1 / 30 | 22.3 / 26.9 / 23 |
| dwell 0 | 15.6 / 17.7 / 8 | 15.2 / 15.8 / 0 | 53.1 / 58.6 / 30 | 18.0 / 31.1 / 15 |
| dwell 250, +20 ms latency | 10.8 / 13.7 / 0 | 9.9 / 10.5 / 0 | 73.5 / 80.1 / 30 | 25.0 / 30.2 / 23 |
| dwell 0, +20 ms latency | 14.9 / 25.3 / 4 | 15.2 / 16.1 / 0 | 70.3 / 76.5 / 30 | 23.2 / 30.1 / 19 |

- **When the new photo is put in:** a median of 6–8 ms in the preview and 1–6 ms in the viewer.
- **Raw output:**
  - before: `scratchpad/5a-perf-before.txt`
  - after: `scratchpad/5a-perf-after.txt`
- **The harness changed:**
  - The first baseline run used a version without `decode()` in the measurement. Its numbers were replaced by the decode-aware rerun.
  - The time when the new photo is put in was added at the end, so the "before" run has no such figure.

## Decisions made

- `preloadOrder` leaves out the photo itself. Callers put it first in `want()`.
- The most wanted photo may start past the cap of 6.
- A wanted photo is never evicted.
- The grid's warming is off while the viewer is open, so there is one owner of `want()` at a time.
- Images are shown through a plain `<img src>`, reusing the decoded image held by the cache. There is no `ImageBitmap` or canvas.

## Concerns

- **The preview still takes about 18–25 ms per step,** over one frame in most steps.
  - The new photo is put in after about 7 ms.
  - The rest comes after that: the preview stage mounts a fresh `<img>` for each photo, which is decoded and drawn again.
  - The viewer keeps one `<img>` and is under one frame.
  - So the "under one frame" goal from the issue is met for the viewer but not yet for the preview.
  - The next step would be keeping one `<img>` across photos in the preview stage. I did not profile it further.
- **A failed picture is remembered for the whole session.**
  - Before, `<img onError>` tried the 1600 px picture again on every mount; now a photo whose 1600 px picture failed stays on the 400 px fallback until the page reloads.
  - I checked `scanner.ts`: a photo is listed only after its thumbnails are written, so a normal 404 during a scan should not happen. A passing server error would still stick, though.
- **Edited photos** (`EditedImage`) still wait for their own load event. A preload path for them, or a cached rendered thumbnail, is needed in 5b or 5d.
- **Map view** does not warm the cache.
- **The memory cap** is a fixed 40 images and does not adapt to the screen.
- **Intermediate version numbers:** the `package.json` versions in the intermediate commits after the rebase are whatever the automatic merge left. Only the final commit's version is meaningful.
- **Servers:** every server the harness and Playwright started was stopped. No ports 5751, 5752 or 5790 are left listening.

## Fix round 1 (review in issue-5a-review.md)

**Base:** rebased onto local `issues-integration` at 3064692, which includes #6a.

- The plain rebase had recorded Steven as committer. I re-ran it with `-f` and the SWS-Chipkin identity, so every commit's author and committer is SWS-Chipkin.
- The version is integration's 0.1.39, bumped once in the final commit to 0.1.40.

**New commits:**

1. `8956072` fix: a failed picture is tried again after 15 seconds.
   - `failedUrls` is now a map from URL to expiry time (`FAILED_FOR_MS` = 15 s), with an injectable clock.
   - `failed()`, `pump()` and `load()` all respect the expiry.
   - Failing tests first:
     - with a fake clock, a failure blocks a request within 15 s and asks again after it;
     - `load()` of an expired failure loads again.
   - Minor 1: the default in-flight cap is now 4 instead of 6.
2. `5655cd9` fix: the picture on screen always belongs to the named photo.
   - `useDecodedSwap` (hold the previous frame) is replaced by `usePicture(large, small)`. It returns the decoded 1600 px URL when that is cached; otherwise it returns the photo's own 400 px URL and swaps in the 1600 px one once it has loaded.
   - The stale-load guard is kept: the hook aborts its `load()` on cleanup, and a late result is dropped.
   - The Viewer gives each photo its own `<img>` (`key={item.key}`). The Preview stage takes `picture` and `large` props.
   - The Preview no longer fetches `/full` for the 400 px stand-in at zoom 1.
   - Minor 2: the Grid calls `want([])` when it unmounts.
   - Failing e2e first, "stepping past the photos loaded ahead never shows one photo's picture under another's name":
     - it uses `page.route` to hold one photo's 1600 px picture back for 4 s;
     - it presses End in the preview, and makes 25 fast steps in the viewer;
     - in both, the picture's key and alt must be that photo's.
     - Before the fix it failed with caption n39 over picture n00.
3. `78a36f6` chore: version 0.1.40.

**Tests:**
- `npm run typecheck`: clean.
- `npx vitest run`: 1193 passed, 5 skipped. The total changed with #6a.
- `npx playwright test --project=photo-tool` on 5751/5752: 47 passed.

**Step time after the fix** (dwell 250, 200 photos):

| | Median | p90 | Steps over one frame | New photo put in after (median) |
|---|---|---|---|---|
| Viewer | 10.2 ms | 10.6 ms | 0 of 30 | 1.0 ms |
| Preview | 23.5 ms | 27.7 ms | 23 of 30 | 6.3 ms |

These are unchanged from before the fix, because inside the warmed window the cached 1600 px picture still shows at once.

**Minors not done:**
- 3: real-network cancel test, and `removeAttribute`.
- 4: a direct test for the hook. The new e2e covers its behaviour.
- 5: direction inferred from index changes.
- 6: the preview takes over one frame per step.
- 7: map warming.

**Trade-off of the fix:** stepping onto a photo whose 1600 px picture is not loaded yet now shows its 400 px picture for a moment, where before it held the previous photo's picture.
