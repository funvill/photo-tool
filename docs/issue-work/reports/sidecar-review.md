# Review: `album-tags-sidecar` (c776ce5, 4d73474 on top of issues-integration 3674fb9)

I read the diff package once, all 14 files, and no hunk was cut off. I checked code outside the diff only for named risks, which are listed under "Checks run". Line numbers are real file lines in the worktree `C:\Users\funvill\Documents\git\photobook_helper-sidecar`.

### Spec Compliance

- ✅ Spec compliant. Every requirement in the brief has code and a test:
  - **Versioned format, keyed by file name:** `shared/phototags/format.ts:6-9` (`phototool-tags/1`, `phototool-vectors/1`), stored as `photos[<file name>].models[<model id>]`.
  - **Content key and model id with each result:** `format.ts:15-24`. The vectors carry their own `contentKey` (`format.ts:39-44`), and a vector is joined to its result only when the keys agree (`store.ts:167-170`, test `shared/tests/phototags.test.ts:309`).
  - **Unknown fields kept:**
    - at the top level (`format.ts:89`), in each entry (`store.ts:305`), and in a result while it is for the same picture (`store.ts:309-310`);
    - unreadable entries are skipped but kept (`format.ts:117-132`);
    - tests at `phototags.test.ts:54, 74, 189`.
  - **Atomic, debounced writes:** temp file plus rename (`store.ts:92-115`); 5 s of quiet, at most 60 s (`store.ts:158-159, 206-212`); the file is re-read and merged before each write (`store.ts:297-316`).
  - **Read-only fallback:** files go to `<fallback>/phototool-tags/<sha1>.json` and return to the folder once it is writable (`store.ts:318-338`). This is the same design as `shared/photoinfo/store.ts:171-192`.
  - **Imported on folder open, with no re-tagging:**
    - the scanner's `onPhoto` hook (`photo-tool/server/scanner.ts:131, 188`), `AlbumTags.sync` (`photo-tool/server/tagging/albumTags.ts:37-94`) and `TaggingQueue.forget` (`queue.ts:103`);
    - a server-level test makes zero backend calls (`photo-tool/tests/gallery-album-tags.test.ts:153`).
  - **Every write path:** the tagging pass (`queue.ts:393-396`), Regenerate #2 (`queue.ts:194-195`), and copies of the same picture (`queue.ts:344`).
  - **One-time migration from catalogue rows:** `albumTags.ts:67-71`, test `gallery-album-tags.test.ts:87`.
  - **Broken JSON never overwritten:** `store.ts:300`, `albumTags.ts:49-50`, tests `phototags.test.ts:225`, `gallery-album-tags.test.ts:128`.
  - **Shutdown flush:** `app.ts:619`.
  - **TDD, e2e, docs:** TDD evidence is in the report; the e2e is at `gallery.spec.ts:1402`; the README has a new section at `photo-tool/README.md:116`.
- ⚠️ **Cannot verify from the diff: whether the content key is the same on another computer.** This is the assumption that "tags move with the folder" rests on.
  - **How the key is made:** `contentKey` is the sha1 of the decoded pixels of a thumbnail made by sharp: rotate, resize to 1600 px, flatten, then mozjpeg quality-N JPEG (`scanner.ts:46-47`, `shared/server/media.ts:189-197`). HEIC photos first pass through the libheif decoder.
  - **Why it may differ:** nothing in the code shows these bytes are the same across CPUs (libvips picks SIMD code paths at run time), across x64 and arm64 or Windows and macOS, or across a sharp upgrade. `package.json` has `"sharp": "^0.35.5"`. The e2e proves only the same machine running the same build.
  - **What happens if the keys differ:**
    - nothing is imported, and every photo is tagged again;
    - each fresh result replaces the other machine's entry under that file name whole (`store.ts:309-310`), losing any regenerated sentence and unknown fields;
    - two PCs then overwrite each other on every pass.
  - **What to check:** hash the same photo on two different machines (ideally x64 and arm64), and before and after a sharp minor-version bump.
- ⚠️ **Cannot verify from the diff: how iCloud for Windows treats these files.** Two files would land in an iCloud Photos folder: a non-photo file, and the short-lived `.phototool-tags.json.<pid>.<hex>.tmp`. It is not known whether iCloud uploads them, ignores them, or makes conflict copies when two PCs write. Check this by hand on a throwaway iCloud album, not on drive X:.

### Strengths

- **The store copies the proven photoinfo pattern rather than inventing one.**
  - It uses the same temp-file-and-rename with busy retries, the same fallback hashing and the same load order (`store.ts:92-115, 270-272` against `shared/photoinfo/store.ts:81-85, 134-155`).
  - It adds a good `GONE_CODES` rule: a vanished folder or an unplugged drive is never created and never sent to the fallback (`store.ts:70, 328`, test `phototags.test.ts:277`).
- **Data safety on the main paths is careful:**
  - a file that can't be read, or is in a newer format, is refused and never rewritten (`format.ts:83-86`, `store.ts:300`);
  - the temp file is removed on every failure path (`store.ts:96-98, 110`);
  - a busy target becomes a write failure and is not sent to the fallback (`store.ts:111-112`);
  - results whose write failed stay pending and are not dropped (`store.ts:236-239`).
- **Splitting the embeddings into a companion file is right.** Without it, every moved album would run CLIP again. Importing a keywords result only together with its vector (`albumTags.ts:73-77`) keeps search by meaning consistent.
- **The tests are realistic.**
  - They use real temp folders and real files, not mocks.
  - The server test proves zero backend calls on a fresh data folder.
  - The e2e deletes the data folder between runs, then checks for a regenerated sentence the model could never have written itself.
- **The import boundaries hold.** `shared/phototags` imports only `node:*` and `./format`, and `photo-tool` reaches it through `../../shared/phototags` (checked against `shared/tests/boundaries.test.ts:15-33`).
- **The shutdown flush runs on both real exits:**
  - `main.ts` SIGINT/SIGTERM calls `close()`;
  - Electron's `before-quit` sends `{type:'stop'}`, which calls `closeApp()` within a 5 s grace (`shared/electron/runDesktopApp.ts:316-331`, `shared/electron/serverHost.ts:88-99`).

### Issues

#### Critical (Must Fix)

1. **Per-photo `sync` costs time in proportion to the square of the folder size, all of it on the server's main thread** (`photo-tool/server/app.ts:129`, `store.ts:165-176`, `albumTags.ts:51-55`).
   - **The cause:**
     - the scanner's `onPhoto` calls `albumTags.sync([photo])` once for each photo read;
     - each call runs `store.read(folder)`, which rebuilds a map of every result in the file and copies each one;
     - `sync` then builds a second map of every result;
     - so opening an N-photo folder does N × (results in the file) synchronous work on the event loop. That loop is the Electron utility process that answers every page request.
   - **The effect:** the scanner awaits file I/O between photos, so the loop is not frozen. Instead it is busy in slices of 10–50 ms per photo, which adds minutes of main-thread CPU to an open and delays every request during the scan.
   - **Measured** with temp folders, a seeded sidecar (two models per photo, 512-float vectors), and the real `Catalog`, `AlbumTagsStore` and `AlbumTags` (script: `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\bench-sync.mts`). The figures are orders of magnitude; repeat runs varied by about 2×.

     | Photos in folder | Sidecar size (tags / vectors) | Cost per `sync` call | Extra work per open |
     |---|---|---|---|
     | 2,000 | 2.9 MB / 5.6 MB | about 10 ms | about 20 s, on every open, even when nothing is imported |
     | 10,000 | 14.6 MB / 28.1 MB | about 50 ms | about 8 minutes |
     | 30,000 (estimate) | — | — | over an hour |

     The 30,000-photo row is extrapolated from the growth, not measured.
   - **Why it is Critical:** the target Steven named is an iCloud photos folder, which is usually one flat folder of thousands of photos. Once that folder has been tagged, every open of it goes from seconds to many minutes, with the app sluggish throughout. This makes the feature unusable on its intended folder.
   - **Fix:** build the folder's index once per folder per scan, not once per photo. Either:
     - batch the hook (sync a folder's photos together, or sync at scan end before `startJob`); or
     - cache a `Map<contentKey\0modelId, AlbumResult[]>` in `AlbumTagsStore`, keyed by the file stamp plus a pending-generation counter, and look photos up in it.

     Add a test with a few thousand seeded results.

#### Important (Should Fix)

1. **The debounce does not batch at real tagging speeds, and the README claim about it is wrong** (`store.ts:158, 227-230`, `queue.ts:393-396`, `photo-tool/README.md:135`).
   - **The cause:** the quiet window is 5 s, but the README gives about 6 s a photo for the small describe model and about 20 s for the large one (`README.md:109`). Each photo's results are put together at the end of `tag()`, so the gap between puts is longer than the window, and every photo flushes.
   - **The cost of each flush:**
     - it re-reads, re-parses and rewrites the whole tags file;
     - because each keywords result has a vector, it also rewrites the whole vectors file;
     - one flush into a 2,000-photo album measured about 0.1–0.6 s of synchronous work.
   - **The effect on cloud folders:** on iCloud or OneDrive each flush re-uploads a file that grows by about 3 KB a photo. A 2,000-photo pass uploads gigabytes in total.
   - **The wrong claim:** `README.md:135` says "a pass over 1,000 photos writes it a few dozen times, not 1,000". That is false for any pass that uses the describe model.
   - **Fix:** set the debounce from the real rate (for example 30–60 s quiet and 5 min at most, or every N results), keep the flushes on open, close and shutdown, and correct the README.
2. **A failed flush gets no backoff: every later result triggers an immediate, blocking write attempt, and the last results may never be retried** (`store.ts:184, 208, 224-225, 236-239`).
   - **The cause:**
     - after a failure, `flushFolder` keeps the items but leaves `timer = null`;
     - on the next `put`, `firstAt` is not reset, because the folder still has items;
     - so the delay is `max(0, firstAt + 60 s − now)`, which is 0 once a minute has passed.
   - **The effects:**
     - **A file that stays busy** (an iCloud or OneDrive lock, or the read-only attribute) costs a temp write plus up to 500 ms of `Atomics.wait` on the event loop for every new result (`store.ts:72, 79-81, 106-108`).
     - **A broken or newer-format tags file** is re-read for every new result.
     - **A broken vectors file** is worse:
       - the tags write succeeds, the vectors write throws, and both stay pending;
       - so `phototool-tags.json` is fully rewritten for every new result for as long as the vectors file is broken;
       - on every open, `sync` also re-puts every keywords result, because the view has no embeddings (`albumTags.ts:73-77`).
     - **When the last results of a pass fail to write,** nothing retries them until the folder is opened or closed, or the server shuts down.
   - **Fix:**
     - on failure, schedule a retry with a backoff (for example 30 s, doubling to 10 min);
     - do not flush on `put` while a backoff is pending;
     - treat a broken or newer-format file as blocked until its stamp changes;
     - add tests for a busy rename (the `rename` seam is only tested on success, `phototags.test.ts:177`) and for a broken vectors file.
3. **Plan-mandated: a stale read-only fallback is written over the folder's newer file, so generated text from another device can be lost** (`store.ts:270-272, 299-315, 333`).
   - **How it happens:**
     - while a fallback file exists, `load` prefers it, so a change another device writes to the folder's own file is ignored on read;
     - on the first writable flush, the stale fallback copy plus this machine's results is written over the folder's file.
   - **What is lost:**
     - entries the other device added meanwhile disappear (its migration writes them back later only if its catalogue still has them);
     - entries the other device changed, such as a regenerated sentence, are reverted to the fallback's old copy;
     - on that device's next open, "the folder wins" then reverts its catalogue too, so the regenerated text is gone for good.
   - **A second problem:** the fallback's `folder: "<absolute path>"` field (`store.ts:333`) is carried into the album's own file, which leaks a local path into a synced file.
   - **Why it is labelled plan-mandated:** this is exactly photoinfo's design (`shared/photoinfo/store.ts:85, 188`), and the brief says to fall back "the same way photoinfo does". It is reported as Important for Steven to decide.
   - **Fix:** when writing to the folder again, merge the fallback into the folder's current file instead of replacing it; prefer the folder's entry where both have the same content key and model, or the newer `madeAt`. Strip `folder` before any write to the folder.
4. **A transient read error makes Photo Tool tag the folder again and then overwrite the folder's results with the fresh output** (`store.ts:278-293`, `albumTags.ts:49-50`, `store.ts:309-310`).
   - **The cause:**
     - `parsed()` caches a `broken` result under the file's stamp, so a transient error keeps `sync` skipping the folder until the stamp changes or a flush clears the cache;
     - transient errors include `EBUSY` while a sync engine holds the file, and a cloud placeholder that can't be fetched while offline.
   - **What follows on a fresh data folder** (a reinstall, or a second PC):
     - every photo is tagged again, which can take hours;
     - when the file can be read again, `writeKind` merges each fresh result over the folder's entry with the same content key and model;
     - the folder's regenerated sentences and unknown fields are replaced with fresh model output.
   - **Why it matters:** this is the "offline laptop opens an iCloud album" case.
   - **Fix:**
     - do not cache a `broken` read;
     - tell a read error (try again later, and don't start tagging that folder's photos yet) apart from a parse error;
     - when writing a fresh tagging result, keep an existing folder entry for the same content key and model, so "the folder wins" applies on write as well as on read. Only Regenerate should replace it.

#### Minor (Nice to Have)

1. **Deleting a photo and Tidy leave its entry in the sidecar.** This was one of the implementer's concerns. Correctness is not affected, because entries are matched by content key. But the description and keywords of a photo the user deleted stay in a file that syncs to other devices. Consider pruning names no longer on disk at the end of a scan, or in Tidy.
2. **There is no cross-process lock.** This was one of the implementer's concerns, and I accept the trade-off: the read-merge-write window is short, and the losing side is restored from its catalogue on its next open (see Important 3 and 4 for the cases where it is not). The README could add that two PCs writing one iCloud album at once can produce sync conflict copies (`phototool-tags 2.json` or `phototool-tags-PCNAME.json`), which Photo Tool ignores.
3. **The folder's copy wins over the catalogue's.** This was one of the implementer's concerns, and I accept it as decided. One side effect: a local Regenerate whose write was lost (a crash before the flush, or a write dropped as `FolderGone`) is reverted by the older folder entry on the next open.
4. **Failed results are kept in the catalogue only.** This was one of the implementer's concerns, and the choice is correct: a failure is about this machine and should be retried elsewhere (`albumTags.ts:97-98`, test `gallery-tagging-queue.test.ts:642`).
5. **Durability and leftovers**, inherited from photoinfo:
   - there is no fsync before the rename (`store.ts:95`);
   - a crash between the write and the rename leaves a `.phototool-tags.json.<pid>.<hex>.tmp` in the album folder, which is never cleaned up and will sync;
   - after a power loss, a zero-length target counts as broken. That is safe, since it is never overwritten, but nothing is imported until it is deleted.
6. **Unreadable data under our own photo's name is replaced on write** (`store.ts:305-306`). When `photos[name]`, or its `models`, is not an object (a hand edit, or a future shape), `writeKind` replaces it with `{ models: { ours } }`. That goes against "entries it can't read are kept" for that one name. It would be safer to refuse to write that name, or to report it.
7. **Names are matched case-insensitively** (`store.ts:122`, `format.ts:164-168`), as in photoinfo. On a case-sensitive file system, `IMG.jpg` and `img.jpg` share one entry and overwrite each other. The content key keeps wrong tags from showing, but the two flip-flop.
8. **A `put` after `close()` is never written.** A Regenerate that finishes after `close()` (`queue.ts:194-195`) schedules an unref'd timer on a closed store, so its result reaches neither the folder nor the catalogue. The window is small.
9. **The module sits in `shared/` but only Photo Tool uses it** (`shared/phototags/*`). The boundary rules allow this, and it mirrors photoinfo, but the editor never reads these files.
10. **Gaps in the tests and the e2e:**
    - there is no busy-rename or retry test, no broken-vectors test, and no large-folder test;
    - the e2e defaults to port 5931 (`gallery.spec.ts:1404`), though an env override exists.
11. **A read-only target is reported as "in use by another program"** (`store.ts:106-112`). A target marked read-only fails the rename with EPERM, which is retried as if busy and then reported with this misleading message.

### Checks run

- **Risk: the cost of per-photo `sync` on huge folders.** I ran `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\bench-sync.mts` with `npx tsx` from the worktree, against the real classes, on `os.tmpdir()` folders that were removed afterwards.
  - About 10 ms per call at 2,000 photos, and about 50 ms per call at 10,000.
  - The second open of the same folder, with nothing to import, cost about the same as the first.
  - One flush took about 0.1–0.6 s at 2,000 photos and 0.3 s at 10,000.
- **Risk: does the content key stay the same across machines?** I read `scanner.ts:46-47` and `shared/server/media.ts:189-197`. The code can't settle this, so it is listed under ⚠️.
- **Risk: a photo replaced under the same name.** The new content key does not match the old entry, so nothing is imported (test `gallery-album-tags.test.ts:60`). The photo is tagged again, and its result replaces the old entry whole, dropping that entry's unknown fields (`store.ts:309-310`, test `phototags.test.ts:205`). The old vector stays, but it is never joined to the new result because the keys differ.
- **Risk: a photo renamed within the folder.** It is found by its content key. Its result is copied under the new name (`albumTags.ts:78-80`), and the old name's entry stays (test `gallery-album-tags.test.ts:66`).
- **Risk: does the fallback differ from photoinfo?** I read `shared/photoinfo/store.ts:47-85, 134-192`. It is the same design, including the fallback winning on read and the `folder` field.
- **Risk: is the flush on shutdown reached?** I read `photo-tool/server/main.ts:33-41`, `photo-tool/electron/server-host.ts`, `shared/electron/serverHost.ts:88-125` and `shared/electron/runDesktopApp.ts:316-331`.
  - `close()` runs on SIGINT/SIGTERM and on Electron's stop message.
  - The e2e's `child.kill()` skips it, since it is TerminateProcess on Windows. The test flushes first through `/tagging/close`, so the e2e is unaffected.
- **Risk: Regenerate reads `tagsFor` without `withEmbedding`** (`queue.ts:194`). `catalog.ts:167` shows this only leaves out the embedding, which the describe model does not have.
- **Risk: the import boundaries.** I read `shared/tests/boundaries.test.ts:15-33`. The new files comply.
- **Risk: replacing an existing file by rename on Windows.**
  - `renameSync` replaces an existing target.
  - A target held open without share-delete, or marked read-only, fails with EPERM or EACCES. That is retried 4 times over about 500 ms, blocking the event loop, then reported (`store.ts:106-112`).
  - Nothing is left behind, and a broken file is never touched (`store.ts:300`).

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The data-safety core is sound: atomic temp-file-and-rename, broken and newer-format files never overwritten, unknown fields kept, vanished folders never re-created. Every requirement in the brief is met and tested. But four things block approval:
- the per-photo `sync` does work in proportion to the square of the folder size, which makes the large flat iCloud folder this feature is aimed at very slow to open;
- the debounce does not batch at real describe speeds;
- failed writes get no backoff;
- two paths (a stale fallback written back, and a transient read error followed by re-tagging) can overwrite generated text another device made.

---

# Re-review 1 (fix round bc4bc56..366eba4: 99a89d8, 366eba4)

Scope: the fix diff only, read in full at 366eba4 for `shared/phototags/store.ts`, `shared/phototags/fileKey.ts` and `photo-tool/server/tagging/albumTags.ts`; the hunks for `queue.ts`, `catalog.ts`, `app.ts`, `format.ts` and the e2e helper; and the new tests. I did not re-run the suite (the report has the evidence) and touched nothing outside the worktree.

### Findings from the first review

| Finding | Status | Evidence |
|---|---|---|
| **Critical: per-photo `sync` quadratic** | ✅ Fixed | `store.lookup` keeps one index per folder (`store.ts:297-329, 507-565`), re-stats at most once a second (`store.ts:272, 511-518`), is dropped on flush (`store.ts:453`) and on folder open (`app.ts:274`). `sync` does O(1) `find`s per photo (`albumTags.ts:101-136`). The file key is read only when an entry of that model has a key for this file size (`store.ts:320-323`), and is cached in the catalogue (`catalog.ts` `file_keys`, `albumTags.ts:50-64`). Tests: "one index build for a whole folder…" (5,000 syncs, fails on time on the old code), "builds its index once per change…", "opening a tagged album reads no photo files", "file keys are kept in the catalogue". |
| **Important 1: debounce does not batch** | ✅ Fixed | 60 s quiet / 5 min max (`store.ts:289-290`), plus `onPassEnd` → `albumStore.flush()` (`app.ts:119`, `queue.ts:256-261`). README corrected. Fake-timer test "a photo every 10 s for 20 minutes…" would fail at the old 5 s window. |
| **Important 2: no backoff** | ✅ Fixed | Per-file `KindState` with `failures`/`retryAt`/`blockedStamp` (`store.ts:237-245`); non-forced flushes honour the backoff (`store.ts:424-431`); a blocked file is re-tried only when its stamp changes (`store.ts:425-427, 446`); the timer retries the tail on its own (`store.ts:400-401`). Busy-rename blocking cut to 200 ms (`store.ts:119`). Tests: busy rename with no attempts during backoff and a doubled wait; `close()` still tries; broken vectors file does not rewrite tags per result; broken tags file not re-read. |
| **Important 3: stale fallback overwrites folder (controller ruling)** | ✅ Fixed, matches the ruling | `mergeFiles` merges per photo and per model; the fallback entry wins only when its `madeAt` is strictly later (`store.ts:194-198, 207-227`). Used on read and on write (`store.ts:494-505, 581`). `folder` is stripped before every write to the album (`store.ts:620, 623`) and from the fallback's top level in the merge (`store.ts:209`). The fallback is removed after a successful folder write (`store.ts:625`). Test "merges entry by entry…" covers an added entry, a folder-newer entry, a fallback-newer entry, no `folder` field, and the fallback removed; it fails on the old wholesale overwrite. Accepted limit: the merge reaches the folder file on the next write, not on open. |
| **Important 4: transient read error → re-tag and overwrite** | ✅ Fixed | `loadFrom` returns `unreadable` for anything but ENOENT/ENOTDIR (`store.ts:479-485`), cached 10 s only (`store.ts:512, 523`); a write refuses it (`store.ts:583`). `AlbumTags` holds the folder's photos (`albumTags.ts:86-91, 143-149`), the queue skips held photos and retries (`queue.ts:304, 355-360`, timer `queue.ts:270-277`), capped at 10 min. "Keep" mode means fresh output never replaces the folder's entry for the same picture (`store.ts:596-600`); only Regenerate passes `'replace'` (`queue.ts:208`). Tests: "is not cached", "never written over", "keeps a regenerated… entry; Regenerate replaces it", "same picture by file key counts", "a replaced photo is still replaced", queue hold/import test, hold expiry. |
| **⚠️ Content key not stable across computers** | ✅ Mitigated; a residual remains (Minor R5) | The implementer confirmed the key is build-dependent (mozjpeg vs libjpeg test). Each result now carries `fileKey = fk1:<size>:sha1(size, first 16 KiB, last 16 KiB)` (`fileKey.ts:13-37`), which matches across computers when the bytes are the same. The folder's `contentKey` is never rewritten. |

### The questions asked

- **Data loss: concurrent write, crash mid-write, two instances.**
  - Within one process every read-merge-write is synchronous, and items are removed only if unchanged since the snapshot (`store.ts:435-438`), so nothing is lost there.
  - A crash mid-write: the temp file is fsynced, then renamed (`store.ts:144-173`). A crash leaves the old target intact plus a `~$…tmp`, which the next run removes (`store.ts:568-577`). The directory is not fsynced; that is Minor.
  - Two instances: unchanged from round 0 (accepted Minor 2). The re-read before each write keeps the window short. `cleanUp` can delete the other instance's in-flight temp file; its rename then fails with ENOENT, which becomes a `WriteFailed` with backoff, not a loss.
  - Fallback removal happens only after the merged write to the folder succeeded, per file kind (`store.ts:623-625`).
- **Opening without reading photo files: could tags land on the wrong photo?** No realistic path.
  - `find` order (`store.ts:304-327`): a pending item by name and content key; then the name with the same content key; then the content key under any name (a rename or a copy, which is the same picture); then the file key.
  - The file key is size + head + tail, not size + mtime, and it ignores the file name. A replaced file with the same name has different bytes, so it gets a new key and no match (test "a replaced photo is still replaced"). A renamed file keeps its key, which is the intended match.
  - A false match needs two different files with byte-identical size and identical first and last 16 KiB. Only JPEG, PNG, WebP and HEIC are supported (`shared/core/mediaFormats.ts:36-49`). All are compressed, and their head holds EXIF, so this is negligible.
  - The catalogue's cached file key is keyed by path, size and mtime (`catalog.ts` `fileKey`). A different file with the same path, the same exact size and the same mtime would reuse a stale key. The scanner's content-key cache already has that exposure, so this is not new.
- **The `removeTrip` retry** (`gallery.spec.ts:35`). It does not hide real failures. `rmSync` retries only EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM, for about 11 s in total (200 ms × 1..10), then throws. The race it covers is real and benign: an `onPassEnd` flush writes into a folder being deleted. A write into a deleted folder ends as `FolderGone` and never re-creates the folder (`atomicWrite` opens the temp file without mkdir; only the fallback dir is created).

### New issues

No new Critical or Important issues.

#### Minor (Nice to Have)

1. **R1: held folders are never released when the job changes** (`albumTags.ts:43, 160-164`, `queue.ts:355-360`). `deferred` is cleared only when the folder becomes readable. After the user opens another folder, `hasDeferred()` stays true. Each queue step then re-syncs the old folder (it is re-read every 10 s) and resets `cursor = 0` (`queue.ts:360`), so `next()` scans from the start for every photo. The CPU cost is small next to model time, but it is wasted. Clear `deferred` on `clearJob`/folder open, and reset the cursor only when `retryDeferred` changed something.
2. **R2: pending "keep" items shadow the folder's entry in reads** (`store.ts:308-313, 336-340`). `find` and `read` return a waiting item ahead of the file even when `writeKind` will drop it, because the folder's entry is the same picture. This only matters while a write is backing off (open flushes first), and it corrects itself after the write.
3. **R3: a Regenerate now waits up to 60 s before it is written** (`store.ts:289, 400`). If the server is killed or crashes in that window, the next open makes the older folder entry win, and the regenerated text is lost. The window was 5 s before. Round 0 Minor 3 accepted the behaviour, but the window is now wider. `PRAGMA synchronous = NORMAL` (`catalog.ts:92`) adds a power-cut window to the catalogue copy. Consider flushing `'replace'` puts at once.
4. **R4: migrated results are stamped `madeAt = now`** (`albumTags.ts:178-180`, `store.ts:352`), not with the catalogue's `made_at`. In the fallback merge (`store.ts:223`), an old result migrated into a read-only folder's fallback can look newer than another device's entry under the same name. This bites only when the two entries are for different bytes (see R5).
5. **R5: what is left of the ⚠️.** Suppose the same name holds different bytes on two computers, for example a metadata rewrite that has not synced yet. Neither key matches, and on each open each computer's migration replaces the other's entry (`albumTags.ts:111-114`, `store.ts:596-603`). Each catalogue keeps its own copy, so nothing is lost for good, but the file churns while the bytes differ. The report documents this limit. This is acceptable.

### Assessment

**Task quality:** Ready to merge. All five findings are fixed and the ⚠️ is mitigated, each with a test that targets the old behaviour. The fallback merge follows the controller's ruling: per entry, the newer wins, and no absolute path is written into the album. The remaining items are Minor. The iCloud manual check is still open.
