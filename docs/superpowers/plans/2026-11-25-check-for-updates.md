# Check for Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Photo Tool and Photobook Editor check GitHub for a newer release (daily at start and from the Help menu), offer it, download it and restart into it with electron-updater; CI puts each `v*` tag's installers in a draft release.

**Architecture:** A pure module (`shared/electron/updateRules.ts`) holds settings, the once-a-day rule, texts and host lists; a controller (`shared/electron/updates.ts`) drives an injected updater, so tests use a fake. The shell (`runDesktopApp.ts`) gets three hooks only: Help menu items, a start check after the window shows, and the safe install sequence. Each program sets its own update channel so one release carries both programs.

**Tech Stack:** Electron 45, electron-builder 26.18, electron-updater 6.x (new runtime dependency), TypeScript, vitest, GitHub Actions + `gh`.

**Spec:** `docs/superpowers/specs/2026-11-25-check-for-updates-design.md`

## Global Constraints

- Branch `update-check` (from `split-programs`), worktree `../photobook_helper-updates`. Touch only new files, the shell/menu hooks, the two program mains, product.json descriptions, builder configs, the tests named here, CI, docs.
- Before each commit: `npm version patch --no-git-tag-version`. Commit as `git -c user.name="SWS-Chipkin" -c user.email="sws-dev@chipkin.com" commit`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never read or test against `photos/`, `data/`, `trial-output/` or real `%APPDATA%` app folders; use temp folders via `PHOTO_TOOL_*`, `PHOTOBOOK_*`, `PHOTOINFO_FALLBACK_DIR`.
- No unit test touches the network or the real GitHub API.
- Channels: Photo Tool `photo-tool`, Photobook Editor `photobook-editor`. Update files `photo-tool.yml`, `photo-tool-linux.yml`, `photobook-editor.yml`, `photobook-editor-linux.yml`.
- Owner/repo come from `product.json` `repository` (`github:funvill/photo-tool`), never written out a second time.
- Update hosts, exactly: `github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`.
- Start check: packaged only, never in a self-test, never when `<PREFIX>_NO_UPDATE_CHECK` is set, setting on, last check ≥ 24 h ago. Failures at start are logged, never shown.
- Settings file: `<profileDir>/updates.json`, `{ "auto": boolean, "lastCheck": number | null }`; default `{ auto: true, lastCheck: null }`.
- `autoDownload = false`, `autoInstallOnAppQuit = false`. NSIS stays one-click, per-user, no elevation, `differentialPackage: false`.
- The window's request guard (`requestAllowed`) does not change.
- Dev feed override `<PREFIX>_UPDATE_FEED` (a URL) → electron-updater `generic` provider with the program's channel. Ignored when unset.

## Review Focus

1. **No release yet / 404 / "Unable to find latest version":** treated as "up to date", never an error dialog. → test in Task 2 (`isNoRelease`) and Task 3 (`checkNow` with a 404 error says "newest version").
2. **Offline at start:** the start check rejects; nothing shown, `lastCheck` not advanced (so it retries next start). → Task 3 test `start check failure is silent and keeps lastCheck`.
3. **Corrupt or hand-edited `updates.json`** (`{"auto":"yes"}`, not JSON): read as defaults, never throws. → Task 2 test.
4. **Window close cancelled by the editor's pending save, and `window-all-closed` quitting the app mid-install:** the install path must neither lose the save nor let the ordinary quit path `app.exit` before `quitAndInstall`. → Task 4 source tests on the `installing` flag and close-retry loop.
5. **Two checks at once** (start check running, user clicks the menu item; double click on Download): one check / one download in flight. → Task 3 test `concurrent checks share one request`.

---

### Task 1: Add electron-updater and the publish config

**Files:**
- Modify: `package.json`, `package-lock.json` (dependency `electron-updater`)
- Modify: `photo-tool/electron-builder.config.cjs`, `photobook-editor/electron-builder.config.cjs`
- Modify: `scripts/desktop/build.mjs` only if the app folder's package.json must list `electron-updater` for electron-builder to see it (see Step 4)
- Test: `photo-tool/tests/photo-tool-shell.test.ts:81-87`, `photobook-editor/tests/editor-shell.test.ts:71-77`

**Interfaces:**
- Produces: built `resources/app-update.yml` with `provider: github, owner: funvill, repo: photo-tool, channel: <program>`; installer folder gets `<channel>.yml` (Windows) / `<channel>-linux.yml` (Linux).

- [ ] **Step 1: Replace each "no updater" builder test** with `it('publishes to its own update channel on GitHub')`:

```ts
const config = builderConfig('win32');
expect(config.publish).toEqual({ provider: 'github', owner: 'funvill', repo: 'photo-tool', channel: 'photo-tool', releaseType: 'draft' });
expect(config.nsis).toMatchObject({ oneClick: true, perMachine: false, allowElevation: false, differentialPackage: false });
expect(code(/* program electron sources */)).not.toMatch(/crashReporter|update-electron-app/);
```
(editor: `channel: 'photobook-editor'`; drop the `devDependencies not /updater/` line — `electron-updater` is a runtime dependency.) Note: these two test files have uncommitted edits in the main checkout from another session; keep the change to this one `it` block.

- [ ] **Step 2: Run** `npx vitest run photo-tool/tests/photo-tool-shell.test.ts photobook-editor/tests/editor-shell.test.ts` — expect the two new tests FAIL (`publish` is null).
- [ ] **Step 3: Implement.** `npm install electron-updater@^6.8`. In each config: `const [owner, repo] = product.repository.replace(/^github:/, '').split('/');` and `publish: { provider: 'github', owner, repo, channel: '<program>', releaseType: 'draft' }`. Update the header comment ("no publish, no updater") and the `packElevateHelper`/`differentialPackage` comment to say updates are whole-installer downloads.
- [ ] **Step 4: Check** `npm run dist:dir:photo-tool` (builds only, does not start the app) and confirm `dist/installer/photo-tool/win-unpacked/resources/app-update.yml` exists and has `channel: photo-tool`. If electron-builder warns that electron-updater is missing from the app's dependencies, add it to the app package.json written by `scripts/desktop/build.mjs` (bundled main.cjs already contains it; the entry is only for electron-builder's compatibility check).
- [ ] **Step 5: Run** the two test files — PASS. Commit `build: publish update files to each program's GitHub channel`.

### Task 2: Pure rules — settings, schedule, texts, hosts

**Files:**
- Create: `shared/electron/updateRules.ts`
- Test: `shared/tests/update-rules.test.ts`

**Interfaces:**
- Produces:
  - `UPDATE_HOSTS: readonly string[]` (the four hosts above, in that order)
  - `CHECK_INTERVAL_MS = 86_400_000`
  - `interface UpdateSettings { auto: boolean; lastCheck: number | null }`
  - `readUpdateSettings(file: string): UpdateSettings`; `writeUpdateSettings(file: string, s: UpdateSettings): void` (write `file.tmp`, rename)
  - `shouldCheckAtStart(o: { packaged: boolean; selfTest: boolean; disabledByEnv: boolean; settings: UpdateSettings; now: number }): boolean`
  - `githubRepo(repository: string | undefined): { owner: string; repo: string } | null` (`'github:a/b'` → `{a,b}`, anything else null)
  - `releasePage(repo: {owner;repo}, version: string): string` → `https://github.com/<owner>/<repo>/releases/tag/v<version>`
  - `isNoRelease(e: unknown): boolean` — true for messages containing `404`, `Unable to find latest version on GitHub`, or `No published versions on GitHub`
  - `updateText` object with: `available(name, latest, current)` → `"${name} ${latest} is available (you have ${current})."`; `upToDate(name, current)` → `"You have the newest version of ${name} (${current})."`; `failed(reason)` → `"Could not check for updates: ${reason}"`; `notPackaged(name)` → `"Updates only work in the installed ${name}."`; `ready(name, version)` → `"${name} ${version} is ready to install. The app will close and restart."`; `downloading(percent)` → `"Downloading update… ${percent} %"` (rounded); `stillSaving` → `"Your latest changes are still being saved. Try again in a moment."`; `downloadFailed(reason)` → `"The update did not download: ${reason}"`.

- [ ] **Step 1: Write tests:** defaults when file missing; defaults for `not json` and `{"auto":"yes","lastCheck":"x"}`; round trip; `shouldCheckAtStart` true only for `{packaged:true, selfTest:false, disabledByEnv:false, auto:true, lastCheck: now-86_400_000}`, false for each single flip and for `lastCheck: now-86_399_999`, true for `lastCheck:null`; `githubRepo('github:funvill/photo-tool')` → `{owner:'funvill',repo:'photo-tool'}`, `githubRepo('https://x')` → null; `isNoRelease(new Error('HttpError: 404 Not Found'))` true, `isNoRelease(new Error('net::ERR_INTERNET_DISCONNECTED'))` false; each text exactly as above; `hostResolverRules(UPDATE_HOSTS)` equals `'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE github.com, EXCLUDE api.github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com'`. Use `mkdtempSync(join(tmpdir(), 'updates-'))` for files.
- [ ] **Step 2: Run** `npx vitest run shared/tests/update-rules.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `shared/electron/updateRules.ts` (no Electron import, like `config.ts`).
- [ ] **Step 4: Run** — PASS. Commit `feat: update rules: settings, once-a-day check, texts, hosts`.

### Task 3: The update controller with an injected updater

**Files:**
- Create: `shared/electron/updates.ts`
- Test: `shared/tests/updates.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:

```ts
export interface UpdaterLike {
  channel: string | null; autoDownload: boolean; autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: 'download-progress', cb: (p: { percent: number }) => void): unknown;
}
export interface UpdateDeps {
  updater: UpdaterLike; channel: string; productName: string; currentVersion: string;
  packaged: boolean; repo: { owner: string; repo: string } | null; settingsFile: string;
  ask(o: { message: string; buttons: string[] }): Promise<number>;   // index of the button
  openExternal(url: string): void;
  setProgress(fraction: number | null): void;                        // win.setProgressBar
  refreshMenu(): void;                                               // rebuild Help menu
  prepareInstall(): Promise<boolean>;                                // shell's safe-quit sequence (Task 4)
  log(...a: unknown[]): void; now(): number;
}
export interface Updates {
  checkAtStart(o: { selfTest: boolean; disabledByEnv: boolean }): Promise<void>;
  checkNow(): Promise<void>;
  menuItems(): Electron.MenuItemConstructorOptions[];  // "Check for updates…"/downloading label, "Check for updates automatically" checkbox
}
export function createUpdates(d: UpdateDeps): Updates;
```
Buttons: update found → `['Download', 'Release notes', 'Later']`; downloaded → `['Restart now', 'Later']`; download failed → `['Try again', 'Close']`; info → `['OK']`.

- [ ] **Step 1: Write tests** with a fake updater (records calls, resolves scripted results) and a fake `ask` that returns scripted indices:
  - `configures the updater`: after `createUpdates`, `channel === 'photo-tool'`, `autoDownload === false`, `autoInstallOnAppQuit === false`.
  - `checkNow: newer → Download → downloads → Restart now → prepareInstall → quitAndInstall` (order asserted; `setProgress` called with 0.42 for `{percent:42}` then `null`).
  - `prepareInstall false → no quitAndInstall`.
  - `checkNow: same version → upToDate text`; `404 error → upToDate text`; `other error → failed text`; `not packaged → notPackaged text, no checkForUpdates call`.
  - `Release notes → openExternal('https://github.com/funvill/photo-tool/releases/tag/v0.1.40')`, then the dialog is shown again.
  - `start check: skipped when shouldCheckAtStart false (no checkForUpdates)`; `newer → asks; lastCheck = now`; `up to date → nothing shown; lastCheck = now`; `failure is silent and keeps lastCheck`.
  - `checkbox toggles settings.auto and refreshMenu is called`.
  - `concurrent checks share one request` (two `checkNow` before resolve → one `checkForUpdates`); `downloading: menu item label is downloading text and disabled`.
- [ ] **Step 2: Run** `npx vitest run shared/tests/updates.test.ts` — FAIL.
- [ ] **Step 3: Implement** `createUpdates` in `shared/electron/updates.ts`. It imports nothing from `electron` at runtime (types only), so the test needs no Electron.
- [ ] **Step 4: Run** — PASS. Commit `feat: update controller: check, offer, download, install`.

### Task 4: Shell hooks

**Files:**
- Modify: `shared/electron/runDesktopApp.ts` (interface, `buildMenu` Help submenu, `main()` after `loadURL`, `window-all-closed`, `before-quit`, header comment lines 6-9)
- Test: `shared/tests/desktop-shell.test.ts:95-103`

**Interfaces:**
- Consumes: `createUpdates`, `UpdateDeps` (Task 3); `githubRepo`, `hostResolverRules` unchanged.
- Produces: `DesktopProgram.updateChannel: string` (required). Env vars `<PREFIX>_NO_UPDATE_CHECK`, `<PREFIX>_UPDATE_FEED`.

- [ ] **Step 1: Replace the "has no updater" test** with source checks on `runDesktopApp.ts`: imports `autoUpdater` from `electron-updater`; contains no `crashReporter`; `window-all-closed` handler returns early when `installing`; `before-quit` returns early when `quitting`; `prepareInstall` calls `program.confirmQuit`, then `win.close()` in a loop bounded by 10 s, then `stopServer()`, then sets `quitting = true`; the start check is not called when `selfTest` is set; `setFeedURL({ provider: 'generic'` appears only behind `envVar('UPDATE_FEED')`.
- [ ] **Step 2: Run** `npx vitest run shared/tests/desktop-shell.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
  - `let installing = false;` `window-all-closed`: `if (installing) return;` before the existing quit.
  - `async function prepareInstall(): Promise<boolean>` — `if (program.confirmQuit && !program.confirmQuit()) return false;` set `installing = true`; while `win && !win.isDestroyed()` and < 10 s: `win.close()`, wait 1 s; if the window is still there: `installing = false`, show `updateText.stillSaving`, return false; `await stopServer(); quitting = true; return true;`.
  - In `main()`, after `loadURL` and only when `!selfTest`: build `updates = createUpdates({ updater: autoUpdater, channel: program.updateChannel, repo: githubRepo(program.repository), settingsFile: join(layout.profileDir, 'updates.json'), ask: dialog.showMessageBox on win, openExternal: shell.openExternal, setProgress: (f) => win?.setProgressBar(f ?? -1), refreshMenu: rebuild menu, prepareInstall, ... })`; if `envVar('UPDATE_FEED')`, `autoUpdater.setFeedURL({ provider: 'generic', url, channel: program.updateChannel })`; `setTimeout(() => void updates.checkAtStart({ selfTest: !!selfTest, disabledByEnv: !!envVar('NO_UPDATE_CHECK') }), 5000)`.
  - `buildMenu`: Help submenu = `[...(updates?.menuItems() ?? []), { type: 'separator' }, About]`; keep a `rebuildMenu()` that reuses the last `fileItems`.
  - Linux .deb without `pkexec` on PATH (`!process.env.APPIMAGE && process.platform === 'linux'`): `prepareInstall` is replaced by opening the release page and returning false (spec's Risks fallback, decided here because a failure after quit cannot be shown).
  - Header comment: replace "There is deliberately no crash reporter and no updater" with what the updater may reach and that the window's guard is unchanged.
- [ ] **Step 4: Verify the updater's own session.** Read `node_modules/electron-updater/out/ElectronHttpExecutor.js`: confirm it uses `session.fromPartition(...)`, not `defaultSession`, so `requestAllowed` stays as is. If it used the default session, add the update hosts to both programs' `requestAllowed` for `GET` only and add that to Task 5's tests.
- [ ] **Step 5: Run** `npx vitest run shared/tests` and `npx tsc --noEmit` — PASS. Commit `feat: shell: Help menu update items, daily check, safe install`.

### Task 5: Both programs opt in

**Files:**
- Modify: `photo-tool/electron/main.ts`, `photo-tool/electron/mapTiles.ts:54-56`, `photobook-editor/electron/main.ts`
- Modify: `photo-tool/product.json`, `photobook-editor/product.json` (`description`)
- Test: `photo-tool/tests/photo-tool-shell.test.ts:200-210`, `photobook-editor/tests/editor-shell.test.ts:180-190`

**Interfaces:**
- Consumes: `UPDATE_HOSTS` (Task 2), `DesktopProgram.updateChannel` (Task 4).

- [ ] **Step 1: Update tests:** editor `hostResolverRules: hostResolverRules(UPDATE_HOSTS)` in main and the rules string ends with the four update-host EXCLUDEs; Photo Tool `mapHostResolverRules()` equals `hostResolverRules([TILE_HOST, ...UPDATE_HOSTS])`; each main contains `updateChannel: '<program>'`; descriptions: editor → `"Make a photobook from a folder of photos and export print-ready PDFs. Works offline; checks GitHub once a day for a new version (Help › Check for updates automatically turns this off)."`; Photo Tool's adds `", and to check GitHub for a new version"` to its list of network uses.
- [ ] **Step 2: Run** both test files — FAIL.
- [ ] **Step 3: Implement** the four edits.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` — PASS (all suites). Commit `feat: Photo Tool and Photobook Editor check GitHub for updates`.

### Task 6: F1 opens About, with version details and a Check for updates button

**Files:**
- Modify: `shared/electron/config.ts` (`describeAbout`, new constant), `shared/electron/runDesktopApp.ts` (`buildMenu` About item, `showAbout`)
- Test: `shared/tests/desktop-config.test.ts` (describeAbout cases), `shared/tests/desktop-shell.test.ts`

**Interfaces:**
- Consumes: `Updates.checkNow()` (Task 3), the `updates` instance built in Task 4.
- Produces: `CHECK_UPDATES_BUTTON = 'Check for updates'` in `config.ts`; `describeAbout` takes two more fields, `canCheckForUpdates: boolean` and `runtime: string` (e.g. `"Electron 45.4.1, win32 x64"`).

- [ ] **Step 1: Write tests** for `describeAbout`:
  - `canCheckForUpdates: true, hasNotices: true` → `buttons` equal `['OK', 'Check for updates', 'Third-party notices']`; with `canCheckForUpdates: false` (run from source) → `['OK', 'Third-party notices']`.
  - `message` stays `"<productName> <version>"`; `detail` contains the line `Version <version> (<runtime>)`.
  - The network sentence: the editor's no longer says "never uses the network"; both programs' say they check GitHub for a new version once a day unless turned off in Help.
  - Shell source test: the About menu item has `accelerator: 'F1'`, and `showAbout` calls `updates.checkNow()` when the pressed button is `CHECK_UPDATES_BUTTON`.
- [ ] **Step 2: Run** `npx vitest run shared/tests/desktop-config.test.ts shared/tests/desktop-shell.test.ts` — FAIL.
- [ ] **Step 3: Implement.** About item: `{ label: `&About ${NAME}`, accelerator: 'F1', click: about }`. The menu accelerator works whenever the window has focus, on Windows and Linux. (Neither page uses F1 today; if one later does, the menu wins.) `aboutBox()` passes `canCheckForUpdates: app.isPackaged && !selfTest` and `runtime: `Electron ${process.versions.electron}, ${process.platform} ${process.arch}``. In `showAbout`, the pressed `CHECK_UPDATES_BUTTON` → `void updates?.checkNow()` (the About box has closed by then; the check shows its own result).
- [ ] **Step 4: Run** the tests — PASS. Commit `feat: F1 opens About, with version details and Check for updates`.

### Task 7: CI drafts the release

**Files:**
- Create: `scripts/release/collect-assets.mjs`
- Modify: `.github/workflows/desktop.yml` (artifact paths, new `release` job, header comment)
- Test: `tests/release-assets.test.ts`

**Interfaces:**
- Produces: `collectAssets(inDir: string, outDir: string): { name: string; from: string }[]` — for every `*.yml` update file under `inDir`, each `files[].url` is matched to a local file under `inDir` **by its sha512** (base64, as the yml has it) and copied to `outDir/<url>`; the yml is copied too. Throws naming the url if no file matches. CLI: `node scripts/release/collect-assets.mjs <in> <out>`.

- [ ] **Step 1: Write tests** in a temp folder: a fake `photo-tool.yml` naming `Photo-Tool-Setup-0.1.40.exe` with the sha512 of a file saved as `Photo Tool Setup 0.1.40.exe` → copied under the yml's name; a `-linux.yml` with two files (deb + AppImage) → both copied; a url with no matching hash → throws with that url.
- [ ] **Step 2: Run** `npx vitest run tests/release-assets.test.ts` — FAIL.
- [ ] **Step 3: Implement** the script (YAML parsed with the `js-yaml` already in node_modules via electron-builder, or a 10-line parser for the `url:`/`sha512:` pairs; builder's call).
- [ ] **Step 4: CI.** Windows and Linux artifact uploads add `dist/installer/${{ matrix.program }}/*.yml`. New job `release`: `needs: [windows, linux]`, `if: startsWith(github.ref, 'refs/tags/v') && github.repository == 'funvill/photo-tool'`, `permissions: contents: write`, steps: checkout; download all `*-x64` artifacts into `in/`; fail unless `${GITHUB_REF_NAME}` == `v$(node -p "require('./package.json').version")`; `node scripts/release/collect-assets.mjs in out`; `gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --draft --title "$TAG" --generate-notes`; `gh release upload "$TAG" out/* --clobber`. Rewrite the header's "nothing is published".
- [ ] **Step 5: Run** the test — PASS; `npx yaml-lint` not needed: run `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/desktop.yml','utf8'))"` — no error. Commit `ci: a v* tag drafts one release with both programs' installers`.

### Task 8: Docs

**Files:**
- Modify: `docs/electron-plan.md:19-20`, `README.md` (desktop section), and a short "Releasing" note in `docs/` or README: tag `v<version>` → CI drafts → read it → Publish.

- [ ] **Step 1:** Write it. Say: what is contacted, when, how to turn it off, `<PREFIX>_NO_UPDATE_CHECK`, `<PREFIX>_UPDATE_FEED` (testing only), SmartScreen warning on unsigned builds, deb asks for the password.
- [ ] **Step 2:** `npm test` — PASS. Commit `docs: updates and the release step`.

### Task 9: Prove it in the built program (Windows)

No code. Everything in a scratch folder; data via `PHOTO_TOOL_DATA_DIR`, `PHOTO_TOOL_PROFILE_DIR`, `PHOTOINFO_FALLBACK_DIR`.

- [ ] **Step 1:** `npm run dist:photo-tool` at the current version N → install it from `dist/installer/photo-tool/` (per-user).
- [ ] **Step 2:** Bump to N+1 without committing (`npm version patch --no-git-tag-version`), `npm run dist:photo-tool`, copy `photo-tool.yml` and the installer (under the yml's url name, via `collect-assets.mjs`) into a scratch feed folder; restore the version.
- [ ] **Step 3:** Serve the feed on `127.0.0.1:<port>` (a 10-line `node:http` static server in the scratchpad). `127.0.0.1` is already excluded from the resolver rules, so no rule change is needed.
- [ ] **Step 4:** Start the installed Photo Tool with `PHOTO_TOOL_UPDATE_FEED=http://127.0.0.1:<port>/` and the temp data env vars. Check: F1 opens About showing version N and a Check for updates button that runs the check; Help › Check for updates… shows "Photo Tool N+1 is available (you have N)"; Download shows taskbar progress; Restart now closes, installs, restarts; Help › About says N+1; the log shows no request to any other host. Toggle the checkbox, restart, confirm `updates.json` says `"auto": false` and no start check runs (log).
- [ ] **Step 5:** Repeat Step 4's first check with no feed override and no network-blocking: expect "You have the newest version" (no release published yet → 404 → up to date).
- [ ] **Step 6:** Uninstall the test install. Record results in the PR / hand-over note.

---

**Self-review notes:** every spec section maps to a task (channels/publish → 1; settings, once-a-day, texts, hosts → 2; dialogs, download, progress, Later → 3; install order, window-all-closed, self-test, env vars, header → 4; descriptions/resolver rules → 5; F1 About with version details and Check for updates → 6; CI draft, repo guard, version check, dotted names → 7; docs → 8; built-program proof → 9). One deviation from the spec, decided here: the .deb fallback (open the release page) happens *before* quitting when `pkexec` is missing, because a failure after quit cannot be shown.
