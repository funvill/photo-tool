# Review: issue #2, branch `regenerate-description` (a2d4c55)

Note for the controller: `gh issue view 2 --comments` printed nothing in this shell. I read the issue with `gh issue view 2 --json title,body,comments` instead (read only). It has no comments, so the body is the whole requirement.

Outside the diff I made two focused checks, both read-only, in the `photobook_helper-regen` worktree. First, `queue.ts` `tag()`, `next()` and `loadModel()`, to judge the race between Regenerate and a normal tagging pass. Second, `app.ts` `openPhoto`, to judge the 404 path.

### Spec Compliance

- ✅ Spec compliant. Every plan step 1 to 8 has its hunk:
  - Worker: `op: 'caption'` and a `sample` flag on describe. `<OD>` stays greedy (`worker.ts` florenceTask, `captionOf`, `SAMPLING`).
  - Backend: `TaggerBackend.caption`, and the fake with a counter.
  - Queue: `regenerate`, which retries once on `BackendLostError`, bumps `stamp`, and runs while paused.
  - Catalogue: `setDescription`.
  - Route: 400, 404, 409, and returns the tags.
  - Web API, store action and toast.
  - Button: label, busy text, a11y label.
  - E2E: click, new text, reload, text still there.
- Deviations that are fine:
  - The store tests are in `gallery-store.test.ts` and the catalogue test is in `gallery-tags-store.test.ts`. The issue names other files, but the implementer's reason (the named files are server-side) holds.
  - `canRegenerate` on `PhotoTags` is not in the issue. It is needed to meet "shown only when the chosen describe model has a description for the photo", because `tagsOf` can show another model's sentence. It is small and tested. Not scope creep.
  - `describe(..., sample)` in the worker has no caller. The issue asks for it explicitly, so it is per spec, but it is dead code today (see Minor).
- ⚠️ Cannot verify from the diff:
  - How the sampled Florence-2 captions read. No model is available, and the real-model test is skipped.
  - The button in the desktop app and in dark theme.
  - Whether `useState` is imported in `WhatsInIt.tsx`. The hunk does not show the imports. The implementer reports that typecheck passes.

### Strengths

- `setDescription` is a targeted `UPDATE ... WHERE status='done'`, so it keeps objects, keywords and the embedding. It also refuses to touch a failed or missing row (`catalog.ts:219-228`). The test covers all three cases, including that the embedding survives.
- The queue loses nothing when it fails. `stamp` is bumped only after a successful write, a backend error leaves the old text, and tests cover each case (`queue.test.ts` "a backend error", "lost on every try").
- Paused works. It loads the model like `embedText` does, and the test shows the loop stays paused and does not tag photo `b`.
- Plain backend errors are kept apart from `NoDescriptionError`, so 409 means "cannot regenerate" and 500 means a real failure. There is a route test for both.
- The store ignores a reply that arrives after another folder was opened, never rejects, and toasts the server's message. All three have tests.
- The e2e test checks the busy state, that the old text stays while busy, that a second click gives different text, that objects are kept, and that the text survives a reload.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

1. **An empty sampled caption overwrites the good description, and the user cannot recover it.** The path is `worker.ts` `captionOf` (it strips `<...>` and trims), then `queue.ts:345-346` (`caption()` then `setDescription` with no check), then `app.ts` `tagsOf`, then `WhatsInIt.tsx` (`description && ...`).
   - **Cause.** Sampling at temperature 0.7 can end the text at once, or leave only special tokens, and either becomes `''`. `setDescription` writes it, because it only checks the row status.
   - **Effect.** The row stays `done`. `tag()` and `seen` never describe it again, so nothing repairs it. `tagsOf` returns `description: ''`. The UI hides the sentence, and also hides the Regenerate button because the button is inside `description && canRegenerate`. The result is permanent loss of the old sentence with no way to ask again from the app.
   - **Why Important, not Critical.** It is rare, the loss is limited to one sentence in a rebuildable catalogue, and nothing crashes. It is not Minor, because this is the issue's own failure case ("On failure the old text stays") and sampling makes the empty result more likely than greedy decoding did. The fix is one line plus one test.
   - **Fix.** In `queue.regenerate`, trim the result. If it is empty, throw a plain `Error` such as "The model wrote an empty description. Try again.", or retry once, before calling `setDescription`. That becomes a 500 and a toast, and the old text stays. Add a queue test with a fake caption that returns `'  '`. Optionally have `catalog.setDescription` refuse an empty string too.

#### Minor (Nice to Have)

1. **Duplicate regenerates are not stopped on the server.** The busy state is a `Set` of paths inside `WhatsInIt` (`WhatsInIt.tsx:1090-1106`). Re-render and double-click are handled. React disables the button before a second click event. But if the section collapses or the panel unmounts while a request is in flight, the state is lost and the button comes back enabled. A second click then queues a second caption. Last write wins, so nothing is corrupted, but it wastes a slow model run. Keeping an in-flight set in the store, or de-duplicating by content key in `queue.regenerate`, would close it. The e2e test does not cover this.
2. **A disabled button drops keyboard focus.** `disabled={busy}` blurs the focused button, so keyboard users lose their place. `aria-disabled` with an ignored click keeps focus. The issue asks for the button to be "keyboard reachable".
3. **Settings change while a regenerate is in flight.**
   - `queue.regenerate` captures `m` once, at the top. The loop's `setSettings`, then `ensureLoaded`, can put a different describe model into the worker before the queued `caption` runs. The text is then written under the old model's id (`queue.ts:339-347`).
   - Within the loop, `loadModel(m)` after a settings change could also reload the old model against the loop. The window is small (`imageOf` plus the worker queue), and it needs a user to switch models mid-click. Re-checking `activeModels()` after the caption, and refusing to write when the chosen model changed, would fix it.
4. **Race with a normal tagging pass is safe by construction.** I checked `tag()` and `next()`. Regenerate needs a `done` row. `tag()` only describes a photo with no `seen` row, and it writes with `INSERT OR REPLACE` after the photo's models have run. A photo being tagged therefore has no done row to regenerate (409), and a done row is never re-described. A `done` photo also gets no overwrite from `tag()`. There is no test for it. Optional: one queue test that starts `regenerate` while `tag` is held by the `gate`, to pin this.
5. **A model load failure during Regenerate marks the describe part broken.** Because it uses the shared `loadModel`, the loop stops and the "Not working" note appears (`broken.add`). That matches `embedText` and the test asserts it, so it is consistent, but one failed click disables tagging for that part until `refresh()`. It comes back as 409 "would not load". That is defensible, though 503 would say "not your request's fault" better.
6. **A lost backend ends as a 500 with the text "The tagging worker stopped."** after two tries. That is acceptable. The model is marked unloaded so the next click reloads.
7. **Small test and code points.**
   - The store tests use `'D:\Trip\lake.jpg'` in ordinary single-quoted strings (`gallery-store.test.ts`, the `#2` block). `\T` and `\l` are not escapes, so the path becomes `D:Triplake.jpg`. It is consistent inside the test, so it passes, but it is accidental. Use `D:/Trip/...` like the other tests.
   - `describe(path, sample)` in the worker has no caller. Per the issue, but dead code until something uses it.
   - The README now says "nothing is written to the photo's folder". That will be stale after the sidecar job.
8. **Test noise and files.** The implementer reports pristine test output. The LF-to-CRLF warning on two test files is cosmetic.

### Notes for the sidecar follow-up (not graded)

- The storage touches are two seams, which is good: `catalog.setDescription` plus the `tagsFor` existence check in `queue.regenerate` (`queue.ts:338-346`), and the read in `app.ts` `tagsOf`. A sidecar change should be able to put both behind one store interface.
- `setDescription` is an atomic single-row `UPDATE`. A sidecar file is read-modify-write, and the loop's `tag()` batches `putTags` while Regenerate writes at the same time. The sidecar writer will need one lock or queue for the album's file, or a lost update becomes possible.
- Rows are keyed by `contentKey` and model id. Copies with the same content share a row today. If the sidecar is per file or per folder, a regenerate on one copy will not update the other, where the catalogue does update both. Only the clicked item is patched in the store now. The `stamp` bump will refetch the rest.
- The issue said nothing touches the album folder, so read-only folders and the fallback are not involved. After the move, Regenerate will have to handle a folder it cannot write to. Today a write failure cannot happen on this path.
- `canRegenerate` is derived from the catalogue row (`d.modelId === s.describe`). It will need the same source after the move.

### Assessment

**Spec compliance:** ✅ Spec compliant.

**Task quality:** Needs fixes. One Important finding (empty caption saved and the description hidden); the rest are Minor.

**Reasoning:** The branch is clean, well tested and keeps to the issue, and the 404 and 409 handling is correct. The one real defect is that the empty-caption case can destroy a good description with no way back in the app; it is a one-line check plus a test.

Counts: Critical 0, Important 1, Minor 8.
