# Issue #11 report: the local server keeps its port

**Status:** done and committed locally. Not pushed and no PR, per the coordinator's change of instructions (no `gh auth`, no `git push` run).

- **Branch:** `fix/stable-server-port` in the worktree `C:\Users\funvill\Documents\git\photobook_helper-port`, rebased on local `main` (4bad967).
- **Final commit:** `050404f5b03480c7c1810b7558e210b673e8c8f2`
- **PR text:** `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\issue-11-pr.md`, which says `Closes #11`. The file is the body only, ready for `--body-file`.
- **PR title:** Keep the local server's port so page settings survive a restart
- **Working tree:** clean.

## Commits (on top of main)

1. `146fde9` fix: the server host can fall back from a busy port
2. `f17e5e3` fix: reuse the local server's last port so page settings survive a restart
3. `0b3d27a` docs: the local server keeps its port
4. `050404f` chore: version 0.1.36 on top of main (takes main's 0.1.35 and bumps once)

`git log` shows SWS-Chipkin <sws-dev@chipkin.com> as both author and committer on all four, and each carries the Co-Authored-By trailer.

## Files

- `shared/electron/serverHost.ts`: `StartMessage.fallbackToAny`, plus `listenWithFallback`. It also takes the error from Express 5's listen callback.
- `shared/electron/config.ts`: `parseSavedPort`, `serverPortRequest`.
- `shared/electron/runDesktopApp.ts`:
  - `rememberPort = !devUrl && !selfTest`;
  - `readSavedPort` and `saveServerPort` (temp file, then rename, with errors logged);
  - `...portRequest` in the start message;
  - the save after `ready`.
- `shared/tests/server-host.test.ts` (new), `shared/tests/desktop-config.test.ts`, `shared/tests/desktop-shell.test.ts`.
- `docs/electron-plan.md`.

## Tests

- **TDD:** each new test failed first, then passed.
- **Typecheck:** clean.
- **vitest:** 1137 passed and 4 skipped across 79 files.
  - The first full run failed only because `fixtures/generated` was missing in the new worktree. `npm run fixtures` fixed it; that folder is git-ignored and nothing was committed.
- **Playwright:** not run. Its webServer runs `tsx <program>/server/main.ts` directly, not `serverHost.ts` or the shell, and no page code changed.

## Manual check (Task 3)

- **Build:** `npm run dist:dir:photo-tool`.
- **Script:** `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\port-check\check.mjs`.
- **Output:** `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\port-check\result.txt`.
- **Setup:** all five folder variables pointed at temp folders, the page was read through CDP with `--remote-debugging-port=9333`, and runs were started one after another.

| Run | Origin | Result |
|---|---|---|
| 1 | `127.0.0.1:50284` | Set `localStorage` to `kept-250`; saved `{"port":50284}`. |
| 2 | `127.0.0.1:50284` | Same origin, and the value read back as `kept-250`. |
| 3 (50284 held by a node listener) | `127.0.0.1:55274` | Fell back to a free port, and the file was updated. |
| 4 (released) | `127.0.0.1:55274` | The new port was reused. |

- Each run was force-ended by its own PID tree, because a plain taskkill was refused for the utility child.
- After the runs, no process from the worktree's build was left running.

## Not done

- The editor build was not checked by hand; the dispatch asked only for Photo Tool.
- Restart was not checked by hand. It is the editor's `restart` message; Photo Tool has none.

## Decisions

- No retry when port 0 itself was asked for.
- The port request is logged to `desktop.log`.

## Concerns

- The issue's Task 3 Step 4 calls Restart "Photo Tool's", but only the editor's server host sends `restart`.
- Local branch only: someone still has to push it and open the PR from the saved text.
- **Other implementers:** a fresh worktree fails 19 unrelated tests (`gallery-catalog`, `gallery-drag`, `gallery-server`, `milestone`, ...) until `npm run fixtures` is run after `npm ci`.
