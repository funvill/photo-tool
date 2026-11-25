# Gallery Tagging (descriptions, keywords, search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gallery downloads on-device models from Hugging Face on request, tags every photo in the background with a description, objects and keywords, shows them in the details panel as clickable chips, and finds photos by them (by word, and by meaning).

**Architecture:** Models are listed in a fixed catalogue in code (repo, pinned commit, files, SHA-256). The gallery server (Node, in Electron's utility process) downloads them into `<dataDir>/models/<id>/`, runs them in a worker thread through Transformers.js (onnxruntime-node underneath), and keeps results in its SQLite catalogue keyed by a new content key (hash of decoded pixels) and model id. The page reads compact tags with the photo list, polls tagging progress, filters by chips and asks the server for search-by-meaning matches.

**Tech Stack:** Electron 45, Node (node:sqlite, worker_threads), Express 5, sharp, `@huggingface/transformers` (new), `onnxruntime-node` (through it), React 19, zustand, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-gallery-tagging-and-faces-design.md`

**Scope:** this plan builds Goals 1–4 of the spec (models, background tagging, details panel, search). **Faces (Goal 5) is a second plan**, written after this one lands, on top of its model store, worker and queue.

## Global Constraints

- No cloud service, account, API key or subscription, ever.
- Nothing leaves the computer except a model download the person started, from Hugging Face; only `huggingface.co` and the download hosts it redirects to, only for files in the catalogue, only while that download runs. Window network guard and host rules (`electron/netGuard.ts`, `electron/mapTiles.ts`) stay as they are.
- Every model file is pinned to one commit (40-hex revision) and checked against a SHA-256 the app carries before use; a mismatch deletes the file.
- Only models licensed MIT, Apache-2.0 or BSD are offered. No InsightFace models.
- The catalogue is code (`src/core/tagModels.ts`), never fetched.
- Picture embeddings never leave the server: not in API replies to the page, not in `photoinfo.json`.
- The person's own Description and notes are never changed by the machine.
- Tagging never blocks the grid, preview, keys, saving or the folder scan; it runs one photo at a time in a worker thread with `max(1, floor(cpus / 2))` threads.
- A model that fails to load never crashes the app; the part shows "Not working" with "Download again".
- Copy fixed by the spec: confirm text `Download <model label>, <size>, from Hugging Face?`; bar text `Tagging <done> of <total>` with Pause/Resume; search note `Also matching by meaning`; details section title `What's in it`; waiting text `Not looked at yet`; off text `Tagging is off` (links to Settings).
- Version: `npm version patch --no-git-tag-version` once per commit (shown in the bar).
- Commits authored `git -c user.name="SWS-Chipkin" -c user.email="sws-dev@chipkin.com" commit`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. After each task, push to `origin` (github.com/funvill/photo-tool): `gh auth switch -u funvill`, push, `gh auth switch -u ssmethurst`.
- Never read or test with `photos/`, `data/`, `trial-output/` (private). Test photos: `fixtures/generated/trip` (run `npm run fixtures` if missing).

## Review Focus

1. **A download cut off half-way (network drop, app closed, disk full)**: the next try resumes or restarts the file; a partial or wrong file is never loaded. Test in Task 3.
2. **A photo deleted, renamed or the folder closed while it is being tagged**: no crash, no row for a photo that is gone, the queue moves on or stops. Test in Task 6.
3. **A model folder damaged after download (a file deleted by hand)**: the part shows "Not working" and offers "Download again"; tagging for that part pauses instead of failing every photo. Test in Task 5 (`installedModels` reports `ok: false`) and Task 6 (queue does not start that part).
4. **A big folder (10,000 photos)**: the photo list API stays small (tags compact, no embeddings), status polling is cheap. Test in Task 4 (item payload carries at most 12 keywords and no embedding).
5. **A one- or two-letter search or punctuation only**: word matching as today; search by meaning is not asked for under 3 letters. Test in Task 9.

---

### Task 1: Measure the candidate models (spike, gate)

Decides the catalogue values and proves Florence-2 and CLIP run in Node here. **Asks first:** downloads roughly 1–3 GB from Hugging Face into a scratch folder outside the repo; confirm with Steven before running.

**Files:**
- Create: `scripts/tagging/measure.ts` (throwaway tool, kept for re-measuring)
- Create: `docs/superpowers/notes/2026-11-24-tagging-measurements.md`
- Modify: `package.json` (add `@huggingface/transformers`, current stable release, exact version)

- [ ] **Step 1:** `npm install --save-exact @huggingface/transformers` and record the version.
- [ ] **Step 2:** Write `scripts/tagging/measure.ts`: for each candidate (`onnx-community/Florence-2-base-ft`, `onnx-community/Florence-2-large-ft`, `Xenova/clip-vit-base-patch32`, `Xenova/clip-vit-large-patch14`) and each dtype offered by the repo (fp32, fp16, q8, q4 where present), load from a cache dir given as `--cache <dir>`, run on every photo in `fixtures/generated/trip`, and print: files used and their bytes, load time, mean and max seconds per photo with `intraOpNumThreads = max(1, floor(cpus/2))`, the Florence `<MORE_DETAILED_CAPTION>` and `<OD>` outputs, and CLIP's top 12 labels from a draft vocabulary (finalised in Task 5), and the cosine similarity of a few test phrases against each photo (to pick the meaning threshold).
- [ ] **Step 3:** Run it: `npx tsx scripts/tagging/measure.ts --cache %TEMP%\photobook-models`. Expected: every model loads and produces output, or the failure is recorded.
- [ ] **Step 4:** Write the notes file: per model and dtype, total bytes, seconds/photo, output quality on the fixtures (a sentence each), the repo commit SHA (`git ls-remote https://huggingface.co/<repo> HEAD`) and each file's SHA-256 and size. Pick, per part, the *smaller* and *larger* choice (dtype included), and the keyword score threshold (the lowest score that still looked right).
- [ ] **Step 5: Gate.** If no Florence-2 variant runs in Node with the chosen Transformers.js, stop and report to Steven (the descriptions part needs another caption model). Otherwise commit (`chore: measure on-device tagging models`), bump version, push.

### Task 2: Model catalogue

**Files:**
- Create: `src/core/tagModels.ts`
- Test: `tests/tag-models.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TagPart = 'describe' | 'keywords';
  export interface ModelFile { path: string; bytes: number; sha256: string }
  export interface ModelChoice {
    id: string;                 // e.g. 'florence2-base-q8'
    part: TagPart;
    size: 'smaller' | 'larger';
    label: string;              // e.g. 'Florence-2 base'
    repo: string;               // e.g. 'onnx-community/Florence-2-base-ft'
    revision: string;           // 40-hex commit
    dtype: string;              // as passed to Transformers.js
    files: ModelFile[];
    licence: 'MIT' | 'Apache-2.0' | 'BSD-3-Clause';
    secondsPerPhoto: number;    // typical, from Task 1
    keywordThreshold?: number;  // keywords part only
    meaningThreshold?: number;  // keywords part only: lowest similarity shown by search by meaning
  }
  export const MODEL_CATALOGUE: readonly ModelChoice[];
  export const modelBytes: (m: ModelChoice) => number;
  export const findModel: (id: string) => ModelChoice | undefined;
  export const choicesFor: (part: TagPart) => ModelChoice[]; // smaller first
  ```

- [ ] **Step 1: Failing tests** `tests/tag-models.test.ts`:
  - `every choice has a 40-hex revision, files with 64-hex sha256 and positive bytes` 
  - `ids are unique; each part has exactly one smaller and one larger choice; keywords choices have keywordThreshold and meaningThreshold in (0, 1)`
  - `licences are MIT, Apache-2.0 or BSD-3-Clause; no repo under deepinsight/ or insightface`
  - `modelBytes sums file sizes; choicesFor returns smaller first; findModel('nope') is undefined`
- [ ] **Step 2:** `npx vitest run tests/tag-models.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Write `src/core/tagModels.ts` with the four entries from Task 1's notes.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(gallery): model catalogue for on-device tagging`, bump, push.

### Task 3: Download, store and remove models

**Files:**
- Create: `src/gallery/server/models/store.ts`, `src/gallery/server/models/download.ts`
- Modify: `src/gallery/server/app.ts` (routes), `electron/gallery.ts:16` (`GALLERY_DESCRIPTION`), `README.md` (gallery network sentence)
- Test: `tests/gallery-models.test.ts`

**Interfaces:**
- Consumes: Task 2's `ModelChoice`, `findModel`, `MODEL_CATALOGUE`.
- Produces:
  ```ts
  // store.ts
  export const modelDir: (dataDir: string, id: string) => string;            // <dataDir>/models/<id>
  export interface InstalledModel { id: string; bytes: number; ok: boolean } // ok: every file present with the catalogue size
  export function installedModels(dataDir: string): InstalledModel[];
  export function removeModel(dataDir: string, id: string): void;
  export interface TaggingSettings { describe: string | null; keywords: string | null; paused: boolean }
  export function readTaggingSettings(dataDir: string): TaggingSettings;  // <dataDir>/tagging.json; defaults all null/false
  export function writeTaggingSettings(dataDir: string, s: TaggingSettings): void;
  // download.ts
  export const isAllowedModelUrl: (url: string) => boolean; // https, default port, host huggingface.co or ending .huggingface.co / .hf.co
  export interface DownloadProgress { id: string; received: number; total: number }
  export function downloadModel(dataDir: string, m: ModelChoice, opts: { fetch?: typeof fetch; signal?: AbortSignal; onProgress?(p: DownloadProgress): void }): Promise<void>;
  ```
  URL: `https://huggingface.co/<repo>/resolve/<revision>/<path>`; redirects followed by hand (`redirect: 'manual'`), each hop checked with `isAllowedModelUrl`; writes `<file>.part`, resumes with `Range: bytes=<size>-` when the part exists, checks SHA-256 and size, renames into place; on mismatch deletes the part and throws.
- Routes (all JSON):
  - `GET /api/gallery/models` → `{ catalogue: ModelChoice[]; installed: InstalledModel[]; settings: TaggingSettings; downloading: DownloadProgress | null; error: string | null }`
  - `POST /api/gallery/models/:id/download` → 202; 404 for an id not in the catalogue; 409 while another download runs
  - `POST /api/gallery/models/download/cancel` → 204
  - `DELETE /api/gallery/models/:id` → 204 (clears the setting if it pointed there)
  - `PUT /api/gallery/tagging/settings` body `TaggingSettings` → 200; 400 for an id not installed or of the wrong part
- `createGalleryApp(dataDir, opts)` gains `opts.tagging?: { fetch?: typeof fetch; catalogue?: readonly ModelChoice[]; backend?: TaggerBackend }` (seams for tests; `TaggerBackend` from Task 7). `src/gallery/server/main.ts` (dev/e2e entry only, never `electron/server-host.ts`) passes a fake catalogue, fetch and backend when `PHOTOBOOK_GALLERY_FAKE_TAGGING=1`, from `tests/support/fakeTagging.ts` (created here: a two-file fake model per part served from memory).

- [ ] **Step 1: Failing tests** in `tests/gallery-models.test.ts` (fake fetch serving bytes, with Range support and a redirect):
  - `isAllowedModelUrl accepts huggingface.co and cdn hosts, refuses http, other hosts, ports and userinfo`
  - `downloads every file into models/<id>, checks sha256, reports progress up to the total`
  - `resumes a .part file with a Range request` (Review Focus 1)
  - `a file whose sha256 does not match is deleted and the download fails; nothing is installed` (Review Focus 1)
  - `a redirect to a host not allowed is refused`
  - `cancel stops it and leaves no finished file`
  - `installedModels says ok false when a file is missing or the wrong size` (Review Focus 3)
  - `routes: 404 for an unknown id, 409 for a second download, settings refuse a model not installed, DELETE clears the setting`
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `store.ts`, `download.ts`, the routes; `GALLERY_DESCRIPTION` becomes `'… Uses the network only for map tiles (if you choose Load maps) and to download photo-tagging models you ask for.'`; same sentence in README's gallery section.
- [ ] **Step 4:** `npx vitest run tests/gallery-models.test.ts` PASS; `npx tsc --noEmit -p .` clean.
- [ ] **Step 5:** Commit `feat(gallery): download photo-tagging models from Hugging Face on request`, bump, push.

### Task 4: Content key and tag storage

**Files:**
- Modify: `src/gallery/server/catalog.ts` (column `content_key`, table `tags`), `src/gallery/server/scanner.ts` (compute it), `src/gallery/server/app.ts` (items carry tags)
- Test: `tests/gallery-tags-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // scanner / catalog
  GalleryPhoto.contentKey: string | null;  // sha1 of the raw RGB pixels of the decoded 'm' thumbnail
  export async function contentKeyOf(thumbPath: string): Promise<string>;
  // catalog
  export interface TagRow { contentKey: string; modelId: string; status: 'done' | 'failed'; description: string | null;
    keywords: { label: string; score: number }[]; objects: { label: string; count: number }[]; embedding: Float32Array | null; error: string | null }
  Catalog.putTags(row: TagRow): void;
  Catalog.tagsFor(contentKeys: string[], modelIds: string[]): Map<string, TagRow[]>; // by content key
  Catalog.embeddings(contentKeys: string[], modelId: string): Map<string, Float32Array>;
  // items sent to the page (GalleryItem)
  export interface PhotoTags { state: 'off' | 'waiting' | 'done' | 'failed'; description: string | null;
    keywords: string[]; objects: { label: string; count: number }[] }
  GalleryItem.tags: PhotoTags;  // from the models chosen in TaggingSettings; no embedding, at most 12 keywords
  ```
- A cached row without `content_key` gets it computed from its existing 'm' thumbnail during the next scan (no re-decode of the original).

- [ ] **Step 1: Failing tests:**
  - `the same pixels under another name and time give the same content key`
  - `a metadata-only rewrite (sharp withMetadata exif date) keeps the key; one changed pixel changes it`
  - `a cached row without a content key gets one on the next scan`
  - `putTags then tagsFor returns the row; failed rows keep their error`
  - `items carry tags for the chosen models only, state waiting when not done, off when no model chosen`
  - `an item carries at most 12 keywords and no embedding` (Review Focus 4)
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. Migration: `ALTER TABLE photos ADD COLUMN content_key TEXT` when missing; `CREATE TABLE IF NOT EXISTS tags (content_key TEXT, model_id TEXT, status TEXT, description TEXT, keywords TEXT, objects TEXT, embedding BLOB, error TEXT, made_at INTEGER, PRIMARY KEY (content_key, model_id))`.
- [ ] **Step 4:** Tests PASS; existing `tests/gallery-*.test.ts` still pass.
- [ ] **Step 5:** Commit `feat(gallery): content key and tag storage`, bump, push.

### Task 5: Tagger backend in a worker thread

**Files:**
- Create: `src/gallery/server/tagging/backend.ts` (interface + worker client), `src/gallery/server/tagging/worker.ts` (runs in the thread), `src/gallery/server/tagging/vocabulary.ts`
- Modify: `scripts/desktop/build.mjs` (`@huggingface/transformers`, `onnxruntime-node` external; worker bundled as its own entry), `electron-builder.config.cjs` (`asarUnpack` for onnxruntime-node binaries)
- Test: `tests/gallery-tagger-backend.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DescribeResult { description: string; objects: { label: string; count: number }[] }
  export interface KeywordResult { keywords: { label: string; score: number }[]; embedding: Float32Array }
  export interface TaggerBackend {
    load(part: TagPart, model: ModelChoice, dir: string): Promise<void>; // throws ModelLoadError
    describe(imagePath: string): Promise<DescribeResult>;               // Florence-2 <MORE_DETAILED_CAPTION> + <OD>, objects counted by label
    keywords(imagePath: string): Promise<KeywordResult>;                 // CLIP image embedding vs vocabulary, top 12 at or above model.keywordThreshold
    embedText(text: string): Promise<Float32Array>;                      // CLIP text embedding, same space
    close(): Promise<void>;
  }
  export class ModelLoadError extends Error {}
  export function workerBackend(threads: number): TaggerBackend; // Transformers.js with env.allowRemoteModels = false, env.localModelPath = <dataDir>/models
  export const VOCABULARY: readonly string[]; // ~1,000 everyday nouns and scenes, lower case, unique
  ```
- [ ] **Step 1: Failing tests:**
  - `VOCABULARY is lower case, unique, at least 500 entries`
  - `workerBackend.load throws ModelLoadError for a folder with a missing file` (Review Focus 3)
  - `real models (skipped unless PHOTOBOOK_TAGGING_MODELS_DIR is set): describe gives a sentence and objects for a fixture; keywords gives at most 12 labels and a unit-length embedding; embedText of a matching word scores higher than an unrelated one`
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; vocabulary drafted in Task 1 and finalised here.
- [ ] **Step 4:** Tests PASS (real-model test run once locally with the Task 1 cache: `PHOTOBOOK_TAGGING_MODELS_DIR=<cache> npx vitest run tests/gallery-tagger-backend.test.ts`). `npm run desktop:build` succeeds and the built app contains the worker and onnxruntime binaries.
- [ ] **Step 5:** Commit `feat(gallery): tagger backend in a worker thread`, bump, push.

### Task 6: Background tagging queue

**Files:**
- Create: `src/gallery/server/tagging/queue.ts`
- Modify: `src/gallery/server/app.ts` (wire queue to scan jobs; routes)
- Test: `tests/gallery-tagging-queue.test.ts`

**Interfaces:**
- Consumes: Task 3 settings and `installedModels`, Task 4 `Catalog` tag methods and `contentKey`, Task 5 `TaggerBackend`.
- Produces:
  ```ts
  export interface TaggingStatus { job: string | null; total: number; done: number; failed: number; paused: boolean;
    running: boolean; notWorking: TagPart[]; stamp: number } // stamp: bumps whenever a photo's tags change
  export class TaggingQueue {
    constructor(deps: { catalog: Catalog; backend: TaggerBackend; dataDir: string; workingFile(path: string): Promise<string> });
    startJob(jobId: string, photos: () => GalleryPhoto[]): void; // called when the scan of that job is done
    focus(paths: string[]): void;   // selected first, then the shown ones, then the rest
    setSettings(s: TaggingSettings): void;
    status(): TaggingStatus;
    stop(): Promise<void>;
  }
  ```
- Routes: `GET /api/gallery/tagging/status` → `TaggingStatus`; `POST /api/gallery/tagging/focus` `{ job, paths }` → 204; Pause/Resume go through `PUT /api/gallery/tagging/settings` (`paused`).
- Rules: one photo at a time; skip photos with a `done` or `failed` row for the chosen model and content key; a failed photo gets a `failed` row with the error and is not retried until the model or content key changes; a part whose model fails to load is listed in `notWorking` and not run; switching a part's model re-queues every photo for it (old rows kept); a new job or folder close stops the old job's work after the current photo; a photo gone from the job list when its turn comes is skipped.

- [ ] **Step 1: Failing tests** (fake backend with controllable promises, temp catalogue):
  - `starts only when the scan is done and a part is chosen and installed`
  - `tags the focused photo first, then the shown ones in order, then the rest`
  - `skips photos already done for that model; a renamed photo with the same content key is not redone`
  - `a backend error marks the photo failed and moves on; failed photos are not retried`
  - `pause holds after the current photo; resume carries on; status counts done and failed`
  - `switching the keywords model re-tags every photo for keywords`
  - `a photo deleted or a folder closed mid-photo: no crash, no row for the gone photo, the queue stops for that job` (Review Focus 2)
  - `a model that fails to load is reported in notWorking and that part does not run` (Review Focus 3)
  - `stamp bumps after each photo's tags are written`
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(gallery): background tagging queue`, bump, push.

### Task 7: Settings → Photo tagging

**Files:**
- Modify: `src/gallery/web/components/SettingsDialog.tsx`, `src/gallery/web/api.ts`, `src/gallery/web/gallery.css`
- Create: `src/gallery/web/components/TaggingSettings.tsx`
- Test: `tests/e2e/gallery.spec.ts` (gallery server started with `PHOTOBOOK_GALLERY_FAKE_TAGGING=1`: add it to the gallery `webServer.env` in `playwright.config.ts`)

**Interfaces:**
- Consumes: Task 3 routes; `ModelChoice` for labels, sizes, licence, `secondsPerPhoto`.
- Produces: `galleryApi.models()`, `galleryApi.downloadModel(id)`, `galleryApi.cancelDownload()`, `galleryApi.removeModel(id)`, `galleryApi.setTaggingSettings(s)`, `galleryApi.taggingStatus()`, `galleryApi.taggingFocus(job, paths)`.
- UI per part ("Descriptions and objects", "Keywords and search by meaning"): radio **Off** / smaller / larger, each with label, size (MB/GB), "about N s a photo", licence; not-downloaded choice shows **Download** → an in-page confirm (not a native dialog) `Download <label>, <size>, from Hugging Face?` → progress bar with **Cancel**; downloaded shows **Remove**; `ok: false` shows **Not working · Download again**. Polls `GET /api/gallery/models` every 500 ms while a download runs.

- [ ] **Step 1: Failing e2e test** `Settings: download a tagging model with progress, choose it, remove it` — opens Settings, both parts start Off, clicking Download on the fake smaller describe model shows the confirm with its size, OK shows progress then Remove; choosing it is kept after reload; Remove returns it to Download and the part to Off.
- [ ] **Step 2:** `npx playwright test --project=gallery -g "download a tagging model"` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(gallery): Photo tagging settings`, bump, push.

### Task 8: Progress, "What's in it" and chip filters

**Files:**
- Modify: `src/gallery/web/store.ts` (status polling, focus posting, `tags` filter), `src/core/gallerySort.ts` (`GalleryFilter.tags`, `filterItems`), `src/gallery/web/components/Progress.tsx` or `FolderBar.tsx` (bar text), `src/gallery/web/components/Details.tsx`, `src/gallery/web/components/FilterBar.tsx`, `src/gallery/web/gallery.css`
- Create: `src/gallery/web/components/WhatsInIt.tsx`
- Test: `tests/gallery-sort.test.ts`, `tests/gallery-store.test.ts`, `tests/e2e/gallery.spec.ts`

**Interfaces:**
- Consumes: `GalleryItem.tags` (Task 4), Task 6 status and focus routes (Task 7 api functions).
- Produces:
  ```ts
  export interface TagFilter { kind: 'keyword' | 'object'; value: string }   // 'person' is added by the faces plan
  GalleryFilter.tags?: TagFilter[];     // all must match; isFilterActive counts it
  GalleryState.tagging: TaggingStatus | null;
  GalleryState.toggleTagFilter(f: TagFilter): void; // adds, or removes when already set
  ```
- Store: while a folder is open, poll `taggingStatus` with the stamp poll (every 3 s; every 1 s while running); when `stamp` changes, `refreshInfo()`; post `taggingFocus(job, [selected, ...first 200 visible])` when the selection or visible list changes (debounced 500 ms).
- Bar: `Tagging 120 of 2,140` with **Pause** / **Resume** while running or paused; nothing when done or off.
- Details: section `What's in it` after Photo: machine description (title attribute names the model label), Keywords chips, Objects chips (`person ×3` when count > 1), `Not looked at yet` (state waiting), `Tagging is off` with a Settings link (state off), `Couldn't look at this photo` (failed). Chips are buttons; pressed state when that filter is set.
- FilterBar: each tag filter as a chip with × (aria-label `Remove filter <value>`).

- [ ] **Step 1: Failing tests:**
  - `filterItems with tags keeps photos having every keyword/object; isFilterActive true` (gallery-sort)
  - `toggleTagFilter adds then removes; a stamp change reloads the photos; focus posts the selected photo first` (gallery-store, fake fetch)
  - e2e `What's in it shows the description and chips; clicking a keyword filters the grid; × clears it` — with the fake backend tagging the trip fixture (fake describe returns a fixed sentence and objects from the file name; fake keywords returns words from the file name).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(gallery): tagging progress, What's in it, chip filters`, bump, push.

### Task 9: Search by words and by meaning

**Files:**
- Modify: `src/core/gallerySort.ts` (text filter also matches tags), `src/gallery/server/app.ts` (`GET /api/gallery/search`), `src/gallery/web/store.ts`, `src/gallery/web/components/Grid.tsx` (note row)
- Test: `tests/gallery-sort.test.ts`, `tests/gallery-search.test.ts`, `tests/gallery-store.test.ts`, `tests/e2e/gallery.spec.ts`

**Interfaces:**
- Consumes: Task 4 `Catalog.embeddings`, Task 5 `embedText`, Task 6 settings.
- Produces:
  - `filterItems` text match (case-insensitive) over description, notes, `tags.description`, `tags.keywords`, `tags.objects[].label`.
  - `GET /api/gallery/search?job=<id>&q=<text>` → `{ paths: string[] }`: photos whose cosine similarity to `embedText(q)` is at least the chosen keywords model's `meaningThreshold` (Task 2), best first, at most 200; `[]` when no keywords model is chosen, or `q` has fewer than 3 letters.
  - `GalleryState.meaning: { q: string; paths: string[] } | null`; `selectVisible`: word matches (sorted as chosen), then meaning matches not already shown, in meaning order; `selectMeaningStart(s): number | null` (index where meaning matches begin) for the Grid's note row `Also matching by meaning`.
- Store fetches search 300 ms after the text filter changes (only with the keywords part on); a reply for an older `q` is dropped.

- [ ] **Step 1: Failing tests:**
  - `text search matches machine description, keywords and objects, not only notes` (gallery-sort)
  - `search route ranks by similarity above the threshold, best first; [] under 3 letters or with no keywords model` (gallery-search, fake backend with fixed embeddings) (Review Focus 5)
  - `meaning matches follow the word matches, without repeats; a stale reply is dropped` (gallery-store)
  - e2e `searching a word not in any keyword still finds photos by meaning, under "Also matching by meaning"` (fake backend: embedText puts "seaside" next to the harbour photo)
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(gallery): search by keywords and by meaning`, bump, push.

### Task 10: Docs, checks and the full run

**Files:**
- Modify: `README.md` (gallery: Photo tagging section — Settings, what is downloaded from where, what runs, privacy), `docs/handoff.md` (branch note and human checks 29–34), `docs/plan.md` (line for this work)

- [ ] **Step 1:** README section and handoff checks: real download of each choice on Steven's PC (size and time match Settings); tagging a real folder overnight (progress, Pause, closing and reopening resumes); description and keyword quality on real photos; search by meaning finds what he expects; Remove frees the disk space; the Windows installer build runs tagging (onnxruntime binaries unpacked).
- [ ] **Step 2:** `npm test` — all pass; `npx tsc --noEmit -p .` clean; `npx playwright test --project=gallery` — all pass.
- [ ] **Step 3:** Commit `docs(gallery): photo tagging`, bump, push.
