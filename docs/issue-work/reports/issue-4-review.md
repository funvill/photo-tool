# Review: issue #4 (check for updates, F1 About, F2 feedback), branch `update-check`

Reviewed: the issue (the requirement), plan section 1 #4 and the section 5 brief, the implementer's report, and `review-issue-4.diff` (base `issues-integration` at `3064692`, head `3720bf3`). Surrounding code was read in `C:\Users\funvill\Documents\git\photobook_helper-updates`, along with electron-updater 6.8.12 and app-builder-lib 26.18.0 in its `node_modules`. The only thing run was `makeNotices()`, through tsx, to see the notices text. No test suite and no app were run.

Line numbers are for the worktree at `3720bf3`.

## Spec verdict: ✅ (4a–4d all delivered), with one gap in Task 10's proof

| Phase | Verdict | Notes |
|---|---|---|
| **4a** (Tasks 2–3: `updateRules.ts`, `updates.ts`) | ✅ | Every interface, text and button set matches the issue. Each Review Focus item has a test: 404 means up to date; the start check fails silently and keeps `lastCheck`; a corrupt `updates.json` reads as the defaults; one check, offer and download in flight at a time. Additions beyond the plan: `allowDowngrade = false` set after the channel (with a test), and `disableDifferentialDownload = true`. |
| **4b** (Tasks 1, 4, 5: dependency, `publish`, shell hooks, both mains) | ✅ | `electron-updater` is pinned at 6.8.12. `publish` reads owner and repo from product.json. The flags are in place: `installing`, `quitting` in `before-quit`, and `window-all-closed`. `prepareInstall` closes the window for up to 10 s, then stops the server. The start check runs 5 s after `loadURL`, never in a self-test. `UPDATE_FEED` is used only when set. Each program has its `updateChannel`, the resolver rules come through `netGuard.hostResolverRules`, and the descriptions match the issue word for word. Task 4 Step 4 holds: electron-updater uses its own partition (`electronHttpExecutor.js:8`, `session.fromPartition`), so `requestAllowed` is unchanged. A justified change from the plan: `quitting` is set before `stopServer()` (`runDesktopApp.ts:583-584`), so the server's exit is not taken for a crash. The "app-update.yml in dist:dir" check was replaced by a full NSIS build, because `--dir` writes no update config. |
| **4c** (Tasks 6–7: F1 About, F2 feedback) | ✅ | F1 is the About accelerator (`runDesktopApp.ts:516`). About shows `Version x (Electron …, platform arch)`. Its Check for updates button appears only when packaged and not in a self-test. `feedbackUrl` sends only the title and body. The Help order is update items, then feedback, then About. |
| **4d** (Tasks 8–9: CI draft release, docs; Task 10 recorded) | ✅ code and docs / ⚠️ Task 10 partial | `collect-assets.mjs` and its tests are present. The release job has the repo guard, the tag-equals-version check and one job for the upload; it also refuses to touch a release that is already published. README and `docs/electron-plan.md` cover what is contacted, when, how to turn it off, both env vars, SmartScreen and the deb password. **Gap:** Task 10 Step 4 asks for Download, taskbar progress, Restart now, the install, the relaunch, F1, F2 and the checkbox to be shown working in the built program. The report says only the check and the skip cases were run (`issue-4-report.md:60`). The riskiest path, quit and install, has never run end to end. See ⚠️ below. |

## Quality verdict: good, with 4 Important findings to fix before merge (0 Critical, 4 Important, 8 Minor)

The controller and rules are clean, small and well tested. The shell hooks are minimal, and the network, self-test and privacy guards around the check itself are right. The problems are in the edges of the install sequence and in electron-updater defaults that the code does not override.

### Critical

None.

### Important

**I1. Photo Tool asks "Close without saving?" twice on Restart now. Answering "Keep editing" the second time re-asks, then shows the wrong message.**
`shared/electron/runDesktopApp.ts:569-580` and `photo-tool/electron/gallery.ts:529-533, 544-547`.
- *Scenario:* Photo Tool has 2 unsaved edits, and the user clicks Restart now.
  1. `confirmQuit()` shows the unsaved-edits box (`showMessageBoxSync`), and the user picks Close without saving.
  2. `win.close()` runs the page's `guardUnload`, which still sees 2 unsaved edits and calls `preventDefault`. That reaches `will-prevent-unload`, and **the same question is asked again**.
  3. If the user picks Keep editing, the close is cancelled. A second later the loop calls `win.close()` again and asks a third time, and so on until 10 s have passed (the sync dialog blocks the loop, so each answer takes up time).
  4. The user is then told "Your latest changes are still being saved", which is wrong: they chose to keep editing.
- An ordinary Quit does not have this problem, because `before-quit` asks once and then calls `app.exit`, which skips `beforeunload`.
- *Fix:* when `confirmQuit` returned true, tell the program that the close is already confirmed. For example, add a `DesktopProgram.allowClose?()` hook, or a flag that `gallery.ts`'s `will-prevent-unload` checks to `preventDefault` without asking, set just before the loop and cleared after it. Alternatively, skip `confirmQuit` and let `will-prevent-unload` ask once, then treat a cancelled close that followed a "Keep editing" answer as "called off", not "still saving". Add a shell source test for the chosen route.

**I2. An install that fails after the window and server are gone leaves an invisible process, which exits 30 s later without a word. The deb fallback almost never fires.**
`shared/electron/runDesktopApp.ts:550-560` (`cannotInstallDeb`), `:581-590` (teardown and the 30 s backstop), `shared/electron/updates.ts:145`.
- Checked in electron-updater:
  - `BaseUpdater.quitAndInstall` calls `app.quit()` only when `install()` returns true; on false it just resets `quitAndInstallCalled` (`BaseUpdater.js:13-26`).
  - `DebUpdater.doInstall` runs `pkexec --disable-internal-agent /bin/bash -c 'dpkg -i …'` synchronously. Any failure goes to `dispatchError`, which only logs, and the function returns false (`DebUpdater.js:27-46`, `LinuxUpdater.js:34-64`).
- *Scenario A (deb):* Ubuntu with pkexec on `PATH`, so `cannotInstallDeb()` returns false. Any of these makes pkexec fail: the user cancels the password prompt, the password is wrong, or the desktop has no polkit agent (common on minimal or tiling window managers, and the internal text agent is turned off).
  1. By then the window is closed, the server is stopped, `quitting` and `installing` are true, and nothing is installed.
  2. The app stays alive with no window for 30 s, then `app.exit(0)`.
  3. Launching it again in those 30 s does nothing: `second-instance` returns at `if (!win) return` (`runDesktopApp.ts:~768`).
  4. The user sees the app vanish and does not get the update. The next day they are offered the same version again, with the same result.
  This is the "a failure after quit cannot be shown" case that the plan meant the fallback to prevent. Checking that pkexec exists on `PATH` does not detect it.
- *Scenario B (AppImage):* the AppImage file is not writable (for example it is in `/opt` or on a read-only mount). `AppImageUpdater` fails in the same place, with the same silent exit.
- *Fix:*
  - After `quitAndInstall`, detect failure: `install()` returned false, `quitAndInstallCalled` was reset, or the updater emitted `error` while installing. Then `app.relaunch(); app.exit(0)`, so the user is back in the old version, and on the next start show `updateText.downloadFailed` / "could not install; opening the release page" (`latestReleasePage`).
  - For AppImage, also check before teardown: `accessSync(env.APPIMAGE, W_OK)` and that its folder is writable. If not, use the same release-page fallback.
  - Optionally run the deb check before the download rather than at Restart now, so the user doesn't download a whole package that can't be installed.

**I3. Every check sends a persistent per-install identifier (`x-user-staging-id`) to GitHub.**
`shared/electron/updates.ts:79-86` (no override); electron-updater `AppUpdater.js:384-388, 502-527`, `providers/Provider.js:61-67`.
- `getUpdateInfoAndProvider()` always reads or creates a random UUID in `<userData>/.updaterId` and sets it as a request header on the provider. `Provider.createRequestOptions` merges `requestHeaders` into every GitHub request: the atom feed, `releases/latest`, the channel yml and the download.
- *Scenario:* a user's install sends the same UUID to github.com on every daily check for the life of the install, across IP addresses and networks. GitHub, or anything logging those requests, can link them. This goes against the binding "no private data sent" and the issue's "nothing else about the user goes in". The project's own map-tile code strips headers to the bare minimum for the same reason (`mapTiles.ts:mapTileRequestHeaders`). The id is also logged once ("Generated new staging user ID: …").
- *Fix:* in `createUpdates`, set `updater.requestHeaders = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' }`. `computeFinalHeaders` assigns `requestHeaders` last, so this overrides the random id. Releases use no staged rollout, so nothing is lost. Add `requestHeaders` to `UpdaterLike` and assert it in `updates.test.ts`. Optionally override `isUserWithinRollout` too, which makes the lazy UUID unnecessary for rollout decisions (the file is still created by the header path unless overridden as above).

**I4. The AppImage probably ships `resources/package-type` = `deb`, so AppImage users would update through `DebUpdater` (likely; confirm on a built artifact).**
`photo-tool/electron-builder.config.cjs` and `photobook-editor/electron-builder.config.cjs` (Linux targets `[deb, AppImage]` with `publish` now set); app-builder-lib `targets/FpmTarget.js:131-141`, `platformPackager.js:110-131`; electron-updater `main.js:51-60`.
- When `publish` is set, `FpmTarget` writes `package-type` into the shared `linux-unpacked/resources` folder. Both targets are async and are built at the same time from that same `appOutDir`. The deb writes the file before running fpm, and `AppImageTarget` squashes `appOutDir` after its own async setup, so the AppImage very likely contains the file.
- electron-updater's Linux choice has no `APPIMAGE` guard: if `package-type` says `deb`, it uses `DebUpdater`.
- *Scenario:*
  - An Ubuntu user running the AppImage clicks Download and Restart now. electron-updater downloads the **.deb** and runs `pkexec dpkg -i`, installing a second, system-wide copy. The AppImage they launch is never replaced, so they are offered the same update every day.
  - On a non-Debian distro there is no dpkg, so the install fails after teardown, as in I2.
  - `cannotInstallDeb()` does not catch either case, because it returns false whenever `APPIMAGE` is set.
- *Fix:*
  - In the Linux CI job, add `./x.AppImage --appimage-extract 'resources/package-type'` (or `unsquashfs -l`) and fail if the file is present in the AppImage. Also check that `<channel>-linux.yml` lists both a `.deb` and an `.AppImage` url.
  - If the file is there, remove it from the AppImage's input, for example by building the AppImage in its own `electron-builder` run (`--linux AppImage`, then `--linux deb`), or with an `artifactBuildStarted` hook. Alternatively, in the shell, when `env.APPIMAGE` is set, construct `new AppImageUpdater()` from `electron-updater` instead of using the auto-selected `autoUpdater`.

### Minor

**M1. `startUpdates()` is not guarded and runs before the server and window. A malformed `<PREFIX>_UPDATE_FEED` hangs start-up.** `runDesktopApp.ts:595-606, 730`.
- `setFeedURL` with the generic provider runs `new URL(url)`. `PHOTO_TOOL_UPDATE_FEED=127.0.0.1:5650/` (no scheme) throws, `main()` rejects (only logged as `unhandledRejection`), and no server or window starts.
- The process keeps the single-instance lock, so later launches do nothing either. This breaks "a failure must never block start-up", though only through a testing variable.
- *Fix:* wrap the body of `startUpdates` in `try/catch`, log, and leave `updates = null`. Also validate the feed with `new URL` and allow only `http(s)://127.0.0.1` or `localhost` (see M8).

**M2. `isNoRelease` matches any `404` token, so real failures can read as "you have the newest version" and advance `lastCheck`.** `updateRules.ts:86-89`.
- *Scenario:* a published release that is missing this program's `photo-tool.yml` gives "Cannot find photo-tool.yml in the latest release artifacts … 404". The check says up to date every day, and nobody notices that the release is broken. Version strings like `v0.1.404` in a URL, or a `"content-length": "404"` in an HttpError's header dump, also match.
- *Fix:* decide on `e.code` (`ERR_UPDATER_NO_PUBLISHED_VERSIONS`, `ERR_UPDATER_LATEST_VERSION_NOT_FOUND`) and on `statusCode === 404` for the feed. Treat `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` as a failure, or at least log it as a warning.

**M3. `checkForUpdates()` returning `null` (updater inactive) is reported as "You have the newest version".** `updates.ts:116`.
- electron-updater returns null when it is not active: a Linux build without `package-type` and without `APPIMAGE`, a snap, and so on. The manual check then tells the user something untrue.
- *Fix:* map `null` to a distinct outcome ("This copy cannot update itself; get the new version from the release page"), and do not advance `lastCheck` for it.

**M4. The updater's info log writes absolute user paths into `desktop.log`.** `runDesktopApp.ts:597`.
- electron-updater logs `Executing: <cmd> with args: <installer path under ~/.cache or %LOCALAPPDATA%>`, error stacks, and the staging id (I3). `desktop.log` already records `dataDir` at start (`:719`), so this is not a new class of data.
- *Fix:* route `info` to `debug`, or redact paths and UUIDs in the logger adapter.

**M5. A start check that fails is not counted, so non-network failures retry on every start, more often than once a day.** `updates.ts:117-125`.
- This follows the plan ("retries next start"), which is right when offline. A 403, 429 or 5xx from GitHub, though, means a request goes out at every launch.
- *Fix (optional):* count `HttpError`s with a status code as "the day's check", and keep retrying only on `net::ERR_*`.

**M6. Both programs' shipped notices now carry `[MISSING, NEEDS ADDING BY HAND: … lazy-val@1.0.5 …]`.** This comes from `scripts/make-notices.ts` and needs `scripts/notices/lazy-val.txt`.
- Every package the lockfile gained has an entry in the generated text: `electron-updater`, `builder-util-runtime`, `semver`, `lodash.escaperegexp`, `lodash.isequal`, `tiny-typed-emitter`, and also `lazy-val`, `js-yaml`, `fs-extra` and `sax`.
- Only `lazy-val` has no licence text. It joins eight entries already missing on the base (sharp-libvips, pdfium, brotli, dfa, fontkit, onnxruntime-common, onnxruntime-node, splaytree), so this follows existing policy and is not a regression in kind. The report flags it.
- *Fix (owner's call):* add the MIT text with the copyright of lazy-val's author, as its package.json declares, or leave it on the existing list of texts to add.

**M7. A pre-release tag would be drafted, and once published offered, as a normal release.** `.github/workflows/desktop.yml:491`.
- `v0.2.0-beta.1` passes the tag check. `gh release create` without `--prerelease` makes it "latest" on publish, and its semver is greater than `0.1.x`, so every user is offered it.
- *Fix:* add `--prerelease` when `$TAG` contains `-`, or refuse such tags in "The tag names this version".

**M8. `UPDATE_FEED` is honoured in shipped builds and accepts plain http and IP-literal hosts.** `runDesktopApp.ts:599-601`.
- IP literals bypass the host-resolver rules. Whoever can set the env var can already run code as the user, so this is defence in depth only.
- *Fix:* accept only `http(s)://127.0.0.1` or `localhost`, and otherwise log and ignore it.

**M9. Small UI items.**
- The Help menu has two `&A` mnemonics: "Check for updates &automatically" (`updates.ts:235`) and "&About" (`runDesktopApp.ts:516`).
- About's Check for updates button silently does nothing while an offer or download is in flight (`updates.ts:194`).
- The upload of the update yml (`desktop.yml`, `if-no-files-found: error`) does not fail when only the yml is missing, so that shows up only on a tag.

## Trust of the update feed (for the record, not graded)

- **GitHub provider, https only.**
  - The atom feed `github.com/<o>/<r>/releases.atom` and `releases/latest` both exclude drafts, so a draft is never offered.
  - The channel yml and installer come from `releases/download/v<ver>/…` and redirect to `objects.` or `release-assets.githubusercontent.com`.
  - Every other name maps to NOTFOUND through the resolver rules, and a redirect to a non-http(s) scheme is refused (`electronHttpExecutor.js:83`).
- **Integrity comes only from the sha512 in the yml of the same release.** `app-update.yml` has no `publisherName`, so `NsisUpdater.verifySignature` is skipped. The issue accepts this ("Not doing: code signing").
  - In practice, anyone who can publish a release on funvill/photo-tool can push code to every user.
  - The human Publish step on the draft is the only gate. The release job never changes a published release, and its `contents: write` token is limited to that job.
- **Downgrades and channels are handled.**
  - `allowDowngrade` is reset after `channel` is set (electron-updater turns it on at `AppUpdater.js:34-45`), with a test.
  - Each program reads only `<channel>.yml` / `<channel>-linux.yml`, so neither can install the other.
  - `allowPrerelease` stays false. M7 covers the pre-release tags.

## Quit and install sequence (as traced)

1. Restart now runs `prepareInstall`. It gives the deb fallback first, then `confirmQuit`, then sets `installing = true`, then calls `win.close()` once a second for up to 10 s (`window-all-closed` is ignored while `installing`). Then it sets `quitting = true`, so the server's exit is not fatal, and calls `stopServer()`.
2. `quitAndInstall(true, true)` follows. On Windows it spawns the NSIS installer detached with `--updated /S --force-run`, then `setImmediate(app.quit)`. `before-quit` returns early because `quitting` is set, so there is no second question and no `app.exit` before the quit.
3. On Windows and on a successful deb or AppImage install this is correct, and nothing in it looks like a server crash.
4. The holes are I1 (Photo Tool's double question) and I2 and I4 (Linux failure paths).
5. The 30 s backstop is harmless on the happy path. On the deb path, `spawnSync` blocks the timer, and `app.relaunch()` is already set when it fires.

## ⚠️ Cannot verify from the diff

- **The install path has never run.** Download, Restart now, the NSIS silent install, the relaunch, F1, F2 and the checkbox were not exercised (Task 10 Step 4 is incomplete). Whether `%APPDATA%\<Program>\data` survives an update is unobserved. It should, going by the config: `deleteAppDataOnUninstall: false`, the data lives outside the install folder, and the NSIS `--updated` uninstall keeps app data.
- **Only the generic provider was used** (the local feed). The GitHub provider's path (atom feed, `releases/latest`, redirect hosts) has not run against a real release. Before the first release, expect a 404, read as up to date.
- **Nothing on Linux has run, and neither has the release job.** Untried so far: the deb pkexec path, AppImage self-replacement, whether `<channel>-linux.yml` lists both packages (source says yes, through `FpmTarget` `isWriteUpdateInfo`), and the AppImage `package-type` question (I4).
- **The editor's pending-save close loop** relies on Electron cancelling the close silently when `beforeunload` is prevented and there is no `will-prevent-unload` handler. That is standard behaviour, but it is not exercised by any test here.

---

## Re-review 1 (fix round 1, `1bbb58c..5d9424d`; branch at `0ad73cc`)

Read: `review-issue-4-fix1.diff`, the "Fix round 1" part of the report, and the touched code at `0ad73cc`. I checked the claims against electron-updater 6.8.12 in `node_modules`: `AppUpdater.js`, `BaseUpdater.js`, `NsisUpdater.js`, `providers/GitHubProvider.js`, `providers/Provider.js`, `electronHttpExecutor.js`. Nothing was run.

### The findings

| Item | Verdict | Notes |
|---|---|---|
| **I1** (Photo Tool asked twice) | ✅ fixed | `confirmQuit` is the only question. "Keep editing" returns before anything closes (`runDesktopApp.ts` prepareInstall). `allowClose(true)` is on only for the close loop and turned off in a `finally`. Photo Tool's `will-prevent-unload` goes through `letPageClose({confirmed})` (`gallery.ts`, `editActions.ts`). The editor has no `allowClose`, so its pending-save loop is unchanged. As a bonus, a downloaded update stays offered as "Install update x…", and the check at start does not offer it again. |
| **I2** (silent exit after a failed install) | ✅ fixed for every synchronous failure (all Linux paths); Windows async spawn failure remains (Minor, below) | **Before closing:** `installProblem` checks the downloaded files, that the AppImage's folder is writable, and that a .deb has a graphical sudo; then the pkexec probe runs. **After closing:** `install()` listens for `error` during `quitAndInstall`, catches throws, and reads `quitAndInstallCalled === false`. This matches `BaseUpdater.quitAndInstall` and `install()` exactly (`BaseUpdater.js:13-26, 42-63`). `installFailed` clears the backstop, says what failed, offers the release page, then `app.relaunch` (an AppImage from `$APPIMAGE`) and `app.exit`. |
| **I3** (per-install id sent) | ✅ fixed in substance (see deviation (a)) | No `.updaterId` is created, because `stagingUserIdPromise` is replaced. Rollout is always in, because the `isUserWithinRollout` setter exists (`AppUpdater.js:96-101`). The header carries a constant value. |
| **I4** (AppImage updating as a .deb) | ✅ fixed at runtime | With `APPIMAGE` set, `updaterKind` constructs `AppImageUpdater` and never reads the `autoUpdater` getter. The `APPDIR`/`execPath` check closes the case of `APPIMAGE` inherited from another AppImage, where `AppImageUpdater` would have deleted that other file. The build-level CI assertion I suggested was not added. That is acceptable, since `package-type` in the AppImage is now ignored, but `desktop.yml` still doesn't check that `<channel>-linux.yml` lists both packages. |
| **M1** (malformed `UPDATE_FEED` hangs start-up) | ✅ fixed | All of `startUpdates` is inside `try/catch`, which leaves `updates = null`. About then hides its Check button (`canCheckForUpdates: !!updates && …`). The Help menu shows no update items. |
| **M2** (release missing this program's yml) | ✅ fixed | `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` is now a failure. "No release" is decided on error codes and `HttpError.statusCode`. The rewrapped `releases/latest` case (`ERR_UPDATER_INVALID_RELEASE_FEED`, `GitHubProvider.js:106-108, 158-175`) counts only when its inner error is `HttpError: 404`, so being offline there is no longer "up to date". |

### The implementer's deviations

**(a) The header is still sent, as all zeros. Accepted: this meets "no per-install id".**
- Their claim that electron-updater won't let the header be dropped holds in practice:
  - `getUpdateInfoAndProvider` always calls `client.setRequestHeaders(this.computeFinalHeaders({ "x-user-staging-id": stagingUserId }))` (`AppUpdater.js:387-388`).
  - `computeFinalHeaders` only does `Object.assign(headers, this.requestHeaders)` (`:334-339`), and `Provider.createRequestOptions` merges `requestHeaders` into every request (`Provider.js:61-67`).
  - The one way to "drop" it would be a value of `undefined`, which is then passed straight into `electron.net.request({ headers })` (`electronHttpExecutor.js:54-57`). That is not a supported header value and risks a throw on every request. The only other route is to override `setRequestHeaders` on the provider object, which is private and fragile.
- A constant that is the same for every user identifies nobody and cannot link one install's requests together. GitHub still sees the IP address and Electron's User-Agent, as any request does.
- The `.updaterId` file is never written, and the "Generated new staging user ID" log line is gone.
- Nit: the test asserts `headers['x-user-staging-id'] ?? NO_STAGING_ID` (`updates.test.ts:198`), so a missing header would also pass. That is harmless, but it does not prove the override is applied.

**(b) A .deb update asks for the password twice. Accepted as a documented trade-off (Minor UX).**
- The probe (`pkexec --disable-internal-agent dpkg --version`) is the only way to find a missing polkit agent, or a closed prompt, before the window and server are torn down. That was the failure I2 was about.
- The command it runs as root is harmless.
- Ubuntu's default pkexec policy is `auth_admin` with no keep, so two prompts are expected. The README now says so.
- One wording nit: a wrong password at the probe also exits 127 and is reported as "cannot ask for the administrator password (… or was refused)". That is accurate, if not precise.

**Windows installer that reports success but fails to start: not recovered. Accepted as Minor.**
- `NsisUpdater.doInstall` returns true right after `spawnLog` (`NsisUpdater.js:102-140`), and `app.quit` is already queued. An async spawn failure is then handled inside electron-updater: EACCES/UNKNOWN retries through `elevate.exe`, ENOENT through `shell.openPath`, and otherwise it is only logged.
- The file was checked to exist just before closing (`installProblem`), so this needs the installer deleted or blocked (antivirus) in the instant between the check and the spawn.
- A fix would need a "did the app come back" marker on the next start, which is out of scope here.

### New findings in the touched lines

No Critical or Important problems.

Minor:
- **N1.** `cannotInstall` logs the AppImage folder, an absolute user path (`log('the update cannot be installed', problem)` with `problem.appImageNotWritable(folder)`). This adds to M4. *Fix:* log the problem kind, not the text with the path.
- **N2.** If an AppImage install fails *after* electron-updater has already deleted the old `$APPIMAGE` (the move fails), `installFailed` relaunches a file that no longer exists, and the app just doesn't come back. The writability check beforehand makes this unlikely. *Fix (optional):* in `installFailed`, skip the relaunch when `!existsSync(appImage)`, and say so in the message.
- **N3.** The pkexec probe has a 5-minute timeout. If the user leaves the password box open, Restart now waits that long with nothing else visible (the box is on screen). This is acceptable as it stands.

### Still open from the first review (not asked for this round)

M3–M9: `null` read as up to date, the updater's info log, retrying on every start, the lazy-val notice, pre-release tags, `UPDATE_FEED` hosts, and the small UI items. Task 10 is still unproven by hand: nothing on Windows or Linux has been installed for real, and the new recovery paths are covered only by unit and source tests.

**Re-review verdict:** I1–I4, M1 and M2 are fixed. Deviations (a) and (b) are acceptable. No new Critical or Important findings. From a code-review standpoint this is ready to merge; the one condition is the earlier ⚠️: the real install path (Task 10) has not been run.
