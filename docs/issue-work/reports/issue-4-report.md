# Issue #4 report: check for updates, F1 About, F2 feedback

**Status:** done, in local commits only. Nothing was pushed, no PR was opened, and `gh auth` was not touched.

## Where it is

| | |
|---|---|
| Worktree | `C:\Users\funvill\Documents\git\photobook_helper-updates` |
| Branch | `update-check` |
| Base | the local branch `issues-integration` at `3064692` (the #6 phase 1 merge), which includes #11, #2, #3 and #6 phase 1 |
| Final commit | `3720bf3` (chore: version 0.1.40 on top of issues-integration) |
| PR text | `C:\Users\funvill\AppData\Local\Temp\claude\c9348345901b9bca\ca988cda-866d-4051-8232-ecfcea4fd6b7\scratchpad\issue-4-pr.md` |

## Commits

The commits are listed oldest first. Every one is authored and committed by SWS-Chipkin.

1. **The four existing docs commits** (design, plan, F1 and F2 notes), rebased.
2. **4a**, new files only, except that the first commit adds one allowed address to `photobook-editor/tests/core.test.ts`:
   - `3994b1f` feat: update rules: settings, once-a-day check, texts, hosts
   - `6573e99` feat: update controller: check, offer, download, install
3. **4b**:
   - `685c4d3` build: publish update files to each program's GitHub channel (electron-updater 6.8.12, pinned)
   - `d6b9dbb` feat: shell: Help menu update items, daily check, safe install (with `updateChannel` in both mains)
   - `73ec648` feat: Photo Tool and Photobook Editor check GitHub for updates (resolver rules, descriptions)
4. **4c** (this fixes the Help order):
   - `595fc5f` feat: F1 opens About, with version details and Check for updates
   - `bcf9988` feat: F2 opens GitHub to leave feedback
5. **4d**:
   - `5e5081f` ci: a v* tag drafts one release with both programs' installers
   - `dce7b4e` docs: updates, feedback and the release step
6. `9de7c32` docs: the comments in both `installer.nsh` scripts. They remove the installer copy electron-builder leaves under `%LOCALAPPDATA%\<name>-updater`. That copy is only the base of a differential download, and `RMDir` removes the folder only when it is empty, so an update's pending download stays.
7. `3720bf3` chore: the version bump (0.1.39 from the base, now 0.1.40).

**Versions.** After the rebase, every commit carries the base's version, 0.1.39, and only the final commit bumps it.

**package.json.** In every commit it equals the base's file, plus `electron-updater` from the build commit on. An earlier conflict resolution had briefly brought back the `demo-photos` script that the base had removed; that was undone.

## Tests

- `npm run typecheck` is clean.
- `npx vitest run` on the final branch: 81 files passed (1 skipped), 1231 tests passed, 4 skipped.
- Playwright was not run, because no page or server changed. The work touches only `shared/electron`, the two electron mains and `product.json` files, the builder configs, CI, scripts and docs.

## Task 10: the manual check against a local feed

- **Setup:**
  - Photo Tool 0.1.45, unpacked, run from the scratchpad.
  - A full NSIS build at 0.1.46 (the version was not committed and was restored afterwards), turned into a feed by `collect-assets.mjs`.
  - The feed was served on 127.0.0.1:5650.
  - All folders were temp ones, including `LOCALAPPDATA`. Each instance was stopped by its PID, and none were left running.
- **Results:**
  - The start check found 0.1.46 and wrote `lastCheck`. The controller reached the offer, but the dialog itself was not observed.
  - The check was skipped, with no request, in three cases: `auto:false`, `PHOTO_TOOL_NO_UPDATE_CHECK`, and a last check within 24 h.
  - With the feed offline, the failure was logged and not shown, and `lastCheck` was kept.
  - A self-test with the feed set made no request, had no Check for updates button in About, and passed (`ok`).
- **Run from source:** the app folder, run by `electron.exe` unpackaged with temp folders. The log shows `server ready`, then `update check at start skipped`, with no errors.
- `npm install --package-lock-only` left the lockfile unchanged.
- **Not checked by hand:** Download, Restart and install, F1, F2, and the Help checkbox. These need clicks, and installing was ruled out.
- **Files kept:** the feed and run logs are in `scratchpad\t10\`. The copies of the program and the installer were deleted.

## Decisions

The PR text explains each one under "Decisions I made":

- `allowDowngrade` is turned off again after the channel is set.
- Differential downloads are off.
- Restart now uses `quitAndInstall(true, true)`.
- `quitting` is set before the server stops; otherwise the server's exit is taken for a crash.
- A 30 s backstop ends the app if the installer never starts.
- The .deb fallback applies when no graphical sudo is on `PATH`; it opens `/releases/latest`.
- `updateChannel` comes in with the shell commit, so every commit typechecks.
- `GITHUB_ORIGIN` is written once, plus one allowed exception in the "no remote URL" test.
- `dist:dir` writes no `app-update.yml`, so I checked the full NSIS build instead.

## Concerns

- **Notices:** `lazy-val` 1.0.5, a dependency of electron-updater (MIT), ships no licence file, and its upstream repository has none either. `THIRD-PARTY-NOTICES.txt` marks it as missing. I did not write a licence text.
- **Linux, and the release job itself, have not run.**
  - Whether electron-builder 26 writes both the deb and the AppImage into `<channel>-linux.yml` is checked only when the release job lists the files.
  - The .deb's pkexec path has not been tried.
- **The Help menu** now has a fixed order. #9 and #10 add their items after About's group.
- **Overlap with other branches:**
  - `photobook-editor/README.md` conflicted with #6, which removed the in-browser mode; I kept #6's text and changed only the network sentence.
  - `photobook-editor/tests/core.test.ts` gained one exception for the GitHub address.
  - The integration branch moved twice while I worked; the final rebase is onto `3064692`. If it moves again, rebase, and resolve `package.json`/`package-lock.json` by taking the base's file plus the `electron-updater` line.

## Fix round 1

The review found 4 Important issues and 2 Minors. All are fixed on `update-check`, each test first, with one commit each. The branch is rebased onto local `issues-integration` (now `4089c32`: #5a and #7 phase 1; it had moved past `f6f043d`). It takes 0.1.41 from there; the final commit bumps it to 0.1.42. **Final hash: `0ad73cc`.**

| Finding | Commit | What changed |
| --- | --- | --- |
| M2 | `fix(updates): a release missing this program's update file is a failure` | `isNoRelease` now decides on electron-updater's error code and HTTP status, not on any "404" in the text. A missing `<channel>.yml` (`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`) is now shown and logged as a failure, and `lastCheck` stays put. I traced `GitHubProvider.js` for this. `releases/latest`'s error is thrown inside the feed's `try`, so it arrives rewrapped as `ERR_UPDATER_INVALID_RELEASE_FEED`. It counts as "no release" only when its inner error is `HttpError: 404`, so being offline there no longer reads as "up to date". The tests build their errors with the real `newError`/`HttpError`, nested the way electron-updater nests them. |
| I3 | `fix(updates): send no per-install id to GitHub` | `createUpdates` merges `x-user-staging-id: 00000000-…` into `requestHeaders`, sets `isUserWithinRollout` to always true, and replaces electron-updater's lazy `stagingUserIdPromise`, so `.updaterId` is never created. A test runs this against electron-updater's real `BaseUpdater`: two checks and a download carry only the zeros, and no `.updaterId` file appears. **The header is still sent, with a fixed value.** electron-updater always sets it, and `requestHeaders` can only override it. I did not try dropping it with an `undefined` value. |
| I4 + M1 | `fix(updates): an AppImage updates as an AppImage; setup never blocks start` | `updateRules.updaterKind`: on Linux, whenever `APPIMAGE` is set, the shell constructs `new AppImageUpdater()` and never reads the `autoUpdater` getter, which would pick `DebUpdater` from `package-type`. This has a unit test and a shell source test. A follow-up commit (`fix(updates): an inherited APPIMAGE never makes a .deb update as AppImage`) closes a hole the advisor found. `APPIMAGE` is inherited, so a .deb install launched from another AppImage would have got `AppImageUpdater`, whose install deletes `$APPIMAGE`. Now, when `APPDIR` is set, `process.execPath` must be inside it. **The build config is unchanged, so `desktop.yml` got no new check.** `startUpdates` is now inside `try/catch`: a malformed `UPDATE_FEED` is logged and leaves `updates = null`. About then shows no Check button (`canCheckForUpdates: !!updates && …`). |
| I1 | `fix(updates): Restart now asks about unsaved edits once` | `confirmQuit` is the only question. "Keep editing" calls the install off before anything closes. After "Close without saving", the shell turns on the new `DesktopProgram.allowClose` while it closes the window, and Photo Tool's `will-prevent-unload` lets the page go without asking (`editActions.letPageClose`). It is turned off in a `finally`. An update that is downloaded but not installed (Later, or the install called off) stays ready: the first Help item reads "Install update x.y.z…" and goes straight to Restart now / Later, with no second check or download, and the check at start does not offer it again. |
| I2 | `fix(updates): check before closing anything; recover from a failed install` | **Before closing** (`updateRules.installProblem`): the files `downloadUpdate()` resolved to still exist; an AppImage's folder is writable (electron-updater deletes the old AppImage first); a .deb has a graphical sudo (`graphicalSudo`, in electron-updater's order). With pkexec, the shell runs `pkexec --disable-internal-agent dpkg --version`: 127 (no polkit agent, or refused) offers the release page, and 126 (password box closed) calls the install off quietly. **After closing:** `createUpdates` listens for `error` during the synchronous `quitAndInstall`, catches a throw, and checks whether `quitAndInstallCalled` was reset to false. Any of these calls the shell's `installFailed`, which clears the 30 s backstop, says what failed, offers the release page, then runs `app.relaunch()` (an AppImage from `$APPIMAGE`, not the gone mount) and `app.exit`. A test checks the failure path against the real `BaseUpdater.quitAndInstall`. |
| final | `chore: version 0.1.42 on top of issues-integration` | Version bump. Also puts back #7's wording of the README's `npm test` line, which the rebase had replaced. |

**Tests**
- `npm run typecheck` is clean.
- Fast set (`npm run test:fast`): 983 passed, 3 skipped.
- Slow set (`npm run test:slow`): 299 passed, 1 skipped.
- One earlier full run before the rebase had a timing flake ("computes 3,000 photos in under a second", 1265 ms under load). It passed when run alone.
- Playwright was not run: no page or server code changed. `gallery.ts` and `editActions.ts` are Electron main code.

**Decisions I made in this round**
- **The deb path asks for the password twice:** once for the pkexec probe, once for the install. I know of no way to tell that a polkit agent exists without prompting, since `pkcheck` doesn't report it. The probe is what makes a missing agent, or a dismissed prompt, show up before anything is closed. A cancelled or wrong password at the second prompt is still caught only after closing, and recovery covers that.
- **Only pkexec is probed.** gksudo, kdesudo and beesu are trusted if found. They are legacy, and each takes different arguments.
- **"Ready to install" lasts for this session only.** After a restart, Check for updates checks again, and electron-updater reuses its cached download.
- **The 30 s backstop stays, for a different case.** It now covers only an install that reported success but never quit. A failed install goes through `installFailed`, which cancels it.
- **The "can't install" message offers a choice.** It has "Open the release page" / "Close" buttons instead of always opening the page.
- **I chose the runtime fix for I4 over changing the build.** As a result, the AppImage may still contain `package-type=deb`; the shell just ignores it.
- **I made a local backup branch** before the rebase, `update-check-before-fix1-rebase`, and deleted it afterwards.

**Not run**
- No Linux path has run: the AppImage updater choice, the pkexec probe, the writability check, the relaunch from `$APPIMAGE`, or `installFailed` on a real failure.
- **I2's recovery covers synchronous failures only.** `NsisUpdater.doInstall` returns true as soon as the installer process has a pid, and `app.quit()` is queued. If the spawn then fails, the error arrives later (logged by electron-updater) and is not recovered. Windows installs therefore still rely on the installer starting. Every Linux failure (pkexec and dpkg, the AppImage move) is synchronous and does go through `installFailed`.
- On Windows, Restart now with unsaved edits was not clicked. Desktop clicking and installing are ruled out on this machine. I1 and I2 are covered by unit and source tests only.
