# Check for updates: design

Date: 2026-11-25. Branch `update-check`, cut from `split-programs` (the program split is not on main yet).

## Why

Customers run the installed desktop programs, Photo Tool and Photobook Editor, and today never hear
that a newer version exists: a new version is a new installer they have to go and find. The owner
wants the app to look at GitHub (github.com/funvill/photo-tool) for a new release, tell the user when
one is ready, and download and install it.

## Goals

- Both programs, on Windows (NSIS installer) and Linux (.deb and AppImage).
- At start, at most once a day, the app checks for a newer release. The user can turn this off.
- **Help › Check for updates…** checks now, whatever the setting.
- When a newer release exists, the user is told and chooses: download it, read the release notes, or later.
- The download installs itself and the app restarts into the new version (electron-updater).
- "Ready" means the owner pressed **Publish** on GitHub. Nobody is told about a draft.
- Unit tests never touch the real GitHub API or network.

## Non-goals

- Code signing. The builds stay unsigned; Windows SmartScreen may warn as it does on a first install.
- Differential (block-map) downloads. Every update downloads the whole installer.
- macOS.
- Updates of the web/Pages build or of `npm run dev`; only the packaged desktop programs update.
- Pre-release or beta channels for users.

## Anti-goals (would be a failure even if it works)

- The app talks to anything but GitHub for this, or the page (renderer) gains network access.
- A check or download runs during a self-test, or the self-test starts allowing other hosts.
- An update closes the app while the user has unsaved work, or kills the local server before it has
  closed its database.
- The daily check nags: a failed check (offline, rate-limited) shows nothing at start.
- One program installs the other program's installer.

## Decisions made with the owner

1. **When:** a quiet check at start, at most once every 24 hours, on by default, plus
   **Help › Check for updates…**. A checkbox **Help › Check for updates automatically** turns the
   start check off. The setting and the time of the last check are kept in the program's profile
   folder (`<profileDir>/updates.json`), not in the data folder.
2. **How it installs:** electron-updater (approach B below), restart-and-install.
3. **How releases get to GitHub:** on a `v*` tag, CI uploads both programs' installers and update
   files to a **draft** release named after the tag. The owner reads it over and presses **Publish**.

## Approaches considered

- **A. Download the installer and open it.** No new dependency, installers unchanged; the user runs
  the installer. Not chosen.
- **B. electron-updater (chosen).** Downloads, verifies the SHA-512 from the release's update file,
  installs on quit and restarts. Smoothest for the user. Costs: a new runtime dependency with its own
  network code; the build has to publish update files again; the deb path asks for the system password
  (pkexec) when installing.
- **C. Open the release page in the browser.** Does not download; does not meet the request.

## How it works

### One release, two programs

Both programs take their version from the root `package.json`, and CI builds both on a `v*` tag.
So one GitHub release `v0.1.32` carries every installer of both programs. Each program has its own
electron-updater **channel**, so their update files do not collide:

| Program | channel | Windows update file | Linux update file |
|---|---|---|---|
| Photo Tool | `photo-tool` | `photo-tool.yml` | `photo-tool-linux.yml` |
| Photobook Editor | `photobook-editor` | `photobook-editor.yml` | `photobook-editor-linux.yml` |

(electron-builder 26 names the file `${channel}${osSuffix}.yml`; the deb and AppImage targets both
add their file to the one Linux update file.) Each update file names only that program's installer,
so a program can only ever install itself.

Each `electron-builder.config.cjs` replaces `publish: null` with
`publish: { provider: 'github', owner, repo, channel: '<program>', releaseType: 'draft' }`, where
owner and repo are read from the program's `product.json` `repository` (`github:funvill/photo-tool`),
not written out twice (builder's call). Only funvill/photo-tool releases: the split cuts this repo
off from the upstream it was forked from, so nothing here is set up per repo.
That makes electron-builder write the update files and put `app-update.yml` in the app's resources.
The NSIS settings stay one-click, per-user, no elevation; `differentialPackage` stays false. The
comments that say "no updater" change to say what is there now.

### In the app

A new shared module, `shared/electron/updates.ts`, owns the feature. The shell (`runDesktopApp.ts`)
gets small hooks only: it starts the module after the window is up, adds its items to the Help menu,
and lets it run the quit-and-install. `DesktopProgram` gains `updateChannel: string`.

- electron-updater is used with `autoDownload: false`, `autoInstallOnAppQuit: false`, and the
  program's channel. The check, the decision what to show, and the settings are pure functions
  with the updater passed in, so tests give a fake updater.
- **Start check:** only when packaged, not in a self-test, not when
  `<PREFIX>_NO_UPDATE_CHECK` is set, the setting is on, and the last check was ≥ 24 h ago. It runs a
  few seconds after the window shows. A failure is logged, never shown.
- **F1 / Help › About:** F1 is the About item's shortcut. The About box shows the name and
  version, a line `Version <version> (Electron <x>, <platform> <arch>)`, and a **Check for updates**
  button (only when packaged) that runs the manual check below. The About text no longer says the
  editor never uses the network.
- **Manual check:** always shows a result: "Photo Tool 0.1.32 is available (you have 0.1.31)",
  "You have the newest version (0.1.31)", or "Could not check for updates: <reason>". From source
  (not packaged) it says updates only work in the installed app.
- **Update found** (either check): a dialog with **Download**, **Release notes** (opens the release
  page in the user's browser with `shell.openExternal`) and **Later**. A version the user said Later
  to is not offered again by the start check that day (the 24 h rule covers this).
- **Downloading:** the window's taskbar progress bar shows progress (`win.setProgressBar`); the Help
  menu item reads "Downloading update… 42 %" and is disabled. A failed download says so and offers
  to try again.
- **Downloaded:** a dialog "Photo Tool 0.1.32 is ready to install. The app will close and restart."
  with **Restart now** and **Later**. Later installs nothing; the next start check offers it again.
- **Restart now**, in this order (builder's call, after the review):
  1. The program's `confirmQuit`, if it has one (Photo Tool's unsaved photo edits). False: stop, install nothing.
  2. **Close the window while the server still runs.** The editor has no `confirmQuit`; it saves on a
     short delay and, in `beforeunload` (`photobook-editor/web/store.ts`), starts the pending save and
     cancels the close. So the install path calls `win.close()`, and if the window is still there after
     ~1 s, tries again, for up to ~10 s. If it never closes, the install is called off with "Your latest
     changes are still being saved. Try again in a moment." Nothing has been stopped at that point.
  3. Stop the local server the normal way (it closes its database), mark the app as quitting.
  4. `autoUpdater.quitAndInstall()`. The shell's `before-quit` handler lets this quit through
     (quitting is already set, so it neither asks again nor calls `app.exit`, which would skip the
     quit event electron-updater installs on).

  The same last-seconds gap exists in an ordinary **Quit** (`before-quit` stops the server and calls
  `app.exit`, skipping `beforeunload`). Fixing that is out of scope here; it is a follow-up.

### Network

electron-updater fetches through Electron's `net` (Chromium's network stack), so the shell's
`host-resolver-rules`, which lets no name be looked up, would stop it. Both programs' rules gain
`EXCLUDE` entries for `github.com`, `api.github.com`, `objects.githubusercontent.com` and
`release-assets.githubusercontent.com` (the hosts release downloads redirect to). The window's
request guard is unchanged: electron-updater uses its own session, and the page still reaches only
the local server. The editor's description ("Works offline") and Photo Tool's (which lists its
network uses), the About box, the shell's header comment, `docs/electron-plan.md` and the README say
the app now contacts GitHub to check for updates and how to turn it off.

### Release step (CI)

The build jobs keep building with `--publish never`; they now also keep the update files
(`*.yml`, `*.blockmap` if any) beside the installers as artifacts. A new job, only on `v*` tags and
after all build jobs pass, downloads every artifact and creates one draft release for the tag with
`gh release create <tag> --draft` (or adds to the existing draft), uploading all installers and all
four update files. It checks that the tag equals `v` + `package.json` version first, and runs only
when `github.repository == 'funvill/photo-tool'`, so a copy of the workflow elsewhere makes no drafts. One job does
the upload, so the matrix jobs cannot race to create two drafts. It uses the workflow's `GITHUB_TOKEN`
with `contents: write`.

GitHub turns spaces in asset names into dots (`Photo Tool Setup 0.1.32.exe` →
`Photo.Tool.Setup.0.1.32.exe`). electron-builder already writes the dotted name into the update file
for the github provider; the upload must keep that name. The builder checks this.

## Testing

- **Unit (vitest, no network):** settings read/write (missing, corrupt file), the once-a-day rule,
  the message texts, the decision "start check or not" (packaged, self-test, env var, setting), the
  check flow with a fake updater (newer / same / error / download progress / downloaded), that
  `confirmQuit` false stops an install, both builder configs' publish/channel, and that both programs'
  host-resolver rules allow exactly the GitHub hosts above and nothing more.
- **Self-test:** unchanged behaviour (no check); `requestsToOtherHosts` must stay empty.
- **In the built program (manual, owner's machine):** electron-updater's `generic` provider pointed at
  a local folder served on 127.0.0.1 with a fake newer version's update file and installer, through a
  dev-only override (`<PREFIX>_UPDATE_FEED` env var, ignored unless set). Check that the menu item,
  the dialogs, the download, and restart-and-install work on Windows. Linux is proved by CI building
  the files; installing on Linux is checked once a real release exists.

## Left to the builder

- Exact dialog wording beyond the texts above, menu accelerators, the delay before the start check.
- How the module is split into pure parts and the Electron glue.
- Whether `updates.json` writes are atomic (they should not corrupt on a crash).
- The CI job's exact shape, as long as one job uploads to one draft.

## Risks

- Linux deb install goes through pkexec; on a desktop without a polkit agent it fails. The app then
  says so and opens the release page instead.
- AppImage updates replace the AppImage file in place; this needs the file to be writable.
- Until the first release is published, every check finds nothing (GitHub returns 404); that is
  treated as "no update", not an error.
