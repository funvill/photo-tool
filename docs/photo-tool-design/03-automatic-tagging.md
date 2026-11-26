# Automatic photo tagging ("What's in it")

Photo Tool can look at each photo of the open folder with on-device machine-learning models and record three kinds of result:

- a **description**: one sentence or a short paragraph about the photo, from a Florence-2 model;
- **objects**: labels with counts (`dog ×2`), from the same Florence-2 model's object detection;
- **keywords**: up to 12 words from a fixed vocabulary, plus a picture **embedding** used for *search by meaning*, from a CLIP model.

Everything runs on the computer. The only network use is downloading a model's files from Hugging Face, and only after the user confirms it in Settings. Tagging is split into two independent **parts**:

| Part id | Shown as (Settings) | Produces | Model family |
|---|---|---|---|
| `describe` | "Descriptions and objects", with the note "A sentence about each photo, and the things in it." | description, objects | Florence-2 |
| `keywords` | "Keywords and search by meaning", with the note "Keywords for each photo, and search that finds photos by what you mean." | keywords, embedding | CLIP |

For each part the user chooses **Off** or one installed model. With both parts Off, tagging is off.

Source map:

| Concern | Files |
|---|---|
| Model catalogue (fixed in code) | `photo-tool/core/tagModels.ts` |
| Model download, verification, install state, settings file, model routes | `photo-tool/server/models/download.ts`, `store.ts`, `routes.ts` |
| Worker thread that runs the models | `photo-tool/server/tagging/worker.ts`, `workerSource.ts` |
| Main-thread proxy to the worker | `photo-tool/server/tagging/backend.ts` |
| Keyword vocabulary | `photo-tool/server/tagging/vocabulary.ts` |
| Queue / scheduler | `photo-tool/server/tagging/queue.ts` |
| Album-folder sidecar sync | `photo-tool/server/tagging/albumTags.ts`, `shared/phototags/*` |
| Catalog `tags` / `file_keys` tables | `photo-tool/server/catalog.ts` |
| Tagging, search and regenerate HTTP routes, `PhotoTags` shaping | `photo-tool/server/app.ts` |
| Page | `photo-tool/web/components/WhatsInIt.tsx`, `TaggingSettings.tsx`, `Progress.tsx` (`TaggingProgress`), `Grid.tsx`, `web/store.ts`, `web/api.ts`, `photo-tool/core/gallerySort.ts` |
| Desktop packaging and self-test | `photo-tool/electron/server-host.ts`, `photo-tool/electron/selfTest.ts`, `shared/electron/config.ts` (`taggingWorkerPath`), `scripts/desktop/build.mjs`, `photo-tool/electron-builder.config.cjs` |
| Measurement script (development only) | `scripts/tagging/measure.ts` |
| Tests | `photo-tool/tests/gallery-tagging-queue.test.ts`, `gallery-tagging-app.test.ts`, `gallery-models.test.ts`, `gallery-tagger-backend.test.ts`, `tag-models.test.ts`, `tagging-worker-ping.test.ts`, `gallery-search.test.ts`, `gallery-tags-store.test.ts`, `gallery-album-tags.test.ts`, `tests/support/fakeTagging.ts`, `shared/tests/phototags.test.ts` |

---

## Runtime and libraries

- **Transformers.js**: npm `@huggingface/transformers`, pinned at `4.3.2` in `package.json`. The worker uses `env`, `AutoProcessor`, `AutoTokenizer`, `RawImage`, `Florence2ForConditionalGeneration`, `CLIPVisionModelWithProjection` and `CLIPTextModelWithProjection`.
- **onnxruntime-node**: a transitive dependency of Transformers.js, `1.30.0` in the installed tree. All inference runs on the CPU (`device: 'cpu'`).
- Settings the worker applies at module load:
  - `env.allowRemoteModels = false` and `env.allowLocalModels = true`. The worker never fetches anything.
  - Every `from_pretrained` call passes `local_files_only: true`.
- **Session options:** `{ intraOpNumThreads: threads, interOpNumThreads: 1 }`, where `threads = max(1, floor(os.cpus().length / 2))`. That is half the logical processors, computed in `createGalleryApp`.
- **dtype:** taken from the catalogue entry (`'q8'` for every model), so the quantized ONNX files are used.

### Processes and threads

```
Electron main process
 └─ utilityProcess "Photo Tool server" (server-host.cjs → createGalleryApp)   [desktop]
     or plain Node `tsx watch photo-tool/server/main.ts`                      [development]
      └─ worker_threads Worker: tagging worker (tagging-worker.cjs | worker.ts)
```

**Desktop.** `photo-tool/electron/server-host.ts` passes `tagging: { workerFile: taggingWorkerPath(__dirname) }` to `createGalleryApp`.

- `taggingWorkerPath(bundleDir)` returns `<bundleDir with "app.asar" replaced by "app.asar.unpacked">/tagging-worker.cjs`, using the separator already present in `bundleDir`.
- `scripts/desktop/build.mjs` bundles `tagging-worker.cjs` from the worker source with esbuild, keeping `@huggingface/transformers` external.
- `electron-builder.config.cjs` unpacks `node_modules/**` and `tagging-worker.cjs` from the asar archive. A worker thread and the onnxruntime native binary must load from real files.
- The build strips onnxruntime binaries for other platforms. It fails if `node_modules/onnxruntime-node/bin/napi-v6/<platform>` is missing ("onnxruntime-node has no binary for …: photo tagging would not run.").

**Development.** `photo-tool/server/main.ts` uses `taggingWorkerSource()`, the absolute path of `photo-tool/server/tagging/worker.ts`. It is started as a `.ts` worker under `tsx`. The worker imports nothing else from the app at run time.

**Tests and e2e.** With `PHOTO_TOOL_FAKE_TAGGING=1`, `main.ts` uses `tests/support/fakeTagging.ts`:

- `FAKE_CATALOGUE` and `fakeFetch({ chunkDelayMs: 40 })`, which serves files from memory, supports Range, and makes one redirect hop to a CDN host;
- `fakeBackend({ delayMs: 40 })`;
- `imageOf = p => p.path`.

Fake keywords models use `keywordThreshold 0.2` and `meaningThreshold 0.5`.

**Worker lifetime** (`workerBackend` in `backend.ts`):

- The worker is created lazily on the first call and `unref()`ed, so it never keeps the process alive.
- If it emits `error`, or `exit` while it is the current worker, every pending call is rejected (see the error mapping below) and the reference is cleared. The next call starts a fresh worker, which has **no models loaded**.
- `close()` rejects all pending calls with `Error('Tagging stopped.')` and terminates the worker.

There is **no per-request timeout**.

---

## Model catalogue

The catalogue is a constant in code (`MODEL_CATALOGUE` in `photo-tool/core/tagModels.ts`). It is never fetched. Each file is pinned to a Hugging Face commit and a SHA-256. Changing a model is a code change. The values were measured on 2026-11-24 (`docs/superpowers/notes/2026-11-24-tagging-measurements.md`).

### Types

```ts
type TagPart = 'describe' | 'keywords';
interface ModelFile { path: string; bytes: number; sha256: string }  // path inside the repo and inside <dataDir>/models/<id>/
interface ModelChoice {
  id: string;                 // [a-z0-9-]+
  part: TagPart;
  size: 'smaller' | 'larger';
  label: string;
  repo: string;               // Hugging Face repo
  revision: string;           // 40-hex commit
  dtype: string;              // passed to Transformers.js
  files: ModelFile[];
  licence: 'MIT' | 'Apache-2.0' | 'BSD-3-Clause';
  secondsPerPhoto: number;    // typical, six-core desktop CPU (shown in Settings)
  keywordThreshold?: number;  // keywords only: min softmax share for a keyword
  meaningThreshold?: number;  // keywords only: min cosine for search by meaning
}
```

Helpers:

- `modelBytes(m)` is the sum of `files[].bytes`.
- `findModel(id, catalogue?)` returns the entry or `undefined`.
- `choicesFor(part)` returns that part's models, `smaller` first.

Invariants pinned by `tag-models.test.ts`:

- every `revision` is 40 hex characters, every `sha256` is 64 hex characters, and every `bytes` is positive;
- ids are unique;
- each part has exactly one `smaller` and one `larger` model;
- keywords models have both thresholds in (0, 1);
- the licence is one of the three allowed;
- no repo lives under `deepinsight/` or `insightface`.

### The four models

| id | part | size | label | repo @ revision | dtype | total bytes | s/photo | licence | thresholds |
|---|---|---|---|---|---|---|---|---|---|
| `florence2-base-q8` | describe | smaller | Florence-2 base | `onnx-community/Florence-2-base-ft` @ `e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f` | q8 | 277,470,179 (~277 MB) | 6 | MIT | — |
| `florence2-large-q8` | describe | larger | Florence-2 large | `onnx-community/Florence-2-large-ft` @ `04ace74913c28d7ec94af32cee5c111a10126b6f` | q8 | 832,001,774 (~832 MB) | 20 | MIT | — |
| `clip-base-q8` | keywords | smaller | CLIP base | `Xenova/clip-vit-base-patch32` @ `6b7c523703ae26e39be4b03774966f8571c7f523` | q8 | 155,851,446 (~156 MB) | 0.1 | MIT | keyword 0.05, meaning 0.27 |
| `clip-large-q8` | keywords | larger | CLIP large | `Xenova/clip-vit-large-patch14` @ `c307790166907339eed5a9a53a249af534102536` | q8 | 434,215,233 (~434 MB) | 0.5 | MIT | keyword 0.05, meaning 0.24 |

### Files per model (path, bytes, sha256)

**florence2-base-q8**

| path | bytes | sha256 |
|---|---|---|
| `config.json` | 5432 | `d90c22ed72eb55291f183fcd9b98ebd3bd3d92bfcffb6c7f6e1606085e793525` |
| `generation_config.json` | 292 | `7b8eb17bbd6cf8a07f619ad83ae03881eff05b6b9237bab89005b40e77783c29` |
| `onnx/decoder_model_merged_quantized.onnx` | 98177697 | `f22f52f980c33df0efa15932c2f3db6d9d3595ce6387eca938b8cfe23dc4c641` |
| `onnx/embed_tokens_quantized.onnx` | 39390433 | `6b2258db1c8ee9b160576ccde3cd3814d83a2edaed0dd1c6ca9ff3c38fa62214` |
| `onnx/encoder_model_quantized.onnx` | 43651493 | `f4ad7a68f1fb875d3bcf735ea14a7021b7ba7e83baf7cf10289881b4ed6d9b85` |
| `onnx/vision_encoder_quantized.onnx` | 93746540 | `3b79d54f23f666f731549db23cb070c35a979ce19cbd9720e90e67a78dc9768c` |
| `preprocessor_config.json` | 2673 | `c892857e34a7082284983a7717717d39c9bf7e574f1f41d80d4c918c97502efa` |
| `tokenizer.json` | 2297961 | `d69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac` |
| `tokenizer_config.json` | 197658 | `d8e64607233cb53b619fb46664f6cad08176c26e0e8735b2d30d888364f19600` |

**florence2-large-q8**

| path | bytes | sha256 |
|---|---|---|
| `config.json` | 5460 | `226291bd5b65c932b01704838489cdc810f0f4949f182abc3de67d7a6ab3632a` |
| `generation_config.json` | 62 | `6257874d1d2fd60a5c0786253005d9dfa46f5287903fdb079ca9829ec13cf8b4` |
| `onnx/decoder_model_merged_quantized.onnx` | 257619824 | `167e7807fb1e5b8d693138f84bc81e1368ea11833264131c1ea96eafc9d13222` |
| `onnx/embed_tokens_quantized.onnx` | 52520480 | `dab1d09ab449f1302df6e439b35ec9e93fb037134bf6bed9ffeaa93a5b35d43c` |
| `onnx/encoder_model_quantized.onnx` | 152985855 | `9fe30b02cc8c2247631f8f0b9bc4d6613df1c33da0afe4087abff2f940bc2fe0` |
| `onnx/vision_encoder_quantized.onnx` | 366371802 | `0dbf2172ef1dc6fbb4da0f02498ef9e3a009bf84e8f2e0d971f39cc5b7e053ce` |
| `preprocessor_config.json` | 2672 | `3adbbeec44c2b8f41a1e97b3ab2197227fb24be1fc1779c9d0d925f4e77d6559` |
| `tokenizer.json` | 2297961 | `d69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac` |
| `tokenizer_config.json` | 197658 | `d8e64607233cb53b619fb46664f6cad08176c26e0e8735b2d30d888364f19600` |

**clip-base-q8**

| path | bytes | sha256 |
|---|---|---|
| `config.json` | 4524 | `493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495` |
| `onnx/text_model_quantized.onnx` | 64504507 | `73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a` |
| `onnx/vision_model_quantized.onnx` | 89117001 | `583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299` |
| `preprocessor_config.json` | 520 | `6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f` |
| `tokenizer.json` | 2224119 | `f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd` |
| `tokenizer_config.json` | 775 | `60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967` |

**clip-large-q8**

| path | bytes | sha256 |
|---|---|---|
| `config.json` | 694 | `99d2f15ccaf4f72c1e4c656dc77ae0fa487696860617ea50626d3a14a018185d` |
| `onnx/text_model_quantized.onnx` | 124987663 | `6d31c7a212681c3918d78193b6b4f98c70fe540577f9a0a57fe7ba8c7439244c` |
| `onnx/vision_model_quantized.onnx` | 307001500 | `9a658de8944a2001719beabf6c5030cfe7b3dc80e85983f69fc648d6b4d7ec0f` |
| `preprocessor_config.json` | 520 | `6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f` |
| `tokenizer.json` | 2224081 | `72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85` |
| `tokenizer_config.json` | 775 | `60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967` |

Both CLIP models share the same `preprocessor_config.json` and `tokenizer_config.json` entries (the `CLIP_PROCESSOR` and `CLIP_TOKENIZER_CONFIG` constants).

---

## Model storage and settings on disk

`<dataDir>` is Photo Tool's data folder (see the data-folders section).

| Item | Location | Notes |
|---|---|---|
| A model's files | `<dataDir>/models/<id>/<file.path>` | Mirrors the repo layout, so ONNX files sit in `onnx/` |
| A partial download | `<dataDir>/models/<id>/<file.path>.part` | Resumed later |
| Chosen models | `<dataDir>/tagging.json` | See below |

### `tagging.json`

```json
{
  "describe": "florence2-base-q8",
  "keywords": null,
  "paused": false
}
```

**Read** (`readTaggingSettings`):

- `describe` and `keywords` are used only if they are strings; anything else becomes `null`.
- `paused` is `true` only if it is literally `true`.
- A missing or unparsable file gives `{describe: null, keywords: null, paused: false}`.
- Unknown fields are dropped. They are not preserved on the next write.

**Write** (`writeTaggingSettings`):

- creates `<dataDir>` if needed;
- writes `tagging.json.tmp` (2-space JSON with exactly the three keys);
- renames it over `tagging.json`.

The routes always write `paused: false` (see Pause below), so in practice the file never holds `true`.

### Install state

`installedModels(dataDir, catalogue)` walks the catalogue in order. For each model:

- If `<dataDir>/models/<id>` does not exist, it is skipped.
- Each file is `stat`ed; anything that is not a regular file counts as absent.
- If **every** file is absent (for example only `.part` files exist), the model is not installed.
- Otherwise the result is `{ id, bytes, ok }`:
  - `bytes` is the sum of the present files' sizes;
  - `ok` is true when every file is present with exactly the catalogue's byte size.

There is **no hash check here**; installed state is size-only.

**Removal.** `removeModel(dataDir, id)` throws on an id that does not match `/^[a-z0-9-]+$/`. Otherwise it deletes `<dataDir>/models/<id>` recursively.

---

## Model download

`downloadModel(dataDir, m, { fetch?, signal?, onProgress? })` in `photo-tool/server/models/download.ts`.

### Allowed hosts

`isAllowedModelUrl(url)` is true only when **all** of these hold:

- the URL parses and uses `https:`;
- there is no explicit port (`u.port === ''`);
- there is no username or password;
- the lower-cased host is `huggingface.co`, ends in `.huggingface.co`, or ends in `.hf.co`.

Pinned by tests:

| URL | Allowed? |
|---|---|
| `https://huggingface.co/x/resolve/abc/model.onnx` | yes |
| `https://cdn-lfs.huggingface.co/...` | yes |
| `https://cas-bridge.xethub.hf.co/...` | yes |
| `https://cdn-lfs.hf.co/...` | yes |
| `http://huggingface.co/x` | no |
| `https://huggingface.co.evil.com/x` | no |
| `https://evilhuggingface.co/x` | no |
| `https://huggingface.co:8443/x` | no |
| `https://user:pw@huggingface.co/x` | no |

### Algorithm

```
total = sum(files.bytes); received = 0
for each file f in catalogue order:
  if signal aborted → throw ModelDownloadError('Download cancelled.')
  target = <dir>/<f.path>
  if target exists and size == f.bytes: received += f.bytes; report; continue   // no hash check
  delete target
  downloadFile(f)

downloadFile(f):
  part = target + '.part'; mkdir -p dirname(target)
  have = size(part) or 0; if have > f.bytes: delete part, have = 0
  onBytes(have)
  if have < f.bytes:
    url = https://huggingface.co/<repo>/resolve/<revision>/<f.path>
    res = get(url, have > 0 ? {range: 'bytes=<have>-'} : {})
    if have > 0 and res.status == 200:            // server ignored Range
        delete part; onBytes(-have); have = 0
    else if !res.ok or no body: throw "Hugging Face answered <status> for <path>."
    stream body to part (append if have > 0, else truncate), onBytes(chunk.length) per chunk;
      abort check per chunk → 'Download cancelled.'; write errors captured
    if write error: throw ENOSPC ? "Not enough disk space for <path>. Free some space and download again."
                                 : "Couldn't write <path>: <message>"      (part kept)
  if size(part) != f.bytes or sha256(part) != f.sha256:
     delete part; throw "<path> did not pass its check (wrong size or SHA-256); it was deleted. Try again."
  rename part → target
```

**Redirects.** `get` uses `redirect: 'manual'` and follows at most `MAX_REDIRECTS = 5` hops by hand.

- Every hop's URL must pass `isAllowedModelUrl`, or the call throws `Download host not allowed: <host>`.
- A 3xx response without `Location` gives "Hugging Face sent a redirect without a location."
- More than 5 hops gives "Too many redirects from Hugging Face."
- The `Range` header is sent on every hop.

**Errors.** All of them are `ModelDownloadError`.

**Progress.** `onProgress({ id, received, total })` fires on every chunk and on every skipped file. `received` can go down when a server ignores Range.

**Resume.** A cancelled or failed download leaves `.part` files. The next download resumes them with a Range request (pinned by tests). A file that finished downloading is never re-hashed by `downloadModel`.

### Verification after a failed load

`verifyModel(dataDir, m)` runs when a model fails to load. It re-hashes every present file and deletes any whose size or SHA-256 differs, so a file damaged in place at the same size shows up. It returns the deleted paths. The model then reports `ok: false`, and Settings offers "Download again".

---

## Model and settings HTTP routes

Registered by `modelRoutes(app, dataDir, opts)` in `photo-tool/server/models/routes.ts`.

**Download state.** At most **one download at a time** per server. The state lives in memory: `downloading = { id, received, total, abort } | null` and `error: string | null`.

**Callbacks from `app.ts`:**

- `onSettings(s)` calls `tagging.setSettings(s)`.
- `onModelsChanged()` calls `tagging.refresh()`.
- `tagging()` returns `{ paused, notWorking }` from `tagging.status()`.

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/gallery/models` | — | 200 `ModelsState` (below) | — |
| `POST /api/gallery/models/:id/download` | — | **202** `{ id }`, after starting the download in the background | 404 `{error:'No such model.'}`; 409 `{error:'Another model is downloading. Wait for it, or cancel it.'}` |
| `POST /api/gallery/models/download/cancel` | — | 204, aborting the current download if any | — |
| `DELETE /api/gallery/models/:id` | — | 204 | 404 `{error:'No such model.'}` |
| `PUT /api/gallery/tagging/settings` | `{ describe: string \| null, keywords: string \| null, paused: boolean }` | 200, echoing the saved `TaggingSettings` | 400 `{error:'Choose a downloaded model of the right kind, or Off.'}` |

`ModelsState`:

```ts
{
  catalogue: ModelChoice[];              // the whole catalogue (files, hashes and all)
  installed: { id: string; bytes: number; ok: boolean }[];
  settings: { describe: string|null; keywords: string|null; paused: boolean }; // describe/keywords from tagging.json, paused from the live queue
  notWorking: TagPart[];                 // chosen parts whose model is damaged or would not load
  downloading: { id: string; received: number; total: number } | null;
  error: string | null;                  // last download failure: "Couldn't download <label>: <message>"
}
```

**Download details:**

- Starting a download clears `error`.
- On failure, `error` is set unless the download was aborted. A cancel leaves no error.
- In every outcome, `downloading` is cleared (if it is still this download) and `onModelsChanged()` runs.

**DELETE details:**

- If the model is downloading, the download is aborted first.
- The folder is removed.
- If the model was chosen for its part, settings are saved with that part set to `null`, keeping the live pause state.
- `onModelsChanged()` runs.

**PUT validation.** For each part, the value must be `null`, or a string naming a catalogue model of **that** part that `installedModels` lists. Listing includes an incomplete install with `ok: false`; see Open points. Anything else, including a missing key or a non-boolean `paused`, is a 400. On success:

- the file is written with `paused: false`;
- `onSettings` gets the real `paused` value;
- the reply is `{describe, keywords, paused}` as sent.

**Shutdown.** `modelRoutes` returns `{ stop() }`, which aborts any download when the server closes.

---

## Keyword vocabulary

`VOCABULARY` in `photo-tool/server/tagging/vocabulary.ts` is the ordered, de-duplicated (`new Set`) list of the groups below, in this order: **564 words**. All entries are lower case, and tests require at least 500 unique entries. Changing the list affects only photos tagged afterwards.

Some words appear in more than one group (`drawing`, `painting`). The first occurrence wins the position.

- **People and occasions:** person, people, man, woman, child, baby, toddler, boy, girl, teenager, family, couple, friends, crowd, group photo, portrait, selfie, grandparent, bride, groom, wedding, birthday, birthday cake, party, graduation, christmas, christmas tree, halloween, easter, new year, fireworks, concert, festival, parade, ceremony, picnic, barbecue, camping, hiking, holiday, vacation, road trip, reunion, dinner party, baby shower, funeral, school, classroom, sports day, dancing, singing, playing, laughing, smiling, hugging, sleeping, eating, cooking, reading, swimming, running, cycling, skiing, snowboarding, surfing, sailing, fishing, climbing, skating, gardening, painting, drawing, shopping, working, studying, gaming
- **Animals:** dog, puppy, cat, kitten, bird, parrot, duck, goose, swan, chicken, horse, pony, cow, sheep, goat, pig, rabbit, hamster, fish, goldfish, turtle, frog, snake, lizard, butterfly, bee, spider, insect, squirrel, deer, fox, bear, wolf, lion, tiger, elephant, giraffe, zebra, monkey, gorilla, kangaroo, koala, panda, penguin, seal, dolphin, whale, shark, crab, jellyfish, owl, eagle, pigeon, seagull, flamingo, peacock, camel, donkey, zoo, aquarium, farm animals, pet
- **Nature and landscape:** landscape, nature, mountain, hill, valley, cliff, canyon, volcano, glacier, cave, rock, desert, sand dune, forest, jungle, woods, tree, palm tree, pine tree, autumn leaves, leaf, flower, rose, tulip, sunflower, daisy, cherry blossom, lavender, garden, lawn, grass, meadow, field, wheat field, vineyard, orchard, farm, countryside, river, stream, waterfall, lake, pond, sea, ocean, beach, coast, bay, island, wave, harbour, pier, lighthouse, sand, shell, coral reef, underwater, sky, cloud, blue sky, sunset, sunrise, dusk, night sky, stars, moon, rainbow, storm, lightning, fog, mist, rain, snow, ice, frost, winter, spring, summer, autumn, park, national park, trail, path, mountain view, scenery
- **Places and buildings:** city, town, village, street, alley, road, highway, bridge, tunnel, skyline, skyscraper, building, house, cottage, cabin, apartment, castle, palace, tower, church, cathedral, mosque, temple, shrine, monument, statue, fountain, ruins, museum, art gallery, library, market, shop, supermarket, mall, restaurant, cafe, bar, pub, bakery, hotel, hotel room, pool, swimming pool, gym, stadium, playground, amusement park, roller coaster, ferris wheel, theatre, cinema, airport, train station, bus stop, port, marina, parking lot, gas station, hospital, office, factory, warehouse, construction site, square, plaza, old town, harbour town, graffiti, mural, neon sign, street sign, shop window, balcony, rooftop, courtyard, staircase, doorway, window, fence, wall, gate, garden path, backyard, patio, porch, driveway
- **Indoors and home:** room, living room, kitchen, bedroom, bathroom, dining room, hallway, garage, attic, basement, sofa, chair, table, bed, desk, shelf, bookshelf, fireplace, lamp, candle, mirror, clock, carpet, curtain, pillow, blanket, plant, houseplant, vase, painting on wall, photo frame, television, computer, laptop, phone, camera, headphones, keyboard, piano, guitar, violin, drum, book, magazine, newspaper, letter, map, toy, teddy bear, doll, lego, board game, puzzle, balloon, gift, present, wrapping paper, decoration, christmas lights, umbrella, bag, backpack, suitcase, luggage, hat, sunglasses, glasses, shoes, boots, dress, suit, jacket, coat, scarf, costume, uniform, jewellery, watch, ring, flowers in vase, bouquet
- **Food and drink:** food, meal, breakfast, lunch, dinner, dessert, snack, cake, cupcake, cookie, bread, sandwich, burger, pizza, pasta, noodles, rice, sushi, salad, soup, steak, chicken dish, seafood, fish dish, fruit, apple, banana, orange, strawberry, grapes, watermelon, lemon, vegetables, tomato, carrot, potato, cheese, eggs, chocolate, ice cream, candy, pie, pancakes, coffee, tea, cup, mug, wine, beer, cocktail, juice, water bottle, glass, plate, bowl, cutlery, picnic blanket, street food, food market, buffet, kitchen table
- **Vehicles and transport:** car, vintage car, truck, van, bus, train, tram, subway, motorcycle, scooter, bicycle, boat, sailboat, ship, cruise ship, ferry, canoe, kayak, yacht, airplane, helicopter, hot air balloon, tractor, taxi, police car, fire truck, ambulance, skateboard, stroller, wheelchair, horse and cart
- **Sport and play:** football, soccer, basketball, tennis, golf, baseball, cricket, rugby, hockey, volleyball, boxing, yoga, martial arts, horse riding, race, marathon, swimming race, trophy, medal, ball, kite, swing, slide, sandcastle, snowman, sledding, water park, trampoline
- **Photo kinds and look:** close-up, macro, aerial view, panorama, black and white photo, old photo, scanned photo, blurry photo, dark photo, bright photo, silhouette, reflection, shadow, long exposure, bokeh, night photo, indoor photo, outdoor photo, screenshot, document, receipt, text, sign, poster, drawing, illustration, cartoon, abstract pattern, texture, colourful, pastel colours, gradient, minimalist, symmetry, crowded, empty, quiet, cozy, romantic, happy, funny
- **Colours:** red, orange colour, yellow, green, blue, purple, pink, brown, black, white, grey, gold, silver

The backend sends a copy of the whole list (`[...VOCABULARY]`) to the worker with each keywords `load`.

---

## Worker protocol

Messages go over `worker_threads` `postMessage` between `backend.ts` (main side) and `worker.ts`. Types are exported from `worker.ts`.

### Requests (main → worker)

Each request carries a numeric `id`, unique per backend instance, starting at 1.

| op | Fields | Result (`result` in a success reply) |
|---|---|---|
| `load` | `part: 'describe'\|'keywords'`, `dir` (absolute model folder), `dtype`, `threads`, `keywordThreshold` (from the catalogue, `0` if absent), `vocabulary: string[]` | `null` |
| `describe` | `path` (image file), `sample?: boolean` | `{ description: string; objects: {label: string; count: number}[] }` |
| `caption` | `path` | `string`: a sampled caption only, with no object detection |
| `keywords` | `path` | `{ keywords: {label: string; score: number}[]; embedding: Float32Array }` |
| `embedText` | `text` | `Float32Array`, unit length |

The `describe` op's `sample` flag exists in the protocol, but the backend never sets it. Tagging always describes greedily, and only `caption` samples.

### Replies (worker → main)

```ts
{ id, ok: true, result }
{ id, ok: false, error: string, load?: boolean, lost?: boolean }
```

- `load` is true when the failing request was a `load`.
- `lost` is true when the error was `NotLoaded`, meaning the model needed for the op is not loaded in this worker (because it was restarted). The messages are:
  - "The descriptions model is not loaded." for `describe` and `caption`;
  - "The keywords model is not loaded." for `keywords` and `embedText`.

### Out-of-band ping (no id, no model)

| Message | Reply |
|---|---|
| `{ type: 'ping' }` | `{ type: 'pong', ort: string }`: the onnxruntime-node version from `env.backends.onnx.versions.node`, or `''` when it did not load |

The ping is answered immediately, outside the request chain. The desktop self-test uses it in step `taggingWorkerLoads` (`pingTaggingWorker(workerFile, 30_000)` in `photo-tool/electron/selfTest.ts`):

- It starts the installed worker and sends a ping.
- It passes when `ort` matches `/^\d+\.\d+\.\d+/`.
- It fails if the pong is empty ("onnxruntime-node did not load."), on a worker `error` or `exit`, or after 30 s ("The tagging worker did not answer within 30 s.").

The step reads no model and downloads nothing. `tagging-worker-ping.test.ts` runs the same ping against the source worker.

### Ordering inside the worker

```
chain = resolved; keywordsReady = resolved
on request r:
  if r.op == 'embedText': keywordsReady.then(handle+reply)   // does NOT wait for a describe in progress
  else: chain = chain.then(handle+reply)
        if r.op == 'load' && r.part == 'keywords': keywordsReady = chain
```

Ordinary requests run strictly one at a time in arrival order. A search query (`embedText`) waits only for a pending keywords-model load, not for a photo being described, which can take many seconds. Because model runs are async, it is answered in between. This is pinned by a real-model test: the order is `['embedText', 'describe']`.

### Error mapping on the main side

| Situation | Promise rejects with |
|---|---|
| reply `ok:false, load:true` | `ModelLoadError(error)` |
| reply `ok:false, lost:true` | `BackendLostError(error)` |
| reply `ok:false`, otherwise | `Error(error)` |
| worker `error` / `exit` with calls pending | each pending `load` → `ModelLoadError`; any other → `BackendLostError` (message "The tagging worker stopped (code N)." on exit) |
| `close()` | `Error('Tagging stopped.')` |

`backend.load(part, model, dir)` checks the files first. It compares each file's size under `dir` with the catalogue. If any differ or are missing, it throws `ModelLoadError('<label> is incomplete (<paths>). Download it again.')` without contacting the worker. Tests pin that a call made before `load` is refused rather than left hanging, including `caption`, which is refused as a lost model.

### Model loading in the worker

The worker sets `env.localModelPath = dirname(dir) + '/'` and loads the model by name `basename(dir)`, because Transformers.js resolves `<localModelPath><name>/`. Model options:

```
{ dtype, device: 'cpu', local_files_only: true,
  session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } }
```

- **describe:** dispose any previous Florence model, then load `Florence2ForConditionalGeneration`, `AutoProcessor` and `AutoTokenizer` from the same folder.
- **keywords:** dispose the previous CLIP vision and text models, then load `CLIPVisionModelWithProjection`, `CLIPTextModelWithProjection`, `AutoProcessor` and `AutoTokenizer`. Store `words = vocabulary` and `threshold = keywordThreshold`. Then pre-compute the vocabulary text embeddings with `embedTexts(words.map(w => 'a photo of ' + w))`.

The worker holds at most one Florence model and one CLIP model at a time.

---

## How results are derived from model output

The image given to every model is the photo's **1600 px "m" thumbnail**, `<dataDir>/thumbs/<key>_m.jpg` (`catalog.thumbPath(p.key, 'm')`). Tests may override it through `imageOf`. It is read with `RawImage.read(path)`.

### Description (Florence-2)

```
florenceTask(image, task, maxTokens, sample):
  vision = processor(image)
  text   = tokenizer(processor.construct_prompts(task))
  ids    = model.generate({...text, ...vision, max_new_tokens: maxTokens, ...(sample ? SAMPLING : {})})
  out    = tokenizer.batch_decode(ids, {skip_special_tokens: false})[0]
  return processor.post_process_generation(out, task, image.size)[task]

caption = String(florenceTask(image, '<MORE_DETAILED_CAPTION>', 100, sample) ?? '')
            .replace(/<[^>]*>/g, '')   // strip every remaining tag
            .trim()
```

- **Task token:** `<MORE_DETAILED_CAPTION>`, with `max_new_tokens` set to 100.
- **Prompt text:** `construct_prompts` maps the task token to the natural-language prompt in the model's own `preprocessor_config.json` (`task_prompts_without_inputs`). Photo Tool supplies no prompt text of its own.
- **Greedy vs sampled:**
  - Tagging uses the model's default generation, which is greedy and deterministic.
  - Regenerate uses `SAMPLING = { do_sample: true, temperature: 0.7, top_k: 50 }`, which samples from the 50 likeliest tokens, slightly cooler than the model's own spread.
- **Post-processing in Transformers.js:**
  - It removes `<s>` and `</s>`.
  - For a pure-text task it returns the text.
  - The app then strips any `<…>` tags and trims.
- Tests pin that a description is longer than 20 characters and contains no `<` or `>` (real models), and that a few sampled captions differ from each other.

### Objects (Florence-2 object detection)

`describe` runs a second generation on the same image with task token `<OD>` and `max_new_tokens = 256`, always greedy.

- Transformers.js parses the output with the regex `([^<]+)?<loc_x1><loc_y1><loc_x2><loc_y2>`.
- It returns `{ labels: string[], bboxes: number[][] }`. A box without its own label repeats the previous label.
- The app ignores the boxes and processes the labels:

```
counts = Map
for l in od.labels ?? []: label = l.trim().toLowerCase(); if label: counts[label]++
objects = [...counts].map(([label,count]) => ({label, count}))
          .sort((a,b) => b.count - a.count || a.label.localeCompare(b.label))
```

Objects are sorted by count descending, then by label (`localeCompare`). There is no threshold and no limit.

### Keywords and embedding (CLIP)

```
LOGIT_SCALE = 100; MAX_KEYWORDS = 12
embedding = unit(vision(processor(image)).image_embeds.data)
sims[i]   = dot(embedding, vocabEmbedding[i])           // cosine, both unit length
max       = max(sims)
p[i]      = exp(100 * (sims[i] - max)) / Σ exp(100 * (sims[j] - max))   // softmax over the vocabulary
keywords  = words.map((label,i) => ({label, score: p[i]}))
             .filter(w => w.score >= threshold)          // keywordThreshold, 0.05 for both CLIP models
             .sort((a,b) => b.score - a.score)
             .slice(0, 12)
return { keywords, embedding }
```

- `unit(v)` divides by the L2 norm; a zero norm is treated as 1.
- The vocabulary text embeddings come from the prompt template `a photo of <word>`. Text batches hold 64 strings, with `padding: true` and `truncation: true`. Each `text_embeds` row is L2-normalised.
- `score` is the softmax share, between 0 and 1. With threshold 0.05, at most 20 words could pass in theory; the cap is 12.
- Tests (real models) pin 1 to 12 keywords; `lake` is among those for the lake fixture.

### Text embedding (search by meaning)

`embedText(text)` runs the CLIP text model on the raw query (no `a photo of` prefix), batch of 1, and returns the unit-length vector.

### Embedding dimensions

The code never fixes a dimension. It uses `text_embeds.dims[1]` and whatever `image_embeds` holds, and `cosine` in `app.ts` uses the shorter of the two lengths. The dimension is whatever the model's projection produces. That is normally 512 for ViT-B/32 (CLIP base) and 768 for ViT-L/14 (CLIP large), but this is not asserted anywhere; a test fixture uses 512. Vectors are always unit length, which tests check to 4 decimal places.

---

## The tagging queue

`TaggingQueue` in `photo-tool/server/tagging/queue.ts`. There is one per server.

Dependencies:

- `catalog`, `backend`, `dataDir`, `catalogue` (default `MODEL_CATALOGUE`);
- `imageOf(photo)`;
- `albumTags` (the sidecar sync: `save`, `holds`, `retryDeferred`, `hasDeferred`);
- `onPassEnd` (wired to `albumStore.flush()`);
- `deferRetryMs` (default 30,000).

### Concepts

- **Job:** the open folder's scan result. Its `id` is the scan job id, and `photos()` returns the live photo list, which only grows during a scan and has entries replaced in place by a refresh. Only one job exists at a time.
- **Content key:** `photo.contentKey` is the sha1 of the raw RGB pixels of the upright 1600 px thumbnail (`contentKeyOf` in `photo-tool/server/scanner.ts`). Results are keyed by `(contentKey, modelId)`, so a renamed, moved or duplicated picture is looked at once. Photos without a content key are never tagged and are not counted.
- **Active models:** for each part in the order `describe`, `keywords`, the chosen id counts if all of the following hold:
  - it is in the catalogue and belongs to that part;
  - the part is not `broken`;
  - the model is installed.
  
  If it is installed with `ok: false`, the part is marked `broken` and skipped.
- **broken** (`notWorking`): the set of parts whose model is damaged, failed to load, or was lost `MAX_LOSSES = 3` times in a row. It is cleared by `refresh()` and `setSettings()`; `setSettings` calls `refresh`.
- **seen / failedKeys / looked:** per-model sets of content keys.
  - `looked` records keys already queried from the catalogue, so each key is queried once per model.
  - `seen` holds keys with any row.
  - `failedKeys` holds keys with a `failed` row.
  - `learn()` fills these lazily in batches through `catalog.tagsFor`. A test pins that each photo is looked up about once in a big folder.
- **gone:** paths found deleted during this job. They are never picked again in the job, and the set is cleared when the job id changes or on `clearJob`. It is keyed by path, so another file with the same picture is still tagged.
- **cursor:** the index into `photos()` before which nothing needs work. It resets to 0 on `startJob`, `setSettings`, `wake`, on `forget` with keys, and when deferred folders exist.
- **stamp:** an integer that increments after each photo's rows are written and after each regenerate. The page uses it to know when to reload.

### Public API

| Method | Effect |
|---|---|
| `startJob(jobId, photos)` | Called by the scanner's `onDone` for the last-opened, non-cancelled job. Clears `gone` if the job id changed, sets the job, resets the cursor and kicks. Focus sent during the scan is kept. |
| `clearJob()` | Folder closed or another being opened. Sets `paused = false`, `job = null`, focus `[]`, and clears `gone`. The photo in hand finishes but its results are discarded. |
| `focus(paths)` | Keeps `paths.slice(0, 1000)` as the priority order. |
| `forget(contentKeys)` | Removes those keys from `looked`, `seen` and `failedKeys` for every model, and resets the cursor if any were given. Used after sidecar rows arrive. |
| `setSettings(s)` | Copies the settings, resets the cursor, then `refresh()`. |
| `wake()` | Resets the cursor and kicks. Called when `/api/gallery/refresh` re-reads a photo. |
| `refresh()` | Clears `broken` and `losses`, then kicks. Called when models change. |
| `status()` | Returns `TaggingStatus`; see below. |
| `embedText(text)` | Used by search; see below. |
| `regenerate(photo)` | See below. |
| `stop()` | Sets `stopped`, clears the defer timer, sets `job = null`, awaits the loop, then `backend.close()`. |

### Main loop

```
kick():
  if loop running or stopped or no job or paused: return
  problem = null
  loop = run().catch(e => problem = e.message)
             .finally(() => {
                loop = null
                try onPassEnd() catch {}                    // flush sidecars
                retryHeldLater()                            // 30 s timer if folders are held
                if !problem && job && job !== jobAtStart: kick()  // folder changed during a load
             })

run():
  forever:
    job = this.job; if !job or stopped or paused: return
    models = ensureLoaded(activeModels())       // loads each, one shared promise per model id
    if this.job !== job: continue
    if models empty: return
    photos = job.photos()
    held = albumTags.hasDeferred()
    if held: changed = albumTags.retryDeferred(); forget(changed); cursor = 0
    learn(models, photos)
    photo = next(models, photos); if !photo: return
    tag(job, photo, models)
    for m in models:
      if m.part was lost during this photo:
        unload marker (delete loaded[part]); losses[part]++
        if losses[part] >= 3: broken.add(part)
      else delete losses[part]
    lost.clear()
```

### Ordering and priority (`next`)

A photo needs work ("todo") when all of these hold:

- it has a content key;
- its path is not in `gone`;
- some active model has not `seen` its key;
- `albumTags.holds(photo)` is false.

The order is:

1. **Focus list first**, in order. The page sends the selected photo, then the first 200 visible grid items.
2. Then **scan order**: advance the cursor past non-todo photos and return `photos[cursor]`.

There is no other priority. Concurrency is **one photo at a time**. For each photo, the active models run sequentially: describe, then keywords.

### Tagging one photo (`tag`)

```
if !exists(photo.path): gone.add(path); return
image = imageOf(photo) (errors swallowed → image = null)
for m in models:
  if seen[m].has(key): continue
  base = {contentKey, modelId: m.id, description: null, keywords: [], objects: [], embedding: null, error: null}
  try:
    if !image: throw "Couldn't read the photo."
    describe → row {status:'done', description, objects}
    keywords → row {status:'done', keywords, embedding}
  catch BackendLostError: lost.add(m.part); continue        // not the photo's fault, retried
  catch e: row {status:'failed', error: e.message}
  if job changed or stopped: break
if job changed or stopped or !exists(path) or path no longer in job.photos():
  if same job and not stopped: gone.add(path)
  return                                                    // nothing written
same = [photo, ...other job photos with the same contentKey]
for each row: catalog.putTags(row); albumTags.save(same, row); seen.add(key); if failed: failedKeys.add(key)
stamp++
```

### Retries and failure states

- **Photo-level failure.** Any non-lost error from the model, or an unreadable thumbnail, stores a `failed` row with the message. Failed rows count as seen, so they are **not retried** for that model; there is no retry button. They are never written to the album sidecar, so they are retried after the album is moved to another computer or catalog. Switching the part to another model re-tags everything for that part.
- **Backend lost.** If the worker restarted or crashed mid-request, the photo is not marked failed:
  - the model's loaded marker is dropped, it is reloaded on the next iteration, and the photo is picked again;
  - after 3 consecutive losses for a part (`MAX_LOSSES`), the part becomes `broken` and shows as not working;
  - a successful photo resets the part's loss count.
- **Model load failure** (`loadModel`):
  - the loaded marker is deleted;
  - `verifyModel` deletes files with a wrong hash (errors ignored);
  - the part is marked `broken`, and `loadModel` returns false.
  
  A crash during a load rejects with `ModelLoadError`, so it marks the part broken immediately rather than counting as a loss. Loads are shared through a per-model-id promise map, so concurrent callers (the loop, search, regenerate) trigger one load.
- **Problem.** An exception escaping `run()` stops the loop, for example `catalog.putTags` throwing. It is stored in `status.problem`, and nothing is thrown to callers. `problem` is cleared on the next `kick()`.
- **Folder changed during a model load.** The `finally` handler re-kicks for the new job. A test pins that a folder opened while a model loads is tagged once the load finishes.

### Pause and resume

- `paused` lives only in the queue's memory. `PUT /api/gallery/tagging/settings` with `paused: true` sets it through `setSettings`. The loop finishes the current photo, sees `paused`, and returns; `onPassEnd` flushes sidecars.
- Resume (`paused: false`) calls `setSettings`, then `refresh`, then `kick`.
- Pause is **never saved**. The file always gets `paused: false`, the server start forces `paused: false`, and `clearJob` resets it, so a pause holds until Resume or until the next folder opens. Pinned by `gallery-tagging-app.test.ts`.
- `status()` still counts done and failed while paused. It learns from the catalog, so a folder already tagged shows "N of N" rather than "0 of N" (test).

### Held folders (sidecar unreadable)

If an album folder's `phototool-tags.json` exists but cannot be read right now (for example locked by a sync engine or offline), `AlbumTags` holds that folder's photos:

- They are not tagged, because fresh output would compete with what the file holds.
- They are held for at most `maxHoldMs = 600,000` (10 minutes) from first detection. After that they are tagged, results stay in the catalog, and the file is never overwritten.
- While anything is held, each loop iteration calls `retryDeferred()` to re-sync those folders, and when a pass ends, a 30 s timer (`deferRetryMs`) re-kicks the loop.

### Status

`GET /api/gallery/tagging/status` returns `TaggingStatus`:

```ts
interface TaggingStatus {
  job: string | null;     // current job id
  total: number;          // job photos with a content key
  done: number;           // photos every active model has seen (or path in `gone`)
  failed: number;         // photos with a failed row from any active model
  paused: boolean;
  running: boolean;       // loop in progress
  notWorking: TagPart[];  // broken parts, in order describe, keywords
  stamp: number;
  problem: string | null; // why tagging stopped on its own
}
```

The counting rule, per photo with a content key, applied only when at least one model is active:

- if its path is in `gone`, it counts as done;
- else, if any active model has a failed row, it counts as failed (failed takes precedence);
- else, if every active model has seen it, it counts as done.

`status()` calls `learn()` when a job exists, so counts are correct even when the loop is not running. `activeModels()`, which status also calls, can mark parts broken as a side effect.

### Regenerate

`regenerate(photo)` writes a new, sampled description for one photo and replaces only the sentence. It runs whether tagging is paused or not, loads the model if needed, and waits in the worker queue behind any photo being tagged.

```
m = active describe model; if none → NoDescriptionError('There is no working descriptions model. Choose one in Settings.')
own = catalog.tagsFor([key],[m.id]) row
if no key or own.status != 'done' → NoDescriptionError('<label> has not described this photo yet.')
image = imageOf(photo)
for tries = 0..:
  if stopped → Error('Tagging stopped.')
  if !loadModel(m) → NoDescriptionError('<label> would not load. See Settings.')
  try:
    text = backend.caption(image).trim()
    if !text → Error('<label> wrote an empty description. Try again.')      // empty sampled caption is an error; nothing saved
    if !catalog.setDescription(key, m.id, text) → NoDescriptionError('<label> has not described this photo yet.')
    row = catalog.tagsFor(...); albumTags.save(samePicture(photo), row, 'replace')
    stamp++; return text
  catch BackendLostError and tries < 1: drop loaded marker; retry once
  catch other: rethrow (old text kept)
```

`catalog.setDescription` runs `UPDATE tags SET description=?, made_at=? WHERE content_key=? AND model_id=? AND status='done'`. Objects, keywords and embedding are untouched. No other photo is looked at again.

### Search embedding

`embedText(text)` looks for the active keywords model. With none, or when stopped, or when the load fails, it returns `null`. It tries at most twice: on a `BackendLostError` it drops the loaded marker and tries again, and it returns `null` after the second loss. Any other error is rethrown, and the route turns it into an empty result. It loads the model even when tagging has not (paused, or a new session); pinned by `gallery-search.test.ts`.

---

## What is written where

### Catalog SQLite (`<dataDir>/gallery.sqlite`)

The database runs with WAL and `synchronous = NORMAL`. Tables used by tagging (from `photo-tool/server/catalog.ts`):

```sql
CREATE TABLE IF NOT EXISTS tags (
  content_key TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  status      TEXT NOT NULL,          -- 'done' | 'failed' (anything not 'failed' reads as 'done')
  description TEXT,                   -- describe models
  keywords    TEXT,                   -- JSON [{label, score}]
  objects     TEXT,                   -- JSON [{label, count}]
  embedding   BLOB,                   -- raw float32 bytes (platform byte order) of the unit vector; keywords models
  error       TEXT,                   -- failed rows
  made_at     INTEGER NOT NULL,       -- Date.now() ms
  PRIMARY KEY (content_key, model_id)
);
CREATE TABLE IF NOT EXISTS file_keys (
  path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, file_key TEXT
);
-- photos.content_key TEXT was added by ALTER TABLE for catalogs made before tagging
```

| Catalog method | SQL / behaviour |
|---|---|
| `putTags(row)` | `INSERT OR REPLACE`. `keywords` and `objects` are stored as `JSON.stringify` (an empty array becomes `'[]'`); `made_at = Date.now()` |
| `setDescription(key, model, text)` | Updates a done row only; returns whether a row changed |
| `tagsFor(keys, modelIds, withEmbedding=false)` | Batches of 500 keys; returns `Map<contentKey, TagRow[]>`. `embedding` is `NULL` unless asked for |
| `embeddings(keys, modelId)` | `tagsFor(..., true)`, keeping only rows that have an embedding |
| `fileKey(path,size,mtime)` / `putFileKey` | Cache of the photo-file fingerprint used by sidecar matching |

The catalog keeps rows for every model ever used. They are never deleted when the model changes or is removed.

### Album sidecar files

These are written through `AlbumTags.save` and `AlbumTagsStore.put`, in `shared/phototags`. Results live in each photo's own folder; the catalog is only a cache of them. The full file format and the merge rules are in the data-formats section. The rules tagging relies on:

- **Files.** `phototool-tags.json` has format `"phototool-tags/1"` and is pretty-printed. `phototool-tags.vectors.json` has format `"phototool-vectors/1"`, is written on one line, and holds each embedding as base64 of little-endian float32 values. Both are keyed by **file name** (no path), then by model id:

  ```ts
  // phototool-tags.json
  { format: 'phototool-tags/1', photos: { [fileName]: { models: { [modelId]: {
      contentKey: string; fileKey?: string /* "fk1:<size>:<sha1(size\0 + first 16 KiB + last 16 KiB)>" */;
      description?: string; objects?: {label,count}[]; keywords?: {label,score}[]; madeAt?: string /* ISO */;
      [unknown]: kept } } } } }
  // phototool-tags.vectors.json
  { format: 'phototool-vectors/1', photos: { [fileName]: { models: { [modelId]: {
      contentKey: string; fileKey?: string; madeAt?: string; data: string /* base64 LE float32 */ } } } } }
  ```

  Empty `objects` or `keywords` arrays and a null description are omitted.
- **What is saved.** Only `done` rows are saved, never failed ones. Each row is saved for every photo of the job with the same content key (copies).
- **Modes.**
  - `keep` (tagging, migration): an existing result for the same picture (same content key, or same file key) wins. The only change is that it gains a missing `fileKey`.
  - `replace` (Regenerate): the new result wins, and unknown fields of the old result are kept.
  
  A pending `replace` is not undone by a later `keep` for the same picture.
- **Write timing.**
  - Results are batched in memory and written 60 s after the last result (`debounceMs`), at most 300 s after the first one waiting (`maxWaitMs`).
  - They are also written immediately on `flush()`: at the end of each pass, when a folder is opened or closed, and on server close.
  - A failed write is retried after 30 s, doubling up to 10 min.
  - Writes are atomic: a temp file `~$<name>.<8 hex>.tmp`, then fsync, then rename. A busy rename is retried after 50 ms and again after 150 ms.
- **Read-only folders.** On `EACCES`, `EPERM` or `EROFS`, the file goes to `<photoInfoFallbackDir>/phototool-tags/<sha1(folder path)>.json` (and `.vectors.json`), which records the folder path. When the folder becomes writable again, the two are merged and the fallback is removed.
- **Damaged or missing files.**
  - An unparsable or newer-format file is never written over (status `broken`).
  - A file that cannot be read right now is never written over (status `unreadable`, held as described above).
  - A folder that is gone (`ENOENT`, `ENOTDIR`) drops its pending results.

**Import into the catalog** (`AlbumTags.sync`) runs in the scanner's `onPhoto` for every photo read. Its output goes into `tagging.forget(...)`. For each photo and each model id (catalogue ids plus ids found in the file):

- **Lookup order.** The pending result under the file name comes first. Then the entry under the file name with a matching content key, then any entry with the same content key (a rename), then an entry with the same file key. The file key is computed only when the size could match.
- **Folder wins.** If the folder's result differs from the catalog row (description, objects, keywords, or vector), it replaces the catalog row as `done`, under this computer's content key.
- **Missing vector.** A keywords result without a vector takes the catalog's vector if there is one. Otherwise it is skipped, so the model redoes it.
- **Migration.** A done catalog row that the folder lacks is written out once.
- **Renamed or copied photo.** The result is also written under the new name.

---

## Tagging HTTP routes (in `photo-tool/server/app.ts`)

All bodies are JSON. Errors are `{ error: string }`. An `HttpError` uses its status; anything else is 500 with the message.

| Method & path | Input | Success | Errors |
|---|---|---|---|
| `GET /api/gallery/tagging/status` | — | 200 `TaggingStatus` | — |
| `POST /api/gallery/tagging/focus` | `{ job: string, paths: string[] }` | 204. Applied only if `job` is the last-opened job, else ignored | 400 "Send the job and a list of paths." |
| `POST /api/gallery/tagging/close` | `{ job: string }` | 204. `clearJob()` if `job` is the last-opened job; always `albumStore.flush()` | 400 "Send the job." |
| `POST /api/gallery/tagging/regenerate` | `{ job: string, path: string }` | 200 `PhotoTags` for the photo, after the change | 400 "Send the job and the photo path."; 404 "That folder is no longer open. Open it again." (job not last-opened); 404 "That photo is not in the open folder any more." (path not in the job, or the file is gone); **409** for `NoDescriptionError` (message as above); **500** for any other failure: a backend error, an empty caption ("… wrote an empty description. Try again."), a backend lost twice, or "Tagging stopped." |
| `GET /api/gallery/search?job=&q=` | query `job`, `q` | 200 `{ paths: string[] }` | 404 if `job` is unknown ("That folder is no longer open. Open it again.") |
| plus the model and settings routes | | see "Model and settings HTTP routes" | |

**Other routes with tagging side effects:**

- `POST /api/gallery/open` calls `tagging.clearJob()`, `albumStore.flush()` and `albumStore.invalidate()`, so sidecars are re-read fresh.
- `POST /api/gallery/refresh` calls `tagging.wake()` for each re-read photo.
- The scanner's `onDone` calls `startJob` for the newest non-cancelled job.
- Server `close()`:
  - stops the model routes;
  - calls `tagging.stop()`, which terminates the worker and drops the photo in hand; nothing is written after close;
  - calls `albumStore.close()`, which flushes;
  - closes the catalog.

### `PhotoTags` (on every gallery item, and the reply to regenerate)

```ts
interface PhotoTags {
  state: 'off' | 'waiting' | 'done' | 'failed';
  description: string | null;
  keywords: string[];                          // labels only, at most MAX_KEYWORDS = 12, score-descending
  objects: { label: string; count: number }[];
  canRegenerate?: true;                        // present only when the shown description is the chosen describe model's own
}
```

`tagsOf(photos)` reads `tagging.json`. Embeddings are never sent to the page.

- **Off.** If neither part is chosen, every photo gets `{state:'off', description:null, keywords:[], objects:[]}`.
- **Waiting.** `state` is `waiting` if any chosen model has no row for this content key.
- **Failed and done.** Otherwise `state` is `failed` if any chosen model's row is failed, else `done`.
- **What is shown for each part.** The chosen model's own row is shown if it exists, even when that row is failed. Only when the chosen model has no row yet is a `done` row from **another model of the same part** shown. So after switching from base to large, the base results stay visible, with state `waiting`, until the large model has looked (test).
- **Field rules.**
  - `description` and `objects` come from the shown describe row if it is done.
  - `keywords` come from the shown keywords row if it is done, sorted by score and cut to 12 labels.
  - `canRegenerate: true` is set when the shown describe row is done and belongs to the chosen describe model.

### Search by meaning

```
text = q.trim()
if count of Unicode letters (\p{L}) in text < 3: return {paths: []}
found = tagging.embedText(text) (errors → null)
threshold = found.model.meaningThreshold          // 0.27 CLIP base, 0.24 CLIP large
if !found or threshold undefined: return {paths: []}
photos = job.photos with a contentKey whose file still exists
emb = catalog.embeddings(unique content keys, found.model.id)
for p in photos with an embedding:
  score = cosine(found.embedding, emb)            // dot / (|a||b|) over min length; 0 if a norm is 0
  keep if score >= threshold
sort by score descending; return first SEARCH_MAX = 200 paths
```

- Only embeddings from the **currently chosen** keywords model are used.
- Photos that model has not seen do not appear.
- Copies with the same content key appear once per path; nothing is de-duplicated.

Pinned by tests:

- The query `seaside` returns `harbour.jpg` then `harbour-boat.jpg`.
- `lake` returns only `lake.jpg`.
- `se` and `  a 1 2 b  ` return `[]`, because they have fewer than 3 letters.
- With describe-only chosen, the result is `[]`.
- An unknown job returns 404.
- Search works while paused, in a fresh server session.

### Text search over tags (client side)

`photo-tool/core/gallerySort.ts`:

- The text filter matches case-insensitively over the user's own description and notes, plus the tags' description, keywords and object labels.
- `filter.tags: { kind: 'keyword' | 'object', value }[]` requires every listed chip: a keyword must appear in `keywords`, and an object in `objects[].label`.

---

## The page

### Settings → Photo tagging (`TaggingSettings.tsx`, inside the Settings dialog)

**Heading and intro.** The heading is "Photo tagging", with the intro "Runs on this computer. The models are downloaded from Hugging Face only when you ask, and nothing else leaves the computer."

**Loading.** On mount it fetches `GET /api/gallery/models`, showing "Loading photo tagging…" until the reply arrives (or the error text if the request fails).

**Layout.** There is one fieldset per part, with the title and note given earlier. Each fieldset has a radio for **Off**, then each model of the part, smaller first.

**Each model row** shows:

- `<label> (<size>)`;
- `<formatBytes(total)> · about <N> s a photo · <licence>`. `formatBytes`:
  - gives `X.X GB` at 1e9 bytes or more;
  - otherwise gives MB, rounded when 10 MB or more and to one decimal below that.
  
  The speed shows "about under 1 s a photo" when `secondsPerPhoto` is under 1, otherwise the rounded number.
- a radio that is disabled unless the model is installed with `ok: true`.

**Model row actions:**

| State | Shows |
|---|---|
| This model is downloading | A progress bar (`role=progressbar`, width `received/total`) and **Cancel**, which calls `POST …/download/cancel` |
| Installed, ok, and not (chosen and failing) | **Remove**, which calls `DELETE /models/:id` |
| Installed but not ok, or chosen and in `notWorking` | **Not working · Download again**, which opens the confirm. When `ok`, **Remove** is also shown |
| Not installed | **Download**, which opens the confirm. It is disabled while any download runs |

**Confirm.** An inline `alertdialog` asks "Download <label>, <size>, from Hugging Face?" with **Cancel** and **Download**; Download is autofocused and calls `POST /models/:id/download`.

**Choosing a radio.** The new choice is applied optimistically and sent with `PUT /tagging/settings`. The state is then reloaded, so a server refusal reverts it.

**Progress polling.** While a download runs, the state is reloaded every 500 ms.

**Errors.** Errors from an action, or `state.error`, appear in a `role=alert` paragraph.

### Progress bar (`TaggingProgress` in `Progress.tsx`, shown when a folder is open)

The page keeps `tagging: TaggingStatus | null`, set only when `status.job` equals the open job.

| Condition | Shows |
|---|---|
| No status, or `total === 0` | nothing |
| `problem` set and not running | "Tagging stopped: <problem>" with **Try again**. Try again calls `setTaggingPaused(false)`: it re-reads `/models` for the settings, then sends `PUT /tagging/settings` with `paused: false`. That leads to `setSettings`, `refresh`, `kick`, and clears `problem` |
| `running`, or (`paused` and `done + failed < total`) | A bar at `done/total`, the text "Tagging {done} of {total}" (locale-formatted), " · paused" when paused, and a **Pause** / **Resume** button |
| otherwise (finished) | nothing |

**Pause and Resume** call `setTaggingPaused(p)`, which updates the local status optimistically (`running = running && !paused`). An error raises a toast.

### Polling and reloading (`web/store.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `TAG_POLL_MS` | 1000 | status poll interval while `running` |
| `STAMP_POLL_MS` | 3000 | status poll interval otherwise |
| `TAG_REFRESH_MS` | 10,000 | minimum interval between item reloads while tagging runs |
| `TAG_REFRESH_MS_PER_PHOTO` | 6 | reload interval is at least `items.length × 6 ms` (10,000 photos gives one reload a minute) |
| `FOCUS_COUNT` | 200 | visible items sent as focus |
| `FOCUS_DEBOUNCE_MS` | 500 | focus debounce |
| `MEANING_DEBOUNCE_MS` | 300 | search-by-meaning debounce |
| `MEANING_MIN_LETTERS` | 3 | letters needed |

`watchTagging(gen, job)` runs in a loop:

1. Fetch the status. Errors are ignored.
2. Store it in `tagging`, or `null` if it is for another job.
3. If the stamp differs from `tagSeen` and the folder is not being scanned (`progress === null`), reload the items (`refreshInfo()`). This happens when any of these hold:
   - it is the first reading (`tagSeen === null`);
   - tagging is not running (one final reload when it stops);
   - at least `max(10 s, items × 6 ms)` has passed since the last reload.
4. Schedule the next poll after 1 s if running, else 3 s.

`tagSeen` and `tagRefreshedAt` reset when a folder changes.

**Focus.** A store subscription fires whenever the job, selection, items, filter, sort, stacking or open stacks change. After 500 ms it computes the paths and sends them with `POST /tagging/focus`, unless the job plus paths key is unchanged since the last send. Errors are ignored.

- The paths are the selected photo first, then the first 200 visible items, without repeating the selection.

**Closing the folder** sends `POST /tagging/close` (errors ignored) and clears `tagging` and `meaning`.

### Search by meaning on the page

When the search text changes, `searchByMeaning()` checks three conditions:

- a job is open;
- the trimmed text has at least 3 letters;
- at least one item has `tags.state !== 'off'`.

If they hold, after 300 ms it calls `GET /api/gallery/search` and stores `meaning = { q, paths }`. Only the newest request's reply is used, via a sequence number. A failure only loses the extra matches.

The visible list is built from:

1. the word matches, using the normal filter;
2. then the meaning-only extras: `meaning.paths` not already among the word matches, in server order, that pass the other filters (with the text filter removed), never stacked.

The grid starts the extras on a fresh row, after a note row "Also matching by meaning" (`Grid.tsx`, `selectMeaningStart`). The filtered count includes them.

### "What's in it" panel (`WhatsInIt.tsx`)

This is a collapsible `Section` with id `whatsinit` and title "What's in it", in the Details/info panel (`Details.tsx`), between the file facts and Camera.

| State | Shows |
|---|---|
| `state === 'off'` | "Tagging is off." plus a **Settings** link that opens the Settings dialog |
| any part `notWorking` | the error note "Not working: a chosen model is damaged or would not load. See Settings." |
| `waiting` with nothing to show | "Not looked at yet" |
| `failed` | the error note "Couldn't look at this photo" |
| description | a paragraph. Its tooltip is "Written by <describe model label>", where the label comes from `/models` and is re-read whenever Settings closes |
| description and `canRegenerate` | a **Regenerate** button (tooltip "Ask <label> to describe this photo again"). While busy it reads "Writing a new description…", is disabled and has `aria-busy` |
| keywords | the label "Keywords" and a chip per keyword |
| objects | the label "Objects" and a chip per object; the chip text is `label ×count` when count > 1 |

- **Chips.** Each chip toggles a tag filter (`toggleTagFilter`) with `aria-pressed`. The tooltip is "Show only photos with this" or "Stop filtering by this".
- **Regenerate busy state.** It lives in a module-level set keyed by path, so it survives folding, closing and switching photos, and a second request for the same photo is not sent.
- **Regenerate result.** On success, the item's `tags` are replaced from the reply, unless another folder was opened meanwhile. On error, a toast shows the server message.

---

## Network rules

- **The models never touch the network.** The worker sets `allowRemoteModels = false` and uses `local_files_only`.
- **Downloads are the only network use, and only on request.** A model's files come from Hugging Face only when the user confirms Download in Settings. Nothing is downloaded automatically or in the background, and there are no update checks for models.
- **Download guard.** The download is made by the **Node server process** (the Electron utility process in the desktop app) with global `fetch`. It is constrained only by `isAllowedModelUrl` on every redirect hop, and by HTTPS to pinned commits with SHA-256 verification.
- **`netGuard` does not cover downloads.** `shared/electron/netGuard.ts` (`isAllowedRequest`, `isAppNavigation`, `hostResolverRules`) guards the **browser window's** requests and Chromium's DNS. It does not apply to model downloads:
  - The window's `onBeforeRequest` filter (`galleryRequestAllowed` in `photo-tool/electron/mapTiles.ts`) allows only the app's own `127.0.0.1` ports, `data:`, and map tiles once the user allows them.
  - Photo Tool's Chromium `host-resolver-rules` are `MAP * ~NOTFOUND` with exclusions only for `127.0.0.1`, `localhost`, the tile host and the update hosts. There is no Hugging Face host.
  - The page never contacts Hugging Face itself.
- **User-facing statement.** The desktop app's offline notice (`shared/electron/config.ts`) lists model downloads among the three network uses: "to download photo-tagging models from Hugging Face when you ask for one in Settings".
- **Offline behaviour.**
  - A download fails with the fetch error ("Couldn't download <label>: …") and keeps its `.part` files, so it resumes on the next attempt.
  - Installed models work fully offline.
  - Search by meaning and Regenerate need no network.
  - Album sidecars on an offline or locked cloud drive are held (see above), not overwritten.
- **Local only.** The server binds to `127.0.0.1` only.

---

## Constants summary

| Name | Value | File |
|---|---|---|
| `LOGIT_SCALE` | 100 | `server/tagging/worker.ts` |
| `MAX_KEYWORDS` (worker) | 12 | `server/tagging/worker.ts` |
| `MAX_KEYWORDS` (items) | 12 | `server/app.ts` |
| `SAMPLING` | `{do_sample: true, temperature: 0.7, top_k: 50}` | `server/tagging/worker.ts` |
| caption task / max tokens | `<MORE_DETAILED_CAPTION>` / 100 | `server/tagging/worker.ts` |
| objects task / max tokens | `<OD>` / 256 | `server/tagging/worker.ts` |
| vocabulary prompt | `a photo of <word>` | `server/tagging/worker.ts` |
| text embed batch | 64 | `server/tagging/worker.ts` |
| `keywordThreshold` | 0.05 (both CLIP) | `core/tagModels.ts` |
| `meaningThreshold` | 0.27 base, 0.24 large | `core/tagModels.ts` |
| `SEARCH_MAX` | 200 | `server/app.ts` |
| search min letters | 3 (`\p{L}`) | `server/app.ts`, `web/store.ts` |
| worker threads | `max(1, floor(cpus/2))`, inter-op 1 | `server/app.ts` |
| `MAX_LOSSES` | 3 | `server/tagging/queue.ts` |
| focus cap (server) | 1000 | `server/tagging/queue.ts` |
| `deferRetryMs` | 30,000 | `server/tagging/queue.ts` |
| `maxHoldMs` | 600,000 | `server/tagging/albumTags.ts` |
| `MAX_REDIRECTS` | 5 | `server/models/download.ts` |
| sidecar debounce / max wait | 60 s / 300 s | `shared/phototags/store.ts` |
| sidecar retry | 30 s doubling to 600 s; unreadable re-read 10 s | `shared/phototags/store.ts` |
| `IN_BATCH` (catalog) | 500 | `server/catalog.ts` |
| self-test ping timeout | 30 s | `electron/selfTest.ts` |
| page polling | see the table in "Polling and reloading" | `web/store.ts` |

---

## Development measurement script

`scripts/tagging/measure.ts` is not part of the app. It was used to choose the models and thresholds. It runs with `npx tsx scripts/tagging/measure.ts --cache <dir> [--only florence|clip] [--dtype q8]`.

- It downloads candidate models through Transformers.js' own cache: `env.cacheDir = <dir>` with `allowLocalModels = false`, so it uses the network, unlike the app.
- It runs each model on the JPEGs in `fixtures/generated/trip`.
- It prints sizes, load time, seconds per photo and outputs.
- It uses a short draft vocabulary and a few test phrases. The final list is `vocabulary.ts`.

### Open points

1. **`PUT /api/gallery/tagging/settings` accepts an incomplete model.** It checks `installed.has(id)`, which includes models with `ok: false`. The queue then marks that part broken at once. The page disables such radios, so only a direct API call can choose one.
2. **Embedding dimensions are not fixed or validated anywhere.** If two vectors of different lengths reached `cosine` (for example from a hand-edited sidecar), it would silently compare only the overlapping prefix.
3. **The `describe` op's `sample` flag is dead protocol.** The backend never sends it.
4. **`tagging.json`'s `paused` field is effectively dead.** It is always written as `false`, and `createGalleryApp` forces `false` at start. A comment in `web/store.ts` ("kept in Settings") is stale.
5. **Failed rows are permanent for a model in a catalog.** No UI or route retries failed photos. Only switching models, or a sidecar import of a done result, replaces them.
6. **Worker requests have no timeout.** A model run that hangs without the worker crashing stalls tagging, regenerate and search (except search's `embedText`, which still queues behind a pending keywords load).
7. **Florence prompt text is not set by the app.** It comes from each model's `preprocessor_config.json` (`task_prompts_without_inputs`). I did not open the model files, so the exact prompt strings are not quoted here.
8. **Search results are not de-duplicated by picture.** Identical copies (same content key, different paths) each appear.
9. **`netGuard` and `host-resolver-rules` do not constrain the server process.** The code does not state whether Chromium's resolver rules affect Node's `fetch` inside an Electron utility process. The model download relies only on `isAllowedModelUrl`, and in practice it reaches Hugging Face, since the offline notice promises it.
10. **Development worker loading is not shown in code.** A `.ts` worker started with `new Worker(path)` presumably works because `tsx` (development) and vitest (tests) make `.ts` loadable in worker threads.
11. **`status()` mutates state.** It calls `activeModels()`, which can add parts to `broken` merely from being polled.
