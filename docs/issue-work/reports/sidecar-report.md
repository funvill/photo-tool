# Report: album tags sidecar (Steven's direct request, no issue)

- **Worktree / branch:** `C:\Users\funvill\Documents\git\photobook_helper-sidecar`, `album-tags-sidecar`, rebased onto local `issues-integration` (3674fb9, which includes #3).
- **Commits:** `c776ce5` feat(photo-tool): keep generated tags in the album folder; `4d73474` chore: version 0.1.39. All are local and authored by SWS-Chipkin. Nothing was pushed, no PR was opened and `gh auth` was not touched.
- **PR text:** `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\sidecar-pr.md`. It covers what was built, the decisions, the tests and what is not done.

## What was built

- `shared/phototags/format.ts`:
  - `phototool-tags.json`, format `phototool-tags/1`: `photos["<file name>"].models["<model id>"] = { contentKey, description?, objects?, keywords?, madeAt }`. Unknown fields are kept, entries it can't read are skipped but kept, a newer format is refused, and badly shaped known fields are left out when the file is read.
  - Companion `phototool-tags.vectors.json` (`phototool-vectors/1`): base64 float32 little-endian embeddings, keyed the same way, each with its content key.
- `shared/phototags/store.ts` `AlbumTagsStore`:
  - Writes are debounced: 5 s of quiet, at most 60 s. They are also flushed on folder open, folder close and server close.
  - Each write is a temp file renamed over the target, with retries while busy. The file is re-read and merged before each write.
  - A read-only folder falls back to `<PHOTOINFO_FALLBACK_DIR>/phototool-tags/<sha1>.json` and goes back to the folder once it is writable, as photoinfo does.
  - A file that can't be read is never overwritten; its results stay pending.
  - A folder that has gone away is dropped quietly. The store never creates a folder and never throws from a timer (the timers are unref'd).
  - Reads are cached by file stamps, and results not yet written show in reads.
- `photo-tool/server/tagging/albumTags.ts` `AlbumTags`:
  - `sync` imports folder results into the catalogue by content key. A keywords result is imported only together with its vector.
  - A renamed photo gets its result copied under its new name.
  - Migration writes once the done catalogue rows that the folder lacks.
  - When the folder and the catalogue disagree, the folder wins.
  - `save` writes done results for every photo in the job that shows the same picture.
- Queue (`queue.ts`): tagging and Regenerate call `albumTags.save`. New `forget(keys)` drops memo entries for imported keys.
- Scanner: a 6-line `onPhoto` hook, called before each photo joins the job and on refresh.
- `app.ts`: wires it all up, flushes on open, close and shutdown, and adds an `albumTagsTiming` seam.
- README: a new "Where the tags are kept" section, plus fixes to the Regenerate and tagging text and to the "only file beside your photos" line.

## Decisions I made

1. File names and formats as above.
2. **Embeddings go in a companion file**, not in the catalogue only. The keywords come from the embedding, so a catalogue-only embedding would make CLIP re-run on every photo after a move. That would defeat the feature and break "not tagged again".
3. Only done results go to the folder. Failed results stay in the catalogue, so they are retried elsewhere.
4. **The folder wins** when it and the catalogue disagree, so a Regenerate made on another machine is not reverted. Migration writes only results the folder has no entry for. (Advisor review raised this.)
5. Results whose write failed stay pending and go out with the next flush. They are not dropped.
6. Read-only fallback files go in a `phototool-tags` subfolder of the shared photoinfo fallback folder.

## Tests

- `shared/tests/phototags.test.ts`: 24 tests covering the format and the store.
- `photo-tool/tests/gallery-album-tags.test.ts`: 10 tests covering sync, migration, the folder winning, and a broken file. One app-level test opens a seeded sidecar with a fresh data folder: zero backend calls, the tags show, and search by meaning works. I confirmed this test fails when the import hook is disabled.
- `photo-tool/tests/gallery-tagging-queue.test.ts`: 5 new tests (pass results, copies of the same picture, failed results not written, Regenerate, `forget`).
- e2e `test.describe('album tags sidecar: …')` at the end of `gallery.spec.ts`:
  - spawns its own server with `node --import tsx` on port 5931 and the fake tagger, tags the folder and Regenerates one description.
  - checks the file on disk, kills the server, deletes the data folder and restarts it.
  - the page shows the regenerated sentence (text the model never writes itself), a keyword chip, and a search-by-meaning hit.
- Results:
  - `npm run typecheck` passes.
  - `npx vitest run`: 1213 passed, 4 skipped.
  - Playwright photo-tool project, before the rebase: 41/42. The one failure was the version-label test, because I bumped package.json mid-run after the page had been built.
  - Playwright after the rebase: see the end of this report.

## Not done / concerns

- Removing a photo (`/removed`) and Tidy do not prune `phototool-tags.json`. Stale entries do no harm, since they are matched by content key.
- There is no cross-process lock. Two Photo Tools writing the same album's file at the same instant could lose one batch, but the next open's migration restores it from the catalogue.
- The shared e2e server now writes sidecars into later tests' temp trip copies, because the catalogue keeps rows by content key. This is harmless, and flushes after a folder is deleted are dropped quietly.
- Conflict on rebase: both #3 and this branch appended a block at the end of `gallery.spec.ts`. I resolved it by keeping both.

## Final run after rebase

Playwright photo-tool project: **46 passed** (6.8m), including the sidecar e2e. vitest 1213 passed / 4 skipped; typecheck clean.

# Fix round 1

Review: `sidecar-review.md`, which raised 1 Critical and 4 Important issues. Each fix had its test written first and seen failing. Commits on `album-tags-sidecar`, rebased onto `issues-integration` 4089c32 (#7 phase 1, fast and slow test sets):
- `bc4bc56` feat: keep generated tags in the album folder (rebased)
- `99a89d8` fix: the review fixes
- `366eba4` fix: open a tagged album without reading photo files (also carries the e2e `removeTrip` retry and the version)

The version is 0.1.42 (the base is 0.1.41). The base moved twice while I worked: first to f6f043d (#5), where `gallery.spec.ts` conflicted because #5 and this branch each add a describe block at the end of the file (I kept both blocks whole, #5's first), then to 4089c32 (#7), which applied cleanly.

The e2e `removeTrip` helper now retries `rmSync` (`maxRetries: 10, retryDelay: 200`). On the first full Playwright run after the rebase, the existing "#2 Regenerate" test failed in its clean-up with EPERM. A test's clean-up changes the tagging settings, which ends a tagging pass, which writes `phototool-tags.json` just as the folder is removed, and Windows refuses to remove a folder while a file in it is open. Run alone, the test passed.

The other run of that test, with `--repeat-each=3`, failed on repeats 2 and 3, and that has nothing to do with this branch. The catalogue keeps a regenerated description by content key for the life of the server, so a repeat finds the previous repeat's text. Each new Playwright run empties the data folder, so a normal run is unaffected.

## 1. Critical: large albums opened slowly

**The cause had two parts:**
- every per-photo `sync` rebuilt a map of the whole sidecar;
- every imported row was its own SQLite commit with an fsync.

**The fix:**
- `AlbumTagsStore.lookup(folder)` returns an index (by name, content key and file key) that is built once per change of the files. Stats run at most once a second during a burst, and `invalidate()` is called on every folder open. `sync` does O(1) lookups per photo.
- The catalogue now uses `PRAGMA synchronous = NORMAL` with WAL. This is SQLite's advice for WAL; the catalogue is only a cache.
- The advisor found a second hole after the first fix: every open read 32 KiB of every photo to get a file key, for the models nobody chose. Two changes close it:
  - The file key now starts with the size (`fk1:<size>:<sha1>`). A lookup reads the file only when an entry of that model has a key for that size.
  - File keys are kept in the catalogue, in a new `file_keys` table, so each file is read only once.

**Tests:**
- 5,000 per-photo syncs: one index build, under 5 s. The old code took 35 s; the test failed on time before the fix.
- 3,000 store lookups: one index build.
- A fully tagged folder of real files with file keys syncs with zero file-key reads.
- File keys come back from the catalogue on a later run.

**Bench numbers at 10,000 photos** (tags 14.6 MB, vectors 28.1 MB, two models per photo, 512-float vectors):

| Script | Before | After |
|---|---|---|
| reviewer's `bench-sync.mts 10000`, "first open" (from 500 calls, which include the one-time 43 MB index build) | ~50 ms per call, ~8 min | 558 ms for 500 calls, extrapolated to ~11 s; inflated by the index build |
| reviewer's script, "second open" (nothing to import) | ~the same as the first | 80 ms for 500 calls |
| `bench-sync-full.mts`: all 10,000 synced one by one, first open (imports 20,000 rows) | ~8 min | 3.1–4.9 s, 1 index build |
| `bench-sync-full.mts`: second open | ~8 min | 1.6–2.1 s |
| `bench-sync-full.mts` at 2,000 | ~20 s | 0.7 s first open, 0.3 s second |
| `bench-sync-real.mts`: real files with file keys, album tagged on this computer, first open / second / after a restart | — | 3.3 s / 1.6 s / 1.6 s; 0 photo files read |
| `bench-sync-real.mts`: album tagged on another computer (content keys differ), first open | — | 14.2 s (each photo's head and tail read once, 32 KiB) |
| `bench-sync-real.mts`: album tagged on another computer, after a restart | — | 1.7 s (keys come from the catalogue) |
| one flush (re-read, merge, rewrite both files) | 0.3 s | 0.3 s |

The script's "store.read alone x500" line (6 s) times `read()`, a whole-folder listing kept for tests and tools. Opening a folder no longer calls it.

The 3 s first-open figure depends on `synchronous = NORMAL`. Without it, the 20,000 imported rows cost one disk flush each, which measured 11 s for 5,000 photos in the test.

## 2. Write cadence at real model speeds

- **Defaults:**
  - write a minute after the last result;
  - at the latest 5 minutes after the first result waiting;
  - when the queue's new `onPassEnd` fires (a pass ended or paused);
  - on folder open and close;
  - on program stop.
- **Effect:** a pass over 1,000 photos at 6 s each (about 100 minutes) writes about 20 times. The README now says exactly this.
- **Tests (fake timers):** a photo every 10 s for 20 minutes gives 3–5 writes; one result is written about 60 s later; `onPassEnd` is called.

## 3. Backoff, retrying the tail, independent files

- **Each file has its own state:** pending items, timer, failure count, `retryAt`, and a blocked stamp.
- **When a write fails:** the next try comes after 30 s, doubling up to 10 min. Results that arrive in the meantime never trigger an attempt, and a flush (pass end, folder open or close) waits out the backoff too. `close()` still tries. The timer retries the tail of a pass on its own.
- **A file that can't be parsed:** it is not read again until its stamp changes, and a change overrides the backoff, so someone fixing the file is picked up at once.
- **Faster busy retries:** the busy-rename retries were cut from about 500 ms to about 200 ms of blocking.
- **Tests:**
  - busy rename: no attempts during the backoff, then an automatic retry, then a doubled wait;
  - `close()` still tries;
  - with a broken vectors file, the tags file is written once per new result and never again without one;
  - a broken tags file is not re-read.

## 4. A folder that becomes writable again (your ruling)

- **Reads and writes merge the two copies entry by entry:** the folder's result wins unless the fallback's `madeAt` is later.
- **No local path:** the `folder` field is stripped before any write to the album folder, so the album file never holds a local path. Fallback files keep it.
- **The fallback copy is deleted** after the first successful write to the folder.
- **Tests:**
  - another device's added entry is kept;
  - the folder's newer entry wins, and the fallback's newer entry wins;
  - no `folder` field is written;
  - the fallback copy is removed.
- **Not done:** the merge happens on the next write (the next new result), not on open.

## 5. A temporary read error

- **A read error is not a missing file:** errors other than ENOENT and ENOTDIR (EBUSY, EIO, EACCES and so on) become status `unreadable`. That status is cached for 10 s only, and the folder is then read again.
- **Never written over:** a file that could not be read is never written over; the write fails with backoff.
- **Tagging waits:** `AlbumTags` holds that folder's photos. `holds()` keeps the queue from tagging them, and `retryDeferred()` (called at the top of each queue loop, plus a timer 30 s after a pass ends) imports their results once the file can be read.
- **The hold has a limit:** at most 10 minutes. A file that stays unreadable must not stop tagging; the results then stay in the catalogue and the file is never written over.
- **The folder wins on write as well as on read:** a write in `put(..., 'keep')` mode (tagging, migration, copies under a new name) never replaces the folder's result for the same picture, matched by content key or file key. It only adds a missing `fileKey`. Only Regenerate uses `'replace'`. A Regenerate still waiting is not undone by a later `'keep'` result for the same picture.
- **Tests:**
  - an unreadable file is not cached;
  - a file that could not be read is never written over;
  - a regenerated folder entry is kept against fresh output, and Regenerate replaces it;
  - a same-picture match by file key counts;
  - a replaced photo is still replaced;
  - queue: photos are held and not tagged, then imported once the file can be read, and only the untagged photo is tagged;
  - the hold expires.

## The content key question: it is not stable across computers

- **How the key is made:** `contentKey` is the sha1 of the raw pixels that sharp decodes from the 1600 px thumbnail that sharp itself made. The thumbnail is rotated, resized, flattened, then encoded with mozjpeg (`scanner.ts` `contentKeyOf`, `shared/server/media.ts` `writeJpegThumb`). HEIC goes through libheif first.
- **Why that is not stable:** it depends on the resize kernel, the JPEG encoder and decoder, and libheif, all of which change with the sharp, libvips and mozjpeg versions, and may vary with CPU SIMD paths.
- **Test evidence:** the same picture encoded by mozjpeg and by the standard libjpeg path gives different content keys. The test stands in for a different build; I could not run a second machine.
- **What changed:** every result now also carries a `fileKey`. It is computed from the photo file's own bytes (size plus the first and last 16 KiB), so it is the same for a copy under another name, folder or modified time, and changes when the file does.
- **How matching works:**
  - by name and content key (fast, on this computer);
  - then by content key under another name (a renamed photo);
  - then by file key, which is read only when an entry of that size exists for that model.
- **The content key stays a hint:**
  - the folder file's `contentKey` is never rewritten to this computer's;
  - rows are imported under this computer's content key;
  - a same-picture check for "keep" uses either key.
- **Tests:**
  - the file key ignores name, folder and time and changes with the bytes;
  - a result found by file key with a foreign content key is imported, and its key in the file is left alone;
  - results written from here carry the file key.
- **Limits:** a metadata-only rewrite of the photo file (a program writing a star into the EXIF, say) changes the file key. The content key then still matches on the same computer, but another computer re-tags that photo. Entries written by the first version have no file key until this version adds it, through the "keep" rule, when it next writes that entry.

## Minor items also done

- **Temp file name:** `~$phototool-tags.json.<hex>.tmp`. The `~$` prefix and `.tmp` suffix look like the temporary files sync programs usually skip; this is not verified here, and not for iCloud.
- **Temp file handling:** the temp file is fsynced before the rename and removed on every failure path. Leftovers (including the first version's `.phototool-tags...tmp` names) are removed on the first write to that folder in each run.
- **Unreadable entries:** an entry under our photo's name that this version can't read is left alone and reported, not replaced.
- **After `close()`:** a `put` after `close()` is written at once.
- **Error message:** a busy or read-only rename now says "in use by another program, or marked read-only".

## Decisions I made (round 1)

- **File key design:** `fk1:<size>:<sha1(size, first 16 KiB, last 16 KiB)>`. The file name is left out, so renames still match.
- **Write cadence:** 60 s of quiet, at most 5 min, plus a flush at the end of every pass.
- **Backoff:** 30 s, doubling to 10 min.
- **Unreadable files:** taken as unreadable for 10 s before reading again. Photos are held for at most 10 min.
- **`PRAGMA synchronous = NORMAL` for the whole catalogue:** it covers photos, the thumbnail index, recent folders, tags and the new `file_keys` table. A power cut can lose the last few commits of this cache; they are rebuilt by a rescan and from the album folders.

## Manual check for Steven (throwaway iCloud album, never drive X:)

1. Make a new album in iCloud Photos on the Windows PC, with about 20 photos copied in (not your real ones). Wait until it shows as synced.
2. Start Photo Tool and open that album's folder. Choose both tagging models and let the pass finish.
3. In File Explorer, with hidden files shown:
   - `phototool-tags.json` and `phototool-tags.vectors.json` are beside the photos;
   - there is no `~$phototool-tags...tmp` left once the bar is gone.
4. Watch iCloud's status for a few minutes:
   - Do the two JSON files upload? Check on icloud.com or a second device.
   - Does a `~$...tmp` file ever appear on another device?
   - Does iCloud make copies such as `phototool-tags 2.json`?
5. Regenerate one description. Close the folder (this writes the file). Check its new text in `phototool-tags.json`.
6. On a second PC (or after reinstalling Photo Tool with its data folder deleted), open the same album once it has synced:
   - the tags show at once, including the regenerated sentence;
   - the bar does not tag every photo again.
7. Optional: with the album's files set to online-only and the PC offline, open it. Photo Tool should not re-tag it. It shows "waiting" until it can read the file, for at most 10 minutes.
8. Delete the throwaway album afterwards.

## Still open

- Deleting a photo, and Tidy, still do not prune `phototool-tags.json` (review Minor 1).
- A read-only album that becomes writable gets its fallback merged only on the next new result, not on open.
- How iCloud handles the two JSON files and the temp file is unverified (manual check above).

## Test results (round 1)

- `npm run typecheck`: passes.
- `npx vitest run` (#7's everyday set) on 4089c32: 966 passed, 3 skipped (73 files passed, 1 skipped). `npm run test:slow`: 299 passed, 1 skipped (10 files). So all unit tests come to 1,265 passed and 4 skipped. My three files run 96 tests in 4.4 s, so they stay in the everyday set.
- Playwright photo-tool project on 366eba4 (ports 5911 and 5912; the sidecar test's own server on 5931): 48 passed (5.9 min). No server was left running afterwards.
