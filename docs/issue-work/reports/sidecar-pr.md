Photo Tool: keep generated descriptions, keywords and objects in the album folder

Steven asked for this directly (there is no issue): "Where are the generated descriptions and keywords, and objects stored? they should be stored in the same folder as the photos so they migrate with the folder." Until now they lived only in Photo Tool's catalogue (`gallery.sqlite` in its data folder), so a reinstall lost them. Now each album folder has its own `phototool-tags.json`, and the catalogue is only a cache of it. `photoinfo.json` is unchanged and stays for what people type (stars, people, notes).

## What was built

- **`shared/phototags/format.ts`**: the versioned format `phototool-tags/1`.
  - Photos are keyed by file name, as in `photoinfo.json`. Each photo has `models: { "<model id>": { contentKey, fileKey, description?, objects?, keywords?, madeAt } }`.
  - Unknown fields are kept at every level.
  - Entries it can't read are kept and skipped; an entry under our photo's name that it can't read is left alone, not replaced.
  - A file with another format string is never rewritten.
- **Two fingerprints per result.**
  - `contentKey` hashes the thumbnail that sharp made on this computer. That depends on the sharp, libvips and mozjpeg build, and a test shows two JPEG encoders giving different keys for the same picture. So it is used only as a fast first check.
  - `fileKey` (`shared/phototags/fileKey.ts`, `fk1:<size>:<sha1 of the size and the first and last 16 KiB>`) comes from the photo file's own bytes, so it matches on any computer.
  - Matching order: name and content key, then content key under another name (a renamed photo), then file key. The file key is read only when an entry of that size exists for that model, and is kept in the catalogue (a new `file_keys` table) so each file is read once.
- **Embeddings** go in a companion file, `phototool-tags.vectors.json` (`phototool-vectors/1`, base64 float32, about 3 KB a photo). Keeping them only in the catalogue would make the keywords model run on every photo again after a move or reinstall. A keywords result found without its vector is not imported, so the model redoes both.
- **`shared/phototags/store.ts`** (`AlbumTagsStore`):
  - **Lookups:** a per-folder index (by name, content key and file key), built once per change of the files. `invalidate()` runs on every folder open.
  - **Write cadence:** a minute after the last result, at most 5 minutes after the first result waiting, when a tagging pass ends or pauses, on folder open and close, and when the program stops.
  - **Writes:** each file is written independently, through an fsynced temp file named `~$phototool-tags.json.<hex>.tmp` that is then renamed. Leftover temp files are removed on the next write.
  - **Failed writes:** retried after 30 s, doubling to 10 min. A file that can't be parsed is not tried again until it changes.
  - **Read errors** (locked, offline) are not taken as "no file": the file is never written over, and it is read again 10 s later.
  - **The folder wins:** a new tagging result never replaces the folder's result for the same picture; only Regenerate does.
  - **Read-only folders** fall back to `<shared photoinfo fallback>/phototool-tags/<sha1>.json`. Reads, and the first write once the folder is writable again, merge the two copies entry by entry: the folder's entry wins unless the fallback's is newer. The fallback copy is then removed, and the album's own file never gets a local path.
- **`photo-tool/server/tagging/albumTags.ts`** (`AlbumTags`):
  - `sync` runs as each photo is read (a new `onPhoto` hook in the scanner), with O(1) lookups. Folder results come into the catalogue under this computer's content key before tagging starts, and a renamed photo gets its result under its new name too.
  - Migration: done results the catalogue has but the folder lacks are written out once.
  - Photos of a folder whose file can't be read just now are held back from tagging (for at most 10 minutes) and imported when it can be read.
  - `save` writes each new done result for every photo of that picture.
- **Queue**:
  - tagging saves in `'keep'` mode, and Regenerate saves in `'replace'` mode;
  - `forget(keys)`, `onPassEnd`, and held photos skipped and retried.
- **`app.ts`**: wires the store and coordinator together, and flushes on folder open, close, pass end and shutdown. **`catalog.ts`**: `synchronous = NORMAL` (WAL) and the `file_keys` table. **Scanner**: a 6-line hook.
- **README**: a new "Where the tags are kept" section.

## Decisions I made

- File names and formats: `phototool-tags.json` (`phototool-tags/1`) and `phototool-tags.vectors.json` (`phototool-vectors/1`).
- Embeddings go in the companion vectors file, not in the catalogue only (reasons above).
- The `fileKey` described above, because the content key is not stable across computers. The content key in the folder file is never rewritten.
- Only done results go to the folder. Failed results stay in the catalogue, so they are retried when the album is opened elsewhere.
- The folder wins over the catalogue, on read and on write. Only Regenerate replaces a folder entry for the same picture.
- Timing:
  - writes: 60 s after the last result, at most every 5 min, plus a write when each pass ends;
  - failed writes: retried after 30 s, doubling to 10 min;
  - an unreadable file is read again after 10 s, and its photos are held for at most 10 min.
- Read-only fallback (Steven's ruling): the two copies are merged entry by entry by `madeAt`, the album file never gets a local path, and the fallback is removed after the merge.
- `PRAGMA synchronous = NORMAL` for the whole catalogue, which is a cache. Without it, opening a 10,000-photo album imports 20,000 rows with a disk flush each. With it, that takes about 3 s.

## Performance (10,000 photos; 14.6 MB tags file, 28.1 MB vectors file)

- First open, importing every result: about 3–5 s, down from about 8 minutes. Later opens take about 1.6 s.
- An album tagged on another computer: 14 s the first time, while each photo's 32 KiB head and tail is read once; 1.7 s after a restart.
- Opening an album tagged on this computer reads no photo files.
- One write (re-read, merge, rewrite both files) takes about 0.3 s.

## Tests

- `shared/tests/phototags.test.ts`:
  - format: parse, round-trip, unknown fields, bad JSON, wrong shape, newer format, malformed entries.
  - writes: debounce and cadence at real model speeds, atomic temp-and-rename, merging with other writers.
  - failures: backoff with a busy rename and an automatic retry of the tail, a broken vectors file not holding up the tags file, a broken file not re-read, an unreadable file neither cached nor written over.
  - read-only: fallback and an entry-by-entry merge back into the folder.
  - the folder wins against fresh output (also by file key), the index is built once for 3,000 lookups, temp-file names and cleanup, entries it can't read left alone, a `put` after `close()`.
- `photo-tool/tests/gallery-album-tags.test.ts`:
  - import by content key, a replaced picture not imported, renamed photos, keywords only with their vector, migration once, the folder wins, a broken file left alone.
  - the content key's dependence on the encoder; the file key ignoring name, folder and time; a match by file key with a foreign content key.
  - 5,000 per-photo syncs with one index build in under 5 s (the old code took 35 s); a tagged folder of real files syncing without reading a file; file keys from the catalogue on a later run; unreadable folders held, then imported; the hold expiring.
  - a server-level test where a seeded sidecar on a fresh data folder shows its tags with zero model calls.
- `photo-tool/tests/gallery-tagging-queue.test.ts`: pass results and Regenerate landing in the folder, copies of the same picture, failed results not written, `forget`, `onPassEnd`, and held photos not tagged and then imported.
- e2e `album tags sidecar: generated tags live in the album folder`:
  - starts its own server on port 5931 with the fake tagger, tags the folder, and Regenerates one description;
  - stops the server, deletes its data folder, and starts it again;
  - the page then shows the regenerated sentence, a keyword chip, and a search-by-meaning hit, all read back from the album folder.
- `npm run typecheck`, `npx vitest run` (all), and `npx playwright test --project=photo-tool` (all) pass.

## Checked by hand

Nothing beyond the automated tests and the benchmark scripts. The desktop app was not run.

How iCloud treats these files still needs a check by hand on a throwaway album:
- Do the two JSON files upload?
- Is the `~$….tmp` temp file left alone?
- Does iCloud make conflict copies?
- Does a second PC show the tags without re-tagging?

## Not done

- Removing a photo (Recycle Bin) and **Tidy photo info…** clean up `photoinfo.json` only. Entries for deleted or renamed photos stay in `phototool-tags.json`; they are matched by fingerprint and never shown for another picture.
- A read-only album that becomes writable again gets its fallback merged on the next new result, not on open.
- Photobook Editor does not read the tags file yet.
- There is no cross-process lock. Two computers writing at the same moment may produce a sync conflict copy, which Photo Tool ignores. Each computer's catalogue still holds its results and writes them again the next time it opens the folder.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
