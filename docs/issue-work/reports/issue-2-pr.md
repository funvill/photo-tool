Title: Photo Tool: Regenerate button for the auto-written description in "What's in it"

Closes #2

## What was built

- **Worker** (`photo-tool/server/tagging/worker.ts`): a new `op: 'caption'` runs only the `<MORE_DETAILED_CAPTION>` task, sampled with `do_sample: true, temperature: 0.7, top_k: 50`. `describe` takes an optional `sample` flag for its caption part. Object detection (`<OD>`) is never sampled. I checked Transformers.js 4.3.2 in `node_modules`: `do_sample` picks the multinomial sampler before beam search, temperature goes through `TemperatureLogitsWarper`, and the sampler applies `top_k`.
- **Backend** (`photo-tool/server/tagging/backend.ts`): `TaggerBackend.caption(imagePath): Promise<string>`, wired to the new op. The fake backend (`PHOTO_TOOL_FAKE_TAGGING`) returns `Another look at <words> (n).` with a counter, so every call gives new text. It waits the same `delayMs` as the other calls.
- **Catalogue** (`photo-tool/server/catalog.ts`): `setDescription(contentKey, modelId, text)` updates only the description of a done `tags` row. Objects, keywords and embedding stay as they are. It returns false, and writes nothing, when the row is missing or failed.
- **Queue** (`photo-tool/server/tagging/queue.ts`): `regenerate(photo)`.
  - It finds the active describe model and loads it if needed, so it works while tagging is paused (like `embedText`).
  - It reads the image through `imageOf` and calls `backend.caption`.
  - On `BackendLostError` it loads the model again and retries once.
  - It then writes the new text with `setDescription` and bumps `stamp`.
  - It throws `NoDescriptionError` when there is no describe model that is chosen, installed and working; when the model won't load; or when that model has no done description of the photo yet.
- **Route** (`photo-tool/server/app.ts`): `POST /api/gallery/tagging/regenerate {job, path}`.
  - 400 for a bad body.
  - 404 when the job is not the folder open now, or the photo is not in it (or is gone from disk).
  - 409 for `NoDescriptionError`.
  - Any other failure keeps the error handler's 500 with the message.
  - On success it returns the photo's tags (from `tagsOf`).
- **PhotoTags**: a new optional `canRegenerate: true`. It is present only when the shown description is the chosen describe model's own done row.
- **Web**: `galleryApi.regenerateDescription(job, path)`. The store action `regenerateDescription(path)` patches that item's `tags` in place and returns true. On failure it shows an error toast, keeps the old text and returns false. It never rejects, and a reply that arrives after another folder was opened changes nothing.
- **UI** (`photo-tool/web/components/WhatsInIt.tsx`): a **Regenerate** button (`btn btn-small`) below the description.
  - It is shown only when `canRegenerate` is set.
  - While the request runs it reads "Writing a new description…" and is disabled (`aria-busy`).
  - Its accessible name is "Regenerate the description".
  - The busy state is kept per photo path in the component, which `Details.tsx` mounts without a key. Moving the selection to another photo and back, while the panel stays on screen, therefore still shows it busy. This is not covered by a test. If the panel is unmounted, the state resets; a second click would then only queue another regenerate.
  - One CSS line (`.gallery-whatsinit-regenerate { align-self: flex-start; }`) stops it stretching across the panel.
- **README** (`photo-tool/README.md`): one sentence about Regenerate under What's in it.

## Decisions I made

- **When the button shows.** I added an optional `canRegenerate` flag to `PhotoTags`. While a newly chosen describe model has not looked at a photo, `tagsOf` shows the other describe model's sentence, so a non-null `description` does not mean the chosen model wrote it. Gating on `state === 'done'` would also hide the button whenever the keywords model is still waiting on that photo. The flag is left off, not set to false, so existing `toEqual` assertions on tags only changed where a chosen-model description is present (one test).
- **The catalogue helper.** I added `setDescription` (a targeted `UPDATE`) rather than reading the row and calling `putTags` again. `tagsFor` returns rows without their embedding, so a read-then-replace would have wiped the keywords model's embedding if the ids ever overlapped. It also avoids a race with the tagging loop.
- **No description yet means 409.** Regenerate only replaces an existing description, as the issue says ("updates the existing row"), so a photo the chosen model has not described yet is refused with 409 and a message, not described for the first time.
- **404 for an older job.** Regenerate needs the folder that is open now, so the job must be the latest one. An older, still-cached job id is a 404 (the focus and close routes ignore older jobs in the same way).
- **Store test location.** The issue names `gallery-tags-store.test.ts` for the store test, but that file tests the server side (catalogue and items). The store's fetch-mocked tests live in `gallery-store.test.ts`, so the store tests went there, in their own `describe('#2 …')` block at the end. The `setDescription` test went into `gallery-tags-store.test.ts`, next to the other tag-row tests.
- No thumbs up/down and no stored feedback, as the issue says.

## Tests

- `gallery-tagger-backend.test.ts`:
  - a caption before load is refused with `BackendLostError` ("descriptions model is not loaded") from the real worker thread.
  - The real-model block (skipped unless `PHOTOBOOK_TAGGING_MODELS_DIR` is set) checks three sampled captions are sentences without tags and that at least one wording differs.
- `gallery-tags-store.test.ts`:
  - `setDescription` changes only the description and keeps the embedding; failed and missing rows are left alone.
  - The items test now expects `canRegenerate: true` on the chosen model's own description.
- `gallery-tagging-queue.test.ts` (`#2 regenerate a description`):
  - new text replaces old, objects and keywords are kept, `stamp` bumps, and nothing else is looked at again;
  - `NoDescriptionError` for no model, not installed, not described yet, and won't load;
  - a backend error is passed on with the old text kept;
  - a retry after a lost backend;
  - giving up when the backend is lost every time;
  - works while paused, without tagging other photos.
- `gallery-tagging-app.test.ts` (`#2 POST /api/gallery/tagging/regenerate`):
  - a new description is returned and kept in items;
  - works while paused;
  - 400, both 404s and both 409s;
  - a backend failure is a 500 with the old text kept;
  - another model's borrowed sentence has no `canRegenerate`.
- `gallery-store.test.ts` (`#2 gallery store: regenerate a description`):
  - the patch lands on that photo only;
  - a 409 is shown as a toast and the old text stays;
  - a late reply after another folder was opened changes nothing.
- E2E `photo-tool/tests/e2e/gallery.spec.ts` (`#2 Regenerate the description in What's in it`), with the fake model:
  - wait for "A picture of street.";
  - click Regenerate, with the request held, and see the disabled "Writing a new description…" button with the old text still shown;
  - see new text, then click again and see different text;
  - objects are kept;
  - reload, open the folder again and see the same new text.
- `npm run typecheck`, `npx vitest run` (77 files passed, 1 skipped) and `npx playwright test --project=photo-tool` all pass.

## Checked by hand

- The Transformers.js 4.3.2 source in `node_modules`: `getSampler`, `_get_logits_processor` and `MultinomialSampler`, for how `do_sample`, `temperature` and `top_k` are applied.

## Not done / not checked

- Real Florence-2 sampling was not run: the real models are not on this machine, and the real-model test is skipped without `PHOTOBOOK_TAGGING_MODELS_DIR`. How the sampled wording reads at temperature 0.7 is not checked.
- The button was not looked at in the desktop app or in dark theme. It reuses the existing `btn btn-small` style.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
