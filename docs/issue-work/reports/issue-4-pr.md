Check for updates (F1 About), feedback on GitHub (F2): both desktop programs

Closes #4

Photo Tool and Photobook Editor now check GitHub (funvill/photo-tool) for a new release with electron-updater, offer it, download it and restart into it. F1 opens About with version details and a Check for updates button. F2 opens the repository's new-issue page with the program, version and platform filled in. On a `v*` tag, CI puts every installer and update file of both programs into one draft release.

## What was built

The work is in four groups of commits, in this order:

- **4a: the pure part (new files, plus one allowed address in `photobook-editor/tests/core.test.ts`).**
  - `shared/electron/updateRules.ts` holds the settings file (`<profileDir>/updates.json`; read as defaults when missing or hand-edited, written to a temp file and renamed), the once-a-day rule for the check at start, owner and repo from `product.json`, the release pages, "no release yet" errors (decided on electron-updater's error code and status: no feed entries, a 404 on the feed or on `releases/latest`; a missing `<channel>.yml` is a failure), the pre-install checks (`installProblem`, `graphicalSudo`, `pkexecProbe`, `relaunchOptions`), the AppImage rule (`updaterKind`), the dialog texts, and the four GitHub hosts.
  - `shared/electron/updates.ts` (`createUpdates`) drives an injected updater. It covers the quiet start check (logged, never shown, `lastCheck` kept on failure), Help › Check for updates (always answers; a 404 means "newest version"), Download / Release notes / Later, download progress on the taskbar and in the menu item, and Restart now through the shell's `prepareInstall`. A downloaded update that was not installed stays ready ("Install update x.y.z…" in Help). A failed install calls the shell's `installFailed`. No per-install id is sent (see below). Only one check, one offer and one download run at a time.
- **4b: the dependency, publish config, shell hooks and both mains.**
  - `electron-updater` 6.8.12 is a pinned runtime dependency (MIT).
  - Each builder config publishes to GitHub on its own channel (`photo-tool`, `photobook-editor`) as a draft. Owner and repo are read from `product.json`.
  - `runDesktopApp.ts` adds:
    - the Help items;
    - the check at start, 5 s after the page loads;
    - `<PREFIX>_UPDATE_FEED` (generic provider, testing only) and `<PREFIX>_NO_UPDATE_CHECK`;
    - `prepareInstall`: first, before anything is closed, it checks what can fail: the downloaded files, an AppImage's folder being writable, and for a .deb a graphical sudo, with pkexec actually run once. If the install can't work it offers the release page instead. Then Photo Tool's unsaved-edits question, asked once (`DesktopProgram.allowClose` stops the window asking again). Then it closes the window every second for up to 10 s while the server still runs, then stops the server;
    - `installFailed`: an install that fails after that says so, offers the release page and starts the old version again;
    - an `installing` guard on `window-all-closed`.
  - On Linux an AppImage (`APPIMAGE` set) gets `AppImageUpdater` directly, whatever `resources/package-type` says.
  - No updater is made in a self-test, and a failure while setting one up (a bad `UPDATE_FEED`) only turns updates off.
  - `DesktopProgram.updateChannel` is set in both mains.
  - Both programs' host-resolver-rules let the four GitHub hosts through via `netGuard.hostResolverRules(UPDATE_HOSTS)`; Photo Tool keeps its tile host first.
  - Both `product.json` descriptions say the programs check GitHub.
- **4c: F1 and F2.**
  - About has the F1 accelerator, a `Version <v> (Electron <x>, <platform> <arch>)` line, and a Check for updates button (installed program only, not in a self-test) that runs the same check.
  - `feedbackUrl` in `config.ts` builds the F2 address with `URLSearchParams`. Nothing about the user goes in.
  - The Help order is now fixed: update items, separator, Send feedback on GitHub… (F2), separator, About (F1). Later Help items (#9, #10) go after these.
- **4d: CI and docs.**
  - `scripts/release/collect-assets.mjs` matches each installer to its update file by sha512 and copies it under the update file's (dash) name. It skips `builder-debug.yml` and has no dependencies.
  - The build jobs keep `<program>.yml` / `<program>-linux.yml` in their artifacts.
  - A new `release` job runs only on `v*` tags in funvill/photo-tool, after the windows and linux jobs. It checks the tag against `package.json`, makes or reuses one draft release (it never changes a published one) and uploads with `GH_TOKEN`.
  - The comments in both `installer.nsh` scripts now say why the installer copy under `%LOCALAPPDATA%\<name>-updater` is removed: the updater never does a differential download, and `RMDir` leaves a non-empty pending folder alone.
  - The README has a new section, "Updates, feedback and releasing". `docs/electron-plan.md` and both program READMEs no longer say the programs never use the network.

## Decisions I made

- **Downgrades stay off.** electron-updater turns `allowDowngrade` on whenever a channel is set, so `createUpdates` turns it off again afterwards. Without that, an older release would be offered as an update.
- **Whole downloads only.** `disableDifferentialDownload = true`, because no block maps are published.
- **Silent install.** Restart now calls `quitAndInstall(true, true)`: a silent install, then the new version starts.
- **`quitting` is set before the server stops.** The plan says to stop the server and then set `quitting`. If it were set after, the server's `exit` handler would report a crash ("stopped unexpectedly") in the middle of the install.
- **Backstop.** `prepareInstall` sets a 30 s timer that ends the app if an install that reported success never quits. A failed install goes through `installFailed`, which cancels the timer, then relaunches.
- **The .deb asks for the password twice.** Before closing anything, the shell runs `pkexec --disable-internal-agent dpkg --version`. Exit 127 (no polkit agent, or refused) offers the release page; 126 (prompt closed) calls the install off. I know of no way to detect a polkit agent without prompting, so the install's own prompt comes second. A cancel or wrong password there is caught by `installFailed`. Only pkexec is probed; gksudo, kdesudo and beesu are legacy, and are trusted if found. With none of them on `PATH` (electron-updater would fall back to plain `sudo`, which needs a terminal), the release page (`/releases/latest`) is offered.
- **No per-install id.** electron-updater sends a random per-install id (`x-user-staging-id`, from `<userData>/.updaterId`) with every check. Releases here are never staged, so every user is in every rollout, the id is never made, and the header carries zeros for everyone. electron-updater always sets the header and `requestHeaders` can only override it; dropping it with an `undefined` value was not tried.
- **AppImage at runtime, not in the build.** Both Linux packages build from one folder, so the AppImage may carry `package-type=deb`. Rather than change the build, the shell picks `AppImageUpdater` when `APPIMAGE` is set and the program runs from inside `APPDIR`. Both variables are inherited, and `AppImageUpdater` deletes `$APPIMAGE`, so a .deb started from another AppImage must not get it. CI is unchanged.
- **"Ready to install" lasts for this session only.** After a restart, Check for updates checks again, and electron-updater reuses its cached download.
- **`updateChannel` arrives with the shell commit** in both mains, so every commit typechecks. The plan put it in Task 5.
- **The GitHub address is written once**, as `GITHUB_ORIGIN` in `updateRules.ts`. `config.feedbackUrl` imports it. `photobook-editor/tests/core.test.ts` (the "no remote URL" guard) allows exactly `https://github.com` in that one file.
- **Updates are created before the menu.** The updates object is built before the first `buildMenu`, so the Help items are there from the start. Only the check at start waits until after `loadURL`.
- **Correction to the plan's "done when".** electron-builder writes `resources/app-update.yml` only for an installer target, not for `dist:dir`. I checked the full `dist:photo-tool` build instead.
- **Updater log.** electron-updater's own log lines go to `desktop.log` with an `[updater]` prefix.

## Tests

- New test files:
  - `shared/tests/update-rules.test.ts` covers settings (missing, corrupt, wrong types, round trip), the start rule, repo and release pages, `isNoRelease`, every text, and the host list and resolver string.
  - `shared/tests/updates.test.ts` uses a fake updater, and electron-updater's real `BaseUpdater` for the request headers (no per-install id, no `.updaterId`) and for a failed `quitAndInstall`. It covers configuration (including downgrade staying off), the update staying ready after Later or a called-off install, the downloaded files passed to `prepareInstall`, `installFailed`, a missing `<channel>.yml`, the whole Download → Restart now → `prepareInstall` → `quitAndInstall` order, `prepareInstall` false, Later, up to date, 404, other errors, not packaged, Release notes, a failed download then Try again, the start check (skipped / newer / up to date / 404 / offline keeps `lastCheck` / corrupt settings), the checkbox, the downloading label, and one check, offer and download in flight.
  - `tests/release-assets.test.ts` covers the dash names, Linux deb+AppImage, an unmatched hash, `builder-debug.yml`, quoted values, a path in a url, and no update file.
- Changed tests:
  - `shared/tests/desktop-shell.test.ts` checks the shell source: the updater imports and their self-test guard, the AppImage choice, the `try/catch` around setup, the start check, the feed override, `window-all-closed` / `before-quit`, the `prepareInstall` order (checks before `confirmQuit`, asked once, `allowClose` cleared in `finally`), `installFailed` (backstop cleared, release page, relaunch), F1, F2 and the Help order.
  - `shared/tests/desktop-config.test.ts` checks the About buttons, the version line, the network sentences and `feedbackUrl`.
  - `photo-tool/tests/photo-tool-shell.test.ts` and `photobook-editor/tests/editor-shell.test.ts` check the publish config, channel and description, the pinned runtime dependency and the resolver rules.
  - `photo-tool/tests/gallery-map.test.ts` checks Photo Tool's resolver rules. `photo-tool/tests/gallery-edit-actions.test.ts` checks `letPageClose`, and `photo-tool-shell.test.ts` checks how `allowClose` is wired.
- Results on the final branch, rebased onto issues-integration (which now includes #5a and #7 phase 1): `npm run typecheck` is clean; `npm run test:fast` passes 983 with 3 skipped; `npm run test:slow` passes 299 with 1 skipped.
- Playwright was not run, because no page or server changed.
- `npm install --package-lock-only` left the lockfile unchanged.

## Checked by hand (Task 10, Windows, local feed only, nothing installed)

Setup:
- I built Photo Tool 0.1.45 as `dist:dir` (unpacked, so `app.isPackaged` is true) and copied it to a scratch folder. I added the `app-update.yml` that electron-builder wrote for the NSIS build.
- I bumped the version to 0.1.46 without committing, ran a full `dist:photo-tool`, and restored the version. `collect-assets.mjs` turned the output into a feed folder: `photo-tool.yml` and `Photo-Tool-Setup-0.1.46.exe`.
- A 20-line Node server served the feed on 127.0.0.1:5650 and logged every request.
- Every run used temp `PHOTO_TOOL_DATA_DIR`, `PHOTO_TOOL_PROFILE_DIR`, `PHOTOINFO_FALLBACK_DIR` and `LOCALAPPDATA` (where electron-updater keeps its download cache), with `PHOTO_TOOL_UPDATE_FEED` pointing at the feed. Each instance was stopped by its PID.

Results:
- **Start check, fresh settings:** the log shows `Found version 0.1.46 (url: Photo-Tool-Setup-0.1.46.exe)` and `update check at start {"kind":"available","version":"0.1.46"}`. The feed got one `GET /photo-tool.yml`. `updates.json` was written as `{"auto": true, "lastCheck": <now>}`. The controller reached the offer; the dialog itself was not observed.
- **`{"auto":false}` in `updates.json`:** the log says "update check at start skipped", and the feed got no request.
- **`PHOTO_TOOL_NO_UPDATE_CHECK=1`:** skipped, no request.
- **`lastCheck` one hour ago:** skipped, no request.
- **Feed unreachable (offline), `lastCheck` two days ago:** the log says `update check at start failed net::ERR_CONNECTION_REFUSED`. Nothing was shown, and `lastCheck` is unchanged, so the check runs again at the next start.
- **`--self-test` with the feed set:** exit code 0, `ok: true`, `requestsToOtherHosts` empty, and no update line in the log. `startUpdates` returned before touching `autoUpdater`. The feed got no request, and About's buttons were `OK | Third-party notices` (no Check for updates).
- **Run from source:** the unpacked app folder, run by `electron.exe`. The log shows `server ready`, then `update check at start skipped`, with no errors.
- **The real NSIS build** has `resources/app-update.yml` with `provider: github, owner: funvill, repo: photo-tool, channel: photo-tool`, and `photo-tool.yml` beside the installer, with the url `Photo-Tool-Setup-<v>.exe`.

## Not done / not checked

- **Not checked by hand:** clicking Download (progress bar, menu label), Restart now (install and restart, and the single unsaved-edits question), F1 and the About button, F2 opening the browser, and the Help checkbox. These need clicks in the window, and no one drove the desktop. Installing was ruled out for this machine, and Task 10's "Repeat against real GitHub" step was not run.
- **Linux:** nothing has run there. That covers the .deb/AppImage update files and installs, the AppImage updater choice, the pkexec probe, the folder check, and relaunch after a failed install. CI will build the files; whether `photo-tool-linux.yml` lists both the deb and the AppImage is checked only by the release job's file list.
- **A Windows installer that fails to start** is not recovered. electron-updater's `NsisUpdater` reports success once the process has a pid and queues the quit; a later spawn error is only logged. `installFailed` covers synchronous failures, which includes every Linux path.
- **The release job** has not run; it needs a `v*` tag on GitHub.
- **Notices:** `lazy-val` 1.0.5 (an electron-updater dependency, MIT) ships no licence text, and its repository has none either. `THIRD-PARTY-NOTICES.txt` lists it as MIT with the "missing, needs adding by hand" marker, like the existing onnxruntime entries. I did not write a licence text myself.
- **Ordinary Quit:** the gap the design names (`before-quit` calls `app.exit` and skips the editor's last `beforeunload` save) is unchanged. It is a follow-up.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
