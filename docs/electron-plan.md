# Desktop app plan: Electron on Windows and Linux, alongside the web interface

Written 2026-11-22, revised the same day after Steven set the requirements below. Status at the end of that day: phases 0 to 3 and 5 are built; the Windows installer, the `.deb` and the AppImage are all built from the final tree and pass the app's self-test (Windows on this PC, Linux in containers with no network). It is committed on `main` but not pushed, the code is unreviewed, and no clean machine, network-off machine or real Linux desktop has been tried, so phase 4 is still open. **The exact state of every piece, and the next steps in order, are in [handoff.md](handoff.md).** Items marked **unverified** are assumptions still to test.

## Requirements (from Steven, 2026-11-22)

These override anything further down that disagrees.

1. **Users cannot start a server.** The people using this know how to double-click a program and nothing more. No terminal, no Node, no "open this address in your browser".
2. **It works offline, always.** On an aeroplane, with no network, from first launch. Nothing is downloaded when installing, starting or using it.
3. **One installer carries everything.** Every dependency is inside it.
4. **It is for other people, not just Steven.** ("Our users.")

What follows from them:

- The desktop app is the product. The web interface is kept for development and as the static web version, but is no longer how anyone is expected to use the tool.
- The local server still exists inside the app, because that is how the editor talks to its data, but the user never sees it: it starts and stops with the window, picks its own port, and a failure to start shows as a message in a window, not a blank page.
- No feature may depend on the network. That rules out OpenStreetMap lookups for place names (plan.md open question 6): place names come from data shipped in the app or are typed.
- Electron's own network habits (spell-check dictionary downloads, update checks, crash reports) are switched off. **Unverified** list; an audit is running.
- No automatic updates. A new version is a new installer.
- HEIC import stops being optional. Photos straight off an iPhone are HEIC, and today they only import on a Mac.
- Unsigned Windows installers show a "Windows protected your PC" warning that a non-technical user will read as "do not install". Signing costs money and is Steven's decision; see open questions.
- "Works on my PC" is not the test. The test is a clean machine with networking switched off.

## Phase 0 result (2026-11-22)

The spike ran on Steven's Windows PC; the full report and evidence are in `spike/electron/RESULTS.md` and `spike/electron/evidence/`. It used Electron 45.4.1 (Node 24.22.3), electron-builder 26.18.0 and sharp 0.35.5, with 20 photos.

- **It works.** The existing server ran inside Electron both unpackaged and as an unpacked Windows package, in the main process and in a utility process: import, draft, PDF export, and the editor loading in a window with no console errors. A packaged copy run from outside the repo, and with Node off the `PATH`, also passed.
- **`node:sqlite` works with no flag.** No database swap is needed.
- **`sharp` works packaged** as long as its native part stays outside `app.asar`. electron-builder does that by default; set `asarUnpack` explicitly anyway. If sharp fails to load, the whole server fails to start, so the shell needs to show a failed start.
- **Fonts and other files need real work.** `import.meta.url` is empty in a bundled build and the server crashes on load, and `src/core/fonts.ts:84` hard-codes a `node_modules/@fontsource/...` path. The spike worked around both; phase 1 has to fix them properly. Passing a `resourceRoot` into `createApp` is not enough on its own, because `pdf.ts`, `textOutline.ts` and `places.ts` fix their paths when they load.
- **Files that must ship in the package:** the Latin `.woff` fonts (11 MB), `world-atlas` (3.5 MB) and the built editor (30 MB).
- **Size:** 452 MB unpacked, about 360 MB of it the Electron runtime. No installer was built.
- **Also found:** `npm install` no longer downloads Electron's binary in version 45 (run its `install.js`); pdfkit and fontkit were kept out of the bundle as a precaution, untested.

Not tested: a clean PC, an installer, Linux, the full 403-photo book, and whether a long export in the main process really freezes the window (at 20 photos the difference was negligible).

## Offline and installer audit (2026-11-22)

A read-only audit by a subagent; sources and detail are in its report, summarised here. "Observed" means seen on this PC, "documented" means read in vendor documentation, "reported" means second-hand.

**The app itself**

- **No outbound network code.** The server binds to `127.0.0.1` only and the editor only calls its own origin. Fonts and map outlines are bundled. Observed: a packaged spike run logged 219 requests, all to `127.0.0.1`. That run was online with a used profile, so it is not yet proof of a clean offline first launch.
- **The existing guard test** (`tests/core.test.ts`) scans `src/` for external URLs. It does not cover the built editor, a future `electron/` folder, or Chromium's own traffic.

**What the Electron shell must do**

1. Turn the spell-checker off. Documented: on Windows and Linux it downloads dictionaries from a Google server. **Corrected later the same day:** this is not enough. With it off, Chromium still sent a DNS lookup for a Google host on every start (seen on Linux), and the app's request filter never sees DNS. The shell now also sets `host-resolver-rules` so only `127.0.0.1` and `localhost` resolve.
2. Deny all permission requests, block navigation away from the app's own address, and deny new windows. The export dialog's "Open" links (`ExportDialog.tsx`) need routing to "show in folder".
3. Never start the crash reporter or include an updater.
4. Use a direct proxy mode, which stops a harmless but pointless proxy auto-detect lookup, and cancel any request to a host other than `127.0.0.1`.
5. Keep loading the editor over `http://127.0.0.1:<port>` so the existing Content-Security-Policy still applies.
6. Use the plain `nsis` installer target, per-user and one-click (documented default: no administrator prompt). Never `nsis-web`, which downloads at install time.

**Installer self-sufficiency**

- **Windows:** observed that sharp's binaries need only DLLs that ship with Windows 10 and 11; no Visual C++ runtime to install.
- **Linux `.deb`:** depends on common desktop libraries that are normally present. Treat it as the main format for Ubuntu and Debian.
- **Linux AppImage is not reliably double-click.** Documented: the default runtime needs `libfuse2`, which current Ubuntu does not install. Reported: Ubuntu 24.04 also blocks Chromium's sandbox in AppImages. **Since tested:** electron-builder's static runtime (a beta) runs with only fuse3 and is now the default. The user still has to mark the file executable.
- **sharp on Linux:** needs glibc 2.28 or newer. Its documentation warns of a library clash with Electron on Linux. **Since tested:** the clash is real and serious, and is fixed in packaging; see the phase 3 (Linux) row.

**Unsigned Windows installers**

- Documented by Microsoft: an unsigned installer shows "Windows protected your PC" on every new version, and on PCs with Smart App Control turned on it is blocked with no way round.
- Signing options: Microsoft's Artifact Signing is listed from US$9.99 a month and needs an Azure subscription and identity validation (organisations in Canada are eligible). Certificates from a certificate authority cost more; prices not checked.

**Where to test on this PC**

- **Windows, clean and offline:** Windows Sandbox with `<Networking>Disable</Networking>` is the best fit, but the feature is turned off on this PC and enabling it needs an administrator and possibly a restart. Hyper-V is already on and would allow a VM with no network adapter and a standard user.
- **Linux:** WSL has Ubuntu 22.04 with a working display, and Docker can run clean Ubuntu, Debian or Fedora with `--network none`. Neither reproduces the Ubuntu 24.04 desktop faithfully; only a VM does.

## Aim

One codebase, three ways to run it:

| Way | Today | After this plan |
|---|---|---|
| **Desktop app** | Does not exist (upstream has a Mac-only AppleScript launcher) | An installed Electron app on Windows and Linux: double-click, no terminal, no Node install |
| **Local web interface** | `npm run dev`, then a browser at `http://127.0.0.1:5173` | Unchanged, and `npm start` fixed so it works on Windows |
| **Static web version** | `npm run build:pages`, backend runs in the browser | Unchanged, still built in CI |

"Web interface" is read here as both of the last two rows. If only one matters, the other costs nothing to keep because neither is touched.

## Not goals

- A macOS build. Nothing will be done to break running from source on a Mac, but no Mac app is packaged or tested.
- Auto-update or store distribution.
- Rewriting the server's HTTP API as Electron IPC.
- Tauri, which upstream's architecture notes suggest. It needs a Rust toolchain and a second language for no gain here.

## What would make it a failure

- The desktop app and the web interface drift into two code paths that have to be fixed separately.
- A book made in one cannot be opened in the other.
- The installed app works on the build machine but not on a clean PC, because a native module or a font was left out of the package.

## Approach

Three were considered.

1. **Electron as a thin shell around the existing local server.** Electron starts the same Express server the web interface uses, on a free port on `127.0.0.1`, and shows it in a window. The React code and the API stay exactly as they are.
2. **Replace HTTP with Electron IPC.** Removes the local port, but every one of the server's routes needs a second transport, and the desktop app and web interface stop sharing a path. Fails the first failure test above.
3. **Wrap the static web version** (browser backend, IndexedDB) in Electron. Almost no work, but it loses real file paths and the SQLite catalogue, and import and export run slower in the page.

**Chosen: 1.** The server is already built as `createApp(dataDir, opts)` returning an Express app, already binds to `127.0.0.1` only, and already serves the built editor from a static folder in production mode. The shell is small; most of the work is making the server portable and packageable.

## How it fits together

```
Electron main process
 ├─ picks data folder (per-user app data, or PHOTOBOOK_DATA_DIR)
 ├─ starts the server in a utility process ──► createApp(dataDir, { staticDir, resourceRoot })
 │                                              listening on 127.0.0.1:<free port>
 ├─ opens a window at http://127.0.0.1:<port>   (same React build as the web interface)
 └─ preload script exposes a few native extras: folder picker, "show in folder", relaunch
```

- **Server in a utility process, not the main process.** PDF export is minutes of CPU-bound JavaScript (184 s for the 2023 trial); in the main process it would freeze the window.
- **The page stays a normal web page:** context isolation on, Node integration off. The preload exposes a handful of functions, and the editor checks for them (`window.desktop?.pickFolder`) so the same build runs in a plain browser.
- **Same data format in both.** The desktop app and `npm run dev` can point at the same data folder, though not at the same time: both write the SQLite file.

## What stands in the way

Found by reading the code on 2026-11-22.

| Problem | Where | Fix |
|---|---|---|
| Server runs as TypeScript through `tsx`; nothing compiles it | `package.json` scripts | Bundle the server and the Electron main and preload files to JavaScript with esbuild, leaving `sharp` external |
| Code finds fonts and other files by walking up from its own source file | `ROOT` in `src/server/main.ts`, `pdf.ts`, `textOutline.ts`; `createRequire` in `places.ts` | Pass one `resourceRoot` into `createApp`; in the packaged app it points at the unpacked resources |
| Database is Node's built-in `node:sqlite` | `src/server/db.ts` | **Unverified** that the Electron version chosen ships a Node new enough to have it without a flag. If not, swap to `better-sqlite3` behind the existing `Store` class |
| `sharp` is a native module | import, thumbnails, export | Unpack it from the app archive (`asarUnpack`) and build each platform's installer on that platform so the right binary is included |
| Home folder and `~` handling assume Unix | `process.env.HOME` in `app.ts` lines 300 to 312 and `importer.ts` line 53 | `os.homedir()`; accept `~\`; the folder browser lists drive letters at the top level on Windows |
| `npm start` uses `NODE_ENV=production tsx ...` | `package.json` | A small Node start script, or `cross-env` |
| "Restart" runs a bash script | `src/server/main.ts` | In Electron, `app.relaunch()`; in web mode on Windows, hide the button (`canRestart: false`) |
| Data folder defaults to `./data` beside the code | `src/server/main.ts` | Electron passes its per-user data folder; `PHOTOBOOK_DATA_DIR` still overrides |
| HEIC import, PNG/JPEG image export and the flipbook call macOS `sips` | `media.ts`, `imageExport.ts`, `flipbook.ts` | See phase 4. They already fail with a clear message off macOS, so they can wait |
| Tests and CI only run on macOS | `.github/workflows/test.yml`; two tests fail on Windows today | Fix the two tests; run CI on Windows and Ubuntu |

## Build order

Each phase ends with something that runs.

| Phase | Delivers | Proves |
|---|---|---|
| 0. Spike. **Done.** | A throwaway Electron app on this PC running the server, unpackaged and packaged. | `node:sqlite` and `sharp` work inside Electron; fonts need real fixes. |
| 1. Portable server. **Done 2026-11-22.** | Resource paths that survive bundling (`src/server/resources.ts`, `scripts/collect-resources.ts`), home folder and drive letters on Windows (`src/server/folders.ts`), `npm start` on Windows, restart, the two failing tests, CI matrix for Windows and Ubuntu. | Checked on Windows: type check clean, 410 tests pass and 4 skip, and a bundled server run from outside the repo imports, drafts and exports with no workarounds. Linux and macOS are unverified; the CI matrix has never run. |
| 2 and 3 (Windows). **Done 2026-11-22.** | `electron/`, `electron-builder.config.cjs`, `scripts/desktop/`. Installer: `dist/installer/Photobook Studio Setup 0.1.0.exe`, 133 MB, unsigned, rebuilt 18:54 with everything below in it. Run with `npm run dev:desktop`; package with `npm run dist`. | Checked on this PC on the final build: 441 tests pass; the self-test (import, draft, PDF export, HEIC, image export, flipbook, editor loads, About and licence files, network filter) passes all 18 checks from a silent per-user install with no administrator prompt and Node off the `PATH`; uninstall leaves nothing behind. An earlier build's net log showed every request going to `127.0.0.1`; not repeated on the final build. Not yet run on a clean or network-off machine, and nobody has clicked through it by hand. |
| 2. Electron shell (as planned) | `electron/main.ts`, `electron/preload.ts`. Server in a utility process on a free port. Single-instance lock, remembered window size, native folder picker, "show export in folder", a visible error if the server fails to start, Electron's network features off, links open in the system browser. `npm run dev:desktop` for development. | Use without a terminal or a browser tab. |
| 3. Installer | `npm run dist` using electron-builder. Windows: per-user NSIS installer, x64, no administrator rights. Linux: AppImage and `.deb`, x64. Each built on its own platform by CI. | One file, double-click, everything inside. |
| 4. Offline acceptance test | Install on a clean Windows system and a clean Linux system with networking off; create a book, import, draft, export. Automated where the PC allows it. A check that the running app opens no outbound connections. | Requirements 1 to 3, on a machine that is not the build machine. |
| 5. HEIC and the Mac-only features | HEIC import, image export and flipbook on Windows and Linux. PDF pages rendered with `pdfjs-dist` (already a dependency); HEIC decoded with a bundled WebAssembly libheif (**unverified** choice). | iPhone photos import. |
| 5 result. **Built 2026-11-22; Windows only verified.** | HEIC decoded by `libheif-js` (WebAssembly, LGPL-3.0) into a JPEG copy; PDF pages rendered by PDFium as WebAssembly (`@hyzyla/pdfium`). Both are plain files under the resource folder, +7.7 MB installed. macOS still uses `sips`. | From source and from a packaged build with no Node: HEIC import, PNG/JPEG export and flipbook all pass. Measured about 0.3 s per 12 MP HEIC in a batch and under 0.5 s per 12×12 page at 300 DPI. **Not tested with a real iPhone photo** (rotation, HDR, Portrait mode, colour), nor on Linux or macOS. **Open for Steven:** the LGPL credit, and HEVC patent exposure from shipping a decoder. |
| 3 (Linux). **Built 2026-11-22.** | `scripts/desktop/linux/` builds the `.deb` (137 MB) and AppImage (151 MB) in Docker and tests them in containers with no network. Linux installs to `/opt/photobook-studio`; the AppImage uses the static runtime, so it needs no `libfuse2`. | The self-test passed for the `.deb` on Ubuntu 24.04, Ubuntu 22.04 and Debian 12 with Chromium's sandbox on, and for the AppImage on those and Fedora. Four defects were found and fixed, the worst being sharp leaking memory inside Electron on Linux: 5,600 MB after 100 photos unpatched, about 450 MB with the shim that is now the default. Detail and the measurements are in handoff.md. No real desktop has been tried. |
| Loose ends. **Done 2026-11-22.** | Help → About; a generated third-party notices file (135 packages, six licence texts missing); self-test keeps its data in its own folder; "This PC" drive list; end-to-end tests run on Windows; README corrected. | Tests pass. The About dialog has not been seen in a real window. A 500-photo drag performance test failed once on a busy PC. |
| 6. Release checks | A Playwright test that drives the packaged app end to end on both CI runners, run on every release. | Each release is checked as an installed app. |
| 7. Signing and updates | Only if Steven decides to pay for a certificate: signed Windows installer. Updates stay manual. | No scary warning on install. |

Left over from phase 1, to pick up later: the end-to-end test config (`playwright.config.ts`) still uses Unix-only commands, so `npm run test:e2e` does not run on Windows; on Windows the folder browser's top level is a list of drives shown as `/`; the README still says restart works with `npm start`, which is now true on a Mac only.

Phases 1 to 4 are the conversion. Phase 5 is needed before handing the app to anyone with an iPhone.

## Calls made here that Steven has not confirmed

- **x64 only.** No ARM builds for Windows or Linux.
- **Unsigned installers until Steven decides otherwise.** See the requirements section for what users will see.
- **No auto-update,** because it needs the network and requirement 2 says nothing may.
- **Per-user install on Windows,** so no administrator password is needed.
- **Per-user data folder** for the desktop app (`%APPDATA%\Photobook Studio` on Windows, `~/.config/Photobook Studio` on Linux) instead of `./data` in the repo. The existing 2023 trial book in `./data` would be copied across once.
- **electron-builder** over Electron Forge: one config block produces all three installer types.
- **Local port stays.** Any program on the PC can reach the API while the app is open, as it can today with `npm run dev`. A per-launch secret in a header would close that; it is left out unless wanted.

## How this sits with the main plan

[plan.md](plan.md) is about making the book: Blurb profile, Steven's templates, captions, cover. This is a separate track about how the tool is started. Phase 1 here overlaps with plan.md's "first small job in the fork" (the two failing Windows tests) and should be done once, first. After that the two tracks touch different files (`electron/`, build config and server start-up here; `src/core` templates and styles there) and can go in either order.

## Open questions for Steven

0. **Ship a HEIC decoder?** It is LGPL-3.0 in an MIT app, and HEIC's compression is patent-encumbered. See handoff.md.
1. **Which Linux?** A distribution and version your users run. That decides whether AppImage alone is enough.
2. **Pay for Windows code signing?** Without it every user sees a warning and has to click "More info", then "Run anyway". Cost and options are being checked.
3. **What is the app called?** It is "Photobook Studio" upstream. The name goes on the installer, the Start menu and the data folder, and is awkward to change after people have installed it.
4. **Who are "our users"?** Family, Chipkin colleagues, or the public. That decides how much polish the installer, error messages and help need, and whether the MIT-licensed upstream name and credits need a visible "About" page.
