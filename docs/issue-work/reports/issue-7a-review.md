# Review: issue #7 phase 7a (branch faster-loop, commit 3278504)

Spec verdict: PASS. Quality verdict: PASS (approve; 0 Critical, 0 Important, 4 Minor).

Caveat: `gh issue view 7 --repo funvill/photo-tool --comments` returned nothing (active gh account is ssmethurst, no output and no error), so I checked against the constraints in the review brief, not the issue text.

## Constraint checks

- CI runs every test: PASS. `.github/workflows/test.yml:26` runs `npm test`, which is now `npm run test:fast && npm run test:slow` (package.json:14), on windows-latest and ubuntu-latest. `desktop.yml` runs no vitest (it never did), so it neither adds nor removes coverage. Workflows are untouched.
- No file drops out of both sets: PASS. Ran `npx vitest list --filesOnly` for both configs. Fast = 72 files, slow = 10, no overlap, and fast + slow equals `git ls-files '*.test.ts'` exactly (82). A new or renamed file is fast by default (exclude is an allow-list of exact slow paths). A stale slow entry is caught by `tests/test-split.test.ts` (existsSync), which runs in the fast set and so in `npm test`/CI. The stale entry would otherwise be ignored silently by vitest's include, and the file would be in the fast set anyway, so nothing is lost even then.
- `npx vitest run` is the everyday fast loop: PASS. Default `vitest.config.ts` excludes the slow list. 21 s, 900 tests.
- Docs: PASS. README.md "Fast loop vs full loop" has a before/after table, fast-loop and full-loop guidance, and how to add a slow file.

## Findings

### Minor 1: `npm test` is slower than before, and stops at the first failing set
package.json:14. `test:fast && test:slow` runs vitest twice (192 s measured vs 158 s before). CI on two OSes pays this on every run. If the fast set fails, the slow set never runs, so a PR can show only half the failures per push.
Failure scenario: a fast test and a slow test both break; CI reports only the fast one, the author fixes it, and the next push reveals the slow one (another full CI cycle).
Fix: make `test` a single run with no exclude (for example a `vitest.all.config.ts` that only sets include and timeouts, or `vitest run --exclude '' ` equivalent), keeping `test:fast` and `test:slow` for local use. Or accept the cost and use `;`-style sequencing so both always run. Phase 7b may be the place if CI time is the target.

### Minor 2: README totals do not add up
README.md (table row "Every unit test"). Fast 21 s + slow 83 s = 104 s, yet the table says `npm test` took 192 s and "no faster" than 158 s. The report admits one noisy run. The stated explanation (two runs in sequence) cannot account for 192 vs 104.
Failure scenario: a reader trusts "the total is no faster" or the 83 s figure when planning; re-measuring gives different numbers and the doc looks wrong.
Fix: re-measure `npm test` and `test:slow` once on an idle machine, or state the 192 s figure is a loaded-machine run and that fast + slow standalone sum to 104 s.

### Minor 3: The import-boundary guard left the everyday loop
vitest.slow-files.json (`shared/tests/boundaries.test.ts`). It also holds the "neither program imports the other" check, cheap logic bundled with a slow real build test, so the fast loop no longer catches a cross-program import until `npm test`. README says to run `npm test` before a PR, so CI is still protected.
Failure scenario: a developer adds a cross-program import, the fast loop is green, and the failure appears only at PR time.
Fix: split the build test out of `boundaries.test.ts` into its own slow file and leave the static import check fast. Optional.

### Minor 4: Duplicated config and small drift risks
vitest.slow.config.ts:1-14 and vitest.config.ts repeat the JSON read and the timeouts. README says "version 0.1.40" while the branch bumps to 0.1.41 (package.json, package-lock.json); the bump is a routine one if the repo does that per branch, but it is unrelated to the split.
Failure scenario: someone changes `testTimeout` in one config only and the slow set times out differently.
Fix: export shared options from one module (or have the slow config spread the base config). Mention the version in the README as "measured at 0.1.40".

## Notes (no action)

- Test counts: 900 + 300 = 1,200 = 1,198 before + 2 new guard tests.
- `tsconfig.json` includes `vitest.slow.config.ts`, so typecheck covers it.
- Leaving `import-graph` and the big-folder queue test fast is a measured choice and is documented, with the Windows-CI caveat.
