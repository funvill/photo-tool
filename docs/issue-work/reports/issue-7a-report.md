# Issue #7, phase 7a report

Branch `faster-loop` (worktree photobook_helper-loop), commit 3278504 on top of issues-integration f6f043d (no rebase needed; version 0.1.41). Not pushed.

## Changes
- vitest.config.ts: excludes the files in vitest.slow-files.json (the everyday loop).
- vitest.slow.config.ts: includes only those files.
- vitest.slow-files.json: 10 files (gallery-server, gallery-catalog, gallery-edit-server, fonts, portable, milestone, cutouts, editor-shell, boundaries, tagging-worker-ping).
- package.json: test = test:fast && test:slow; test:all; test:fast; test:slow. CI's `npm test` in test.yml therefore covers both; workflows untouched.
- tests/test-split.test.ts: guard that listed files exist.
- tsconfig.json: vitest.slow.config.ts added to include.
- README: "Fast loop vs full loop".

## Measurements
Raw JSON: scratchpad/vitest-before.json, vitest-fast.json, vitest-slow.json (analyser an.cjs).
- vitest before: 158 s, 1198 tests. Fast: 21 s, 900 tests. Slow: 83 s, 300 tests. `npm test` both: 192 s (one run; machine load varies).
- typecheck 28 s. e2e editor 69 s (3 pass, 1 skipped); e2e photo-tool 369 s (47 pass), each project builds both servers.
- dist:dir:photo-tool 66 s. dist:photo-tool installer 362 s (under 10 min, so timed). Editor installer not timed.
- Per-file timings under parallel load: gallery-server 148 s, gallery-catalog 81 s, fonts 37 s, portable 26 s, milestone 26 s, boundaries 25 s, gallery-edit-server 22 s, cutouts 16 s, editor-shell 13 s, tagging-queue 10.6 s (file; big-folder test 2.5 s), worker ping 2.5 s, import-graph 1.6 s. File times are inflated by contention.

## Decisions
- Measured, not plan-named: import-graph and the big-folder queue test stay fast (here; slow on Windows CI, re-measure there).
- File-level JSON list rather than tags/projects, so no test file is edited or moved.

## Concerns
- npm test total is not lower than before; only the everyday loop is.
- Fast loop no longer runs boundaries (import-boundary guard) or gallery-server; README says to run npm test before a PR.
- Playwright run created test-results/ (gitignored). dist build output in dist/ (gitignored).
