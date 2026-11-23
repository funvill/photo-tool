# Handoff: desktop app work, state at end of 2026-11-22

For whoever picks this up next, person or agent. Read this first, then [electron-plan.md](electron-plan.md) for the reasoning and [plan.md](plan.md) for the photo-book work this tool exists to serve.

## In one paragraph

This repo is a fork of [photobook_studio](https://github.com/jkw2lo/photobook_studio) (MIT). In one day it was turned from a Mac-only "run a server, open a browser" tool into an Electron desktop app for Windows and Linux that non-technical users install with a double-click and use with no network. A Windows installer, a `.deb` and an AppImage exist, were built from the current tree, and pass an automated self-test. **It is committed on `main` (four commits after `97460b2`) but not pushed, and there is no GitHub copy. None of the code has been reviewed by a person, and it has not been run on a clean machine, a network-off machine, or a real Linux desktop.**

## The requirements (from Steven)

1. Users cannot start a server. They double-click a program.
2. It works offline, always, including first launch. Nothing is downloaded at install, start or use.
3. One installer carries every dependency.
4. It is for other people, not only Steven.
5. Windows and Linux. The web interface must keep working from the same source.

## State of the working tree

Everything below is committed on `main` in four commits after `97460b2`: portable server with HEIC and PDF rendering; Electron shell and installer build; Linux packaging; docs. The split is by file, and the first commit carries several features because the same files hold them, so the intermediate commits were not built or tested on their own. Nothing is pushed.

Checked by the lead agent after all subagent work landed: `npm run typecheck` is clean and `npm test` gives **441 passed, 2 skipped, 0 failed**. The two skips are a 500-photo scale test that needs extra fixtures and one folder test that only runs off Windows.

| Piece | Where | State |
|---|---|---|
| Portable server | `src/server/resources.ts`, `src/server/folders.ts`, `scripts/collect-resources.ts`, edits across `src/server/` | Done, verified on Windows. No `import.meta.url`; resources found through one module; drive letters ("This PC") and UNC paths in the folder browser; `npm start` works on Windows. |
| Electron shell | `electron/` (`main.ts`, `preload.ts`, `server-host.ts`, `netGuard.ts`, `config.ts`, `selfTest.ts`, `product.json`, `installer.nsh`) | Done, verified on Windows and in Linux containers. Server in a utility process on a free `127.0.0.1` port; error dialog and log if it fails to start; network defaults off; Help → About. |
| Build and packaging | `scripts/desktop/`, `electron-builder.config.cjs`, scripts in `package.json` | Done. `npm run dev:desktop`, `npm run desktop:build`, `npm run start:desktop`, `npm run dist`, `npm run dist:dir`. |
| Windows installer | `dist/installer/Photobook Studio Setup 0.1.0.exe`, 133 MB, unsigned, built 18:54 | **Current and verified.** See below. |
| Linux packages | `dist/installer/photobook-studio-0.1.0-amd64.deb` (137 MB), `...-x86_64.AppImage` (151 MB), built 18:04 | **Current and verified in containers only.** See "Linux". |
| HEIC import, image export, flipbook off macOS | `src/server/heic.ts`, `src/server/pdfRaster.ts`, edits to `media.ts`, `shelf.ts`, `imageExport.ts`, `flipbook.ts` | Done, verified on Windows and in Linux containers. Not tried with a real iPhone photo. |
| Third-party notices | `scripts/make-notices.ts`, generated into the packaged resources by `collect-resources` | Done; 135 packages. **Six licence texts are missing** and must be added by hand. See "Licences". |
| End-to-end tests | `playwright.config.ts` | Now run on Windows. Both milestone tests pass. The 500-photo drag performance test failed (11.8 ms per step against a limit of 8) on a busy PC; not known to be a real regression. |
| README and docs | `README.md`, `docs/WEB_VERSION.md` | Corrected; desktop section added. |
| CI | `.github/workflows/test.yml` (matrix), `.github/workflows/desktop.yml` (installers and self-tests) | **Written, never run.** There is no GitHub copy of this fork. |

## What "verified" means here

The app has a built-in self-test:

```
"Photobook Studio.exe" --self-test <photo folder> --self-test-out <folder>
```

It creates a book, imports the folder, drafts, exports the PDF, imports HEIC photos, exports images and a flipbook, loads the home page and the editor in the real window, takes screenshots, checks the About text and licence files, checks the network filter and the navigation block, writes `result.json`, and exits 0 or 1. It keeps its data inside the output folder, so it does not touch a real user's books.

**Windows, on Steven's PC, with the 18:54 installer** (run by the lead agent):

- Silent per-user install (`/S /D=<folder>`) from a non-elevated shell: exit 0.
- Self-test from the installed copy with Node off the `PATH` and 12 photos: exit 0, all 18 checks true.
- Silent uninstall: install folder, Start-menu shortcut, Desktop shortcut and the installer's leftover cache all gone. `%APPDATA%\Photobook Studio` did not exist before or after.

Earlier the same day, on an older build: every request in a net log went to `127.0.0.1`, and the failure paths (missing resources, missing sharp binary, unwritable data folder) gave a dialog and a log file. **Not repeated on the final build.**

**Not verified anywhere:**

- A clean machine, or any machine with networking actually switched off.
- A person clicking through the installed app: the native folder dialog, "Open" and "Show in folder" on exports, Help → About and its notices button.
- A first launch into the real `%APPDATA%\Photobook Studio` folder.
- A full-size book in the desktop app. The largest run inside Electron is 100 photos (Linux); 403 photos was only run through the server before Electron existed.
- A net log on the final Windows build. A DNS lookup the first audit missed was found later on Linux (see "Things that will bite"); the fix is in the final build but its effect on Windows is inferred, not measured.
- macOS, after all these changes. The Mac paths were kept but not run.

## Linux

Built and tested by a subagent; the lead agent checked that the packages exist and that the tests pass on Windows, but did not rerun the container tests. Evidence is in `%TEMP%\photobook-linux\test\<name>\` (`test.log`, `result.json`, screenshots); build logs are `%TEMP%\photobook-linux-build*.log`.

**How to build and test**

- `node scripts/desktop/linux/docker-build.mjs` builds both packages in a `node:24-bookworm` container from a snapshot of the tree.
- `node scripts/desktop/linux/docker-test.mjs` installs and self-tests them in containers started with `--network none`. Read the header comments of both for options (`--userns`, `--suid`, `--fuse`, `--only`, `--mode`).

**Results, all with no network**

| Distro | Package | Result | What it needed |
|---|---|---|---|
| Ubuntu 24.04, Ubuntu 22.04, Debian 12 | `.deb` | Installs with `dpkg -i`, self-test passes | Nothing; Chromium's sandbox on |
| Those three and Fedora | AppImage, mounting itself | Passes | The FUSE device; only fuse3 present, no `libfuse2` |
| Those three and Fedora | AppImage, no FUSE device | Passes | `APPIMAGE_EXTRACT_AND_RUN=1` |
| Ubuntu 24.04 | `.deb` in an ordinary container | Fails, exit 133 | Passes with `--no-sandbox`. Expected in a container; says nothing about a real desktop |

"Sandbox on" needed the container to be allowed user namespaces (`--userns`, which turns Docker's seccomp filter off).

**Defects found and fixed**

1. **sharp leaks memory inside Electron on Linux.** sharp's bundled glib and the system glib that Electron loads get crossed, so image memory is never freed. Measured on Ubuntu 24.04 with 100 photos:

   | Build of sharp | Server peak memory | Import | PDF export |
   |---|---|---|---|
   | Native, unpatched | 5,600 MB | 32 s | 28 s |
   | WebAssembly | 785 MB | 242 s | 64 s |
   | Native with shim (the default) | 449 to 480 MB | 34 to 35 s | 37 to 42 s |

   The shim (`scripts/desktop/linux/sharp-glib-shim.c`, applied by `patch-sharp.mjs`) binary-patches the packaged copy of sharp's `.node` file so its glib calls reach the copy inside libvips. It needs gcc and patchelf on the build machine, and the build stops if a future sharp calls a glib function the shim does not cover. `PHOTOBOOK_LINUX_SHARP=wasm` or `native` selects the others.
2. **A space in the install path kills the app** where Chromium falls back to its setuid sandbox. Linux now installs to `/opt/photobook-studio`; the menu name is still "Photobook Studio".
3. **The `.deb` did not build as configured** (no homepage), and its dependency list was wrong in both directions. Dependencies are now explicit. `electron/product.json` gained `"repository": "github:jkw2lo/photobook_studio"`, which points at upstream and is a placeholder.
4. **The default AppImage runtime needs `libfuse2`,** which current Ubuntu does not install. The AppImage now uses electron-builder's static runtime (1.0.3, marked beta), which mounts with fuse3. `PHOTOBOOK_APPIMAGE_TOOLSET=0.0.0` builds the old way.

**Still unknown**

- **A real Ubuntu 24.04 desktop.** The `.deb` installs an AppArmor profile so the sandbox can start; that script has never run. The AppImage launcher appears to fall back to no sandbox if user namespaces are blocked; untested.
- **A real double-click** in a file manager, Wayland, the launcher icon, the default data folder `~/.config/Photobook Studio`, and "Open" / "Show in folder".
- **A real Fedora desktop** with SELinux.

**What to hand to users, as far as is known:** the `.deb` for Ubuntu and Debian (double-click, enter password). The AppImage for everything else; the user must mark it executable by hand first.

**Left in Docker, safe to delete:** images `photobook-linux-build` (1.1 GB), `photobook-test-ubuntu-24.04` (1.4 GB), `photobook-test-ubuntu-22.04` (1.2 GB), `photobook-test-debian-12` (1.8 GB), `photobook-test-fedora` (5.4 GB), the pulled base images, and the volume `photobook-linux-cache`. A copy of the Linux packages is also in `%LOCALAPPDATA%\Temp\pb-linux-pkgs-backup`.

## Licences

The generated notices file covers 135 packages. Before giving the app to anyone:

- **Missing texts,** listed by the script as "needs adding by hand". Drop each into `scripts/notices/<name>.txt` (the folder does not exist yet) and it is picked up:
  - `pdfium.txt`: the npm wrapper ships only its own MIT text. PDFium is BSD-3-Clause and Apache-2.0 with FreeType, ICU, OpenJPEG, libjpeg-turbo, Little CMS, zlib and others inside.
  - `sharp-libvips.txt`: the package gives a table of component names but not their licence texts (cairo, FreeType, libpng, libtiff, IJG and the rest).
  - `brotli`, `dfa`, `fontkit`, `splaytree`: declared MIT, no licence file in the package.
- **LGPL-3.0 code:** libvips, glib, pango, librsvg and others inside sharp; libheif and libde265 in the HEIC decoder. Each is a separate replaceable file and the notices point at upstream source. Whether a pointer satisfies the LGPL's source-offer duty is for Steven to decide.
- **cairo** is MPL 1.1, which also has a source-availability term.
- **On Linux the build modifies sharp's Apache-2.0 binding** (the shim). The notices say so when generated on Linux.
- **HEVC patents:** see decision 1 below.
- **Fonts:** 19 are OFL 1.1 and one is Apache 2.0. None restricts redistribution with software.

## Next steps, in order

1. **Read the diff.** Roughly 4,000 added lines were written by subagents. The lead checked reports, tests and built artefacts, not the code. The riskiest pieces to read first: `scripts/desktop/linux/patch-sharp.mjs` and `sharp-glib-shim.c` (binary patching), `electron/main.ts` (security settings), `src/server/heic.ts` (worker pool).
2. **Committed 2026-11-22** in four pieces (see above). Agent commits are authored as `SWS-Chipkin <sws-dev@chipkin.com>` per the global instructions.
3. **Click through the installed app by hand** on Windows.
4. **Test on a clean, network-off Windows.** Windows Sandbox is the easy route but the feature is disabled on this PC; enabling it needs an administrator (`Enable-WindowsOptionalFeature -FeatureName "Containers-DisposableClientVM" -All -Online`) and maybe a restart. Then a `.wsb` file with `<Networking>Disable</Networking>` and the installer folder mapped read-only. Hyper-V is already enabled as an alternative. Take a net log (`--log-net-log`) while there.
5. **Test on a real Ubuntu 24.04 desktop** in a VM: double-click the `.deb`, launch from the menu, confirm the sandbox starts.
6. **Test with real iPhone photos:** a portrait one, an HDR one, a Portrait-mode one and a 48 MP one. Check rotation, colour and that the date is read.
7. **Add the six missing licence texts.**
8. **Push to a GitHub repository** so the two CI workflows run for the first time.
9. **Run a full 400 to 800 photo book** through the installed app, and rerun the drag performance test on a quiet machine.

## Decisions waiting on Steven

1. **Ship a HEIC decoder?** It is `libheif-js`, LGPL-3.0, kept as a separate replaceable file. Separately, HEIC uses HEVC compression, which patent pools claim royalties on for anyone distributing a decoder. This is a legal question nobody here can answer. Leaving it out means telling users to convert iPhone photos to JPEG first.
2. **Sign the Windows installer?** Unsigned, every new version shows "Windows protected your PC", and PCs with Smart App Control block it outright. Microsoft's Artifact Signing is listed from US$9.99 a month and needs an Azure subscription and identity validation.
3. **The name.** "Photobook Studio" is upstream's name. It, the app ID, the `.deb` maintainer and the repository are placeholders in `electron/product.json`, the only place they are defined. Awkward to change after people have installed it.
4. **Who the users are** (family, colleagues, the public), which sets how much polish and help text is needed.
5. **Which Linux distributions** have to work.
6. **Keep or delete `spike/`.** 972 MB, ignored by git. Its findings are in `spike/electron/RESULTS.md` and summarised in the plan.

## Things that will bite

- **`npm run dev` and `npm run dev:desktop` share ports 5173/5174 and `./data`.** Run one or the other. A dev server was still running on 5174 at the end of this work.
- **Do not interrupt `npm run dist`.** It replaces the installer early and leaves a 231 KB stub with the real installer's name if stopped. This happened once today.
- **Chromium does DNS lookups the request filter never sees.** With the spell-checker off, every start still sent a DNS query for a Google host (seen with `strace` on Linux). `electron/main.ts` now sets `host-resolver-rules` so only `127.0.0.1` and `localhost` resolve. Keep that switch.
- **Chromium also asks the OS for a route to a Google IPv6 address** three times per run as a connectivity check. It is believed to send no packet; this was not confirmed with a packet capture.
- **`npm install` does not download Electron's program** in version 45. `scripts/desktop/ensure-electron.mjs` does it; the desktop scripts call it.
- **Build machines need the network; the built app must not.** electron-builder fetches its own tools on first use.
- **Each platform's packages must be built on that platform** (or in the Linux container), because sharp ships a different binary for each.
- **sharp keeps files open on Windows** unless `sharp.cache({ files: 0 })` is set, which `src/server/media.ts` now does on Windows. Without it users cannot move or delete their photos while the app runs.
- **PDFium and libheif are loaded from the resource folder at run time,** not bundled. `electron/server-host.ts` checks they are present at start. `collect-resources` writes a small `package.json` beside libheif so it loads as CommonJS.
- **The "no remote URLs" test** (`tests/core.test.ts`) scans `electron/`, `scripts/desktop/` and the builder config as well as `src/`. Any `https://` string there fails it. That is deliberate, and is why `product.json` uses `github:owner/name`.
- **A packaged self-test fails if `LICENSE.txt` or the notices file is missing.** Also deliberate.
- **The book-making work in [plan.md](plan.md) has not moved.** The Blurb Large Square preset is still wrong in the app (12 in trim, should be 11.75), the cover size is wrong for Blurb, and Steven's templates are not in. The desktop app ships the same generic layouts upstream has.

## Where things are

| Path | What |
|---|---|
| `docs/electron-plan.md` | The desktop plan, with the spike and audit results |
| `docs/plan.md`, `docs/research.md` | The photo-book plan and its evidence |
| `electron/` | The desktop shell |
| `scripts/desktop/` | Build scripts; `linux/` holds the Docker build and test |
| `electron-builder.config.cjs` | Installer configuration for all three package types |
| `dist/installer/` | Built packages. Not in git. |
| `spike/electron/` | The throwaway spike and its report. Not in git. |
| `photos/2023/`, `data/`, `trial-output/` | Steven's photos, the dev database, trial PDFs. Not in git. Private. |
