Part of #7

Phase 7a of "Speed up the build and test loop": the measurements, and a split of the slow unit tests. Phase 7b (CI caches, builder compression) is not in this PR; `.github/workflows/*` and the electron-builder configs are untouched.

## What was built

- `npx vitest run` (also `npm run test:fast`) now skips ten slow test files listed in `vitest.slow-files.json`. `npm run test:slow` runs only those, with `vitest.slow.config.ts`. `npm test` runs the fast set and then the slow set, so nothing is dropped. `.github/workflows/test.yml` already runs `npm test`, so CI runs every test without a workflow change. `npm run test:all` is an alias.
- The split is by file, and no test file was moved or edited. A file that is not in the list is fast by default, so the new test files from #9, #6b and the album sidecar land in the everyday loop with no change here.
- `tests/test-split.test.ts` checks that every listed file exists (so a rename cannot silently drop a test from both sets) and that the list has no duplicates.
- README: a "Fast loop vs full loop" section with the numbers below.

## Measurements (one Windows machine, 12 logical cores, wall clock)

| | Before | After |
| --- | --- | --- |
| `npx vitest run` | 158 s, 1,198 tests | 21 s, 900 tests |
| `npm run test:slow` | (inside the 158 s) | 83 s, 300 tests |
| `npm test` (both, one after the other) | 158 s | 192 s in one run |
| `npm run typecheck` | 28 s | 28 s |
| e2e editor | 69 s (3 pass, 1 skipped) | not changed |
| e2e photo-tool | 369 s (47 pass) | not changed |
| `dist:dir:photo-tool` | 66 s | not changed |
| `dist:photo-tool` (installer) | 362 s | not changed |

The editor installer was not timed. The slow set was chosen from the per-file times of the baseline run (JSON reporter): `gallery-server`, `gallery-catalog`, `gallery-edit-server`, `fonts`, `portable`, `milestone`, `cutouts`, `boundaries` (includes "photo-tool builds its own page"), `editor-shell`, and `tagging-worker-ping`.

## Decisions I made

- Slow tests are chosen by measurement, not by the plan's list. `import-graph.test.ts` took 1.6 s and the "big folder" queue test 2.5 s here (the 38 s in the issue is on Windows CI), so both stay fast. `tagging-worker-ping` is slow only on a cold start, but it is named in the plan and is one small file, so it is in the slow set.
- Selection is by file in a JSON list, not by test tag or a vitest `projects` entry. It keeps `npx vitest run` as the plain command, and avoids editing test files other branches are changing (`gallery-tagging-queue.test.ts`, `boundaries.test.ts`).
- The list is JSON read with `readFileSync` because a `.ts` import from `vitest.config.ts` needs `allowImportingTsExtensions`, which tsconfig has off.
- Whole-file moves mean the `boundaries` guard and `gallery-server` run only in `npm run test:slow` / CI, not in the everyday loop. The README says to run `npm test` before a PR.

## Tests

`npm run typecheck` clean. `npm test`: fast 897 passed, 3 skipped; slow 299 passed, 1 skipped (the skips existed before). Playwright, both projects, on ports 5701 and 5702: all pass.

## Not done

- 7b: CI caches (npm, Playwright, electron-builder), NSIS compression for non-release builds, sharding Playwright, and not rebuilding the installer for the version bump.
- The total `npm test` time is not lower (192 s against 158 s in one run each; the machine's load varied). The gain is only in the everyday loop.
- Vitest pool / isolate settings were not evaluated.
- The editor `dist:*` installer was not timed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
