# Handoff: desktop app work, state at end of 2026-11-22 (gallery added 2026-11-23)

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
| Stars and photoinfo.json | `src/photoinfo/`, `src/server/photoInfoIndex.ts`, `src/server/app.ts`, `src/web/store.ts` | Done on branch `editor-photoinfo`, not merged. A per-folder `photoinfo.json` (star, people, date, location, description, notes; unknown fields kept; read-only folders fall back to `<dataDir>/photoinfo/`). The server overlays it on the library and writes the star on PATCH; the editor polls `/photoinfo-stamp` every 3 s. The web (browser) version ignores it. Design: `docs/superpowers/specs/2026-11-23-gallery-and-photo-info-design.md`. |
| Draft from stars, update in place | `src/core/draftUpdate.ts` (`updateDraft`, `relayPage`), `src/core/draftState.ts` (page fingerprints), `src/web/components/DraftPanel.tsx`, `UpdateSummary.tsx` | Done on the same branch. Auto draft panel: Generate, Update from stars, Rebuild all pages, Another variation; Re-lay this page; unstarred empty frames marked. Hand-edited pages are never re-laid. |
| Drag in from Explorer | `POST /import-paths`, `src/web/` library and frames | Done on the same branch: drop onto a frame, empty space or the library; import ETA, resizable library, hover preview. Desktop and local app only. |
| Photobook Gallery | `src/gallery/`, `src/core/gallery*.ts`, `electron/gallery.ts`, `electron/drag.ts`, `electron/installer.nsh`, `electron/linux/photobook-gallery.desktop` | **Built on branch `gallery`, not merged.** A second program in the same build (`--gallery`): open a folder, virtual grid, star, details, sorts and filters, full-screen viewer, drag files out. See "Photobook Gallery" below. |
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

## Photobook Gallery

Built 2026-11-23 on branch `gallery` (eight tasks, branched from `main` at `27b366c`). **Not merged and not pushed.** Plan: `docs/superpowers/plans/2026-11-23-gallery-program.md`; design: `docs/superpowers/specs/2026-11-23-gallery-and-photo-info-design.md`.

- **One build, two programs.** `"Photobook Studio.exe" --gallery [folder]` starts the gallery with its own name, data folder (`%APPDATA%\Photobook Gallery\data`), Chromium profile, single-instance lock, local server and Windows taskbar id (`app.photobookstudio.gallery`). The editor's **File → Open Gallery** starts it.
- **Stars go to `photoinfo.json`** through `src/photoinfo`, the same as the editor. Read-only folders use the editor's `<dataDir>/photoinfo`, so a star still reaches the editor.
- **Installer.** The Windows installer adds "Photobook Gallery" shortcuts (Start menu and desktop) to the same exe with `--gallery` and removes them on uninstall (`electron/installer.nsh`). The `.deb` installs `/usr/share/applications/photobook-gallery.desktop` (mapped in through `deb.fpm` in `electron-builder.config.cjs`). The AppImage has no second launcher; run it with `--gallery`.
- **Self-test.** `--self-test <photos> --self-test-out <folder> --gallery` opens a copy of the photos (`<out>/photos`), waits for the scan, stars one photo in the viewer with S, checks the star in the copy's `photoinfo.json`, checks the original folder was not touched, and fails on the same rules as the editor's (console errors, failed loads, cancelled or off-host requests, licence files, the server not stopping cleanly).

**Checks only a person can do (none done yet):**

1. **Real drag out** of the grid into Explorer and into the editor: one photo, many photos, a HEIC photo, and a quick flick (press and move at once).
2. **Editor File → Open Gallery** starts the gallery, and a second click brings the open one forward.
3. **The installer's two shortcuts:** "Photobook Studio" and "Photobook Gallery" on the Start menu and the desktop, each opening its own program with its own taskbar button; both gone after uninstall, and both programs' data left in place.
4. **A folder of several thousand photos:** first scan time, scrolling, sorting by Most interesting and Main colour, and a second opening from the cache.
5. **A read-only folder:** a star set in the gallery shows the read-only badge and reaches the editor (kept in the editor's `photoinfo/` folder).

**Review pane (branch `gallery-review`, built 2026-11-24, branched from `gallery`; not merged, not pushed).** Design: `docs/superpowers/specs/2026-11-23-gallery-review-pane-design.md`. Adds the preview pane and two draggable dividers, review keys (F, H, arrows, Home, End, Enter), hidden photos, stacks, the info sections with camera details and a histogram, the right-click menu, and the Map tab. The gallery now uses the network once: OpenStreetMap tiles, only after the user chooses Load maps (the editor is unchanged and never uses the network). Only Playwright in Chrome and unit tests have run; nobody has used it in the real window.

**More checks only a person can do (none done yet):**

1. **Splitters and badges** in the desktop window: drag both dividers, check the widths survive a restart, and look at the favourite, hidden and "x N" stack badges.
2. **Real-camera details:** open a camera photo and a phone photo; Flash, ISO, lens, aperture and shutter speed match what Explorer's Properties shows. A file with no EXIF says "No camera details in this file".
3. **Histogram** looks right (colours and contrast) in the dark theme, on a dark and a bright photo.
4. **Copy to clipboard** pastes an image into another app (Paint, Word, a chat), for a JPEG and for a HEIC photo.
5. **Copy path to clipboard** works in the desktop app (the page's own clipboard is blocked there; the main process does it), with one photo and with several.
6. **Show in file explorer** opens the folder with the photo selected.
7. **Delete** asks first, sends the photo to the Recycle Bin, and it can be restored from there. After restoring and reopening the folder the gallery is consistent: the photo is back, and nothing odd shows (its old stars and notes were removed with the delete).
8. **A photo from a folder that is no longer open** (open folder A, then B, then act on a photo of A through an old selection or drag) is refused by Delete, Copy and Show.
9. **Map consent:** the prompt shows the first time the Map tab opens. **Not now** shows markers on a plain background and the DevTools network tab (dev build) shows no request. **Load maps** shows tiles and the OpenStreetMap credit; after a restart Map opens online without asking. "Map: online" turns it off again.
10. **Map unavailable offline:** with Wi-Fi off and maps on, the markers still show with "Map unavailable offline" over them.
11. **Markers for real GPS photos** land in the right place; bubbles split when clicked; arrow keys, F and H still work with the map shown, and switching back to Grid scrolls the selection into view.
12. **Proxy check on tile requests** (for example Fiddler or mitmproxy): they carry only Accept and `User-Agent: PhotobookGallery/<version>`, plus Chromium's own Host, Connection and Accept-Encoding. No Referer, Cookie, Sec-CH-UA or Accept-Language. Every other https request is still cancelled in the log, and the editor window is unchanged.
13. **Windows certificate checks** (OCSP/CRL) for the tile connection happen in the OS, outside the app's request filter. They only happen after Load maps. Worth knowing when reading a packet capture.
14. **A selected photo that a filter leaves out:** the preview goes empty while the details still show it. A known small inconsistency; decide if it matters.

**Zoom and editing (branch `gallery-edit`, built 2026-11-24, branched from `gallery-review`; not merged, not pushed).** Design: `docs/superpowers/specs/2026-11-24-gallery-edit-and-zoom-design.md`. Adds wheel zoom, pan and a mini map in the preview, and edit mode (crop, aspect presets, rotate 90°, straighten) with Save, Save as…, Save all and Revert to original, and a Settings dialog (`editTarget`: info file by default, or the photo file). Only unit tests and Playwright in Chrome have run; nobody has used it in the real window. Known limitation: an edit saved in the info file is rendered to a JPEG by the editor, so a transparent PNG loses its transparency there.

**Checks only a person can do for zoom and editing (none done yet):**

15. **Wide-screen fit:** at full screen on a wide monitor the preview and the full-screen viewer fit the photo with no cropping or stretched row.
16. **Wheel zoom feel:** zooms smoothly toward the pointer, 1 to 8 times; drag pans; the mini map (top right) follows, and clicking or dragging it moves the view; double-click resets, and double-click at the whole photo opens full screen.
17. **Sharpness:** zoomed far into a large photo, the full-size picture replaces the blurry one and looks sharp.
18. **Crop handles and straighten feel:** all eight handles and the move drag are easy to grab, each aspect preset and the swap behave, Rotate 90° (and R) turns anticlockwise, and the Straighten slider feels right (double-click resets).
19. **Save in info mode, then the editor:** Save an edit with the default setting, import the photo into the photobook editor and check the crop and rotation are applied. Change the edit in the gallery, Save again and re-sync in the editor: the new edit is applied. The original file is untouched.
20. **Save in photo-file mode:** the edited photo is at the same path, and the original is in the Recycle Bin and can be restored. Repeat with a photo on another drive than the app data.
21. **Save as into the open folder:** the copy appears in the grid, with the star, people, date, location, description and notes copied; the original is unchanged. Repeat saving outside the folder. Type a different extension (for example `.png` for a JPEG) and check the file gets a fitting extension, and that a name that already exists is refused.
22. **Save all with a HEIC in file mode:** the HEIC is skipped with a note, the others are saved. A HEIC can be saved with Save as (a JPEG).
23. **Closing with unsaved edits:** closing the window shows "Close without saving" or "Keep editing"; opening another folder asks too.
24. **A transparent PNG edited in info mode, then imported:** expect the transparency to be lost in the editor (known limitation above).

**Photo score, nudges and undo (branch `gallery-score`, built 2026-11-24, branched from `main`; pushed to `origin`, github.com/funvill/photo-tool, as a backup).** Design: `docs/superpowers/specs/2026-11-24-gallery-photo-score-design.md`. Adds the version in the top bar (bumped once per commit), a photo score per photo (details panel with a hover breakdown, and a badge on each tile; `src/core/photoScore.ts`), Up/Down to nudge it (`scoreAdjust` in photoinfo.json, a green or red toast on the preview), Left/Right only to move, and Ctrl+Z undo (the last 100 changes). The preview and its row now clip what they hold. The scroll bar Steven saw on a portrait photo in a full-screen wide window could not be reproduced in Chrome; only the details panel scrolls there, when it is taller than the window.

**Checks only a person can do for the score (none done yet):**

25. **The scroll bar:** full-screen on the wide monitor, a portrait photo shows no scroll bar on the preview. If one still shows, note which pane it belongs to (the details panel scrolls when its sections are taller than the window).
26. **Does the score rank well?** In a real folder, sort through by score once it can be sorted; check the sharpest, best-exposed shots score high and the blurry or blown ones low, and that the hover breakdown makes sense.
27. **Nudging fast:** hold or tap Up and Down quickly; the toast keeps up, the score lands on the right number, and photoinfo.json has the same `scoreAdjust` after a reload.
28. **Ctrl+Z:** undo a run of hides, stars and nudges; each comes back in reverse order, with a toast; Ctrl+Z while typing in the description only undoes the typing.

**Photo tagging (same branch, `gallery-score`, built 2026-11-24).** Design: `docs/superpowers/specs/2026-11-24-gallery-tagging-and-faces-design.md`; plan: `docs/superpowers/plans/2026-11-24-gallery-tagging.md`; measurements: `docs/superpowers/notes/2026-11-24-tagging-measurements.md`. Settings → Photo tagging downloads Florence-2 (descriptions and objects) and CLIP (keywords and search by meaning) from Hugging Face on request, pinned to a commit and checked by SHA-256 (`src/core/tagModels.ts`, `src/gallery/server/models/`). They run on the CPU in a worker thread with Transformers.js and onnxruntime-node (`src/gallery/server/tagging/`). The gallery tags the open folder in the background, keeps the results by content key in its catalogue, and shows them in **What's in it**, as chip filters and in search (words, then "Also matching by meaning"). Faces are a separate, later plan. What the tests cover: fake models served from memory for the unit and e2e tests (no network); the real models were run in Node from source and from the built `tagging-worker.cjs` on the generated fixtures, and one real download (CLIP base) went through the app's own downloader. Not yet run: tagging inside the packaged Electron app.

**Checks only a person can do for tagging (none done yet):**

29. **Each download for real:** on this PC, download each of the four choices from Settings. The size matches what Settings says, the progress bar moves, Cancel stops it and a second Download carries on from where it stopped. Note the time each takes.
30. **The installed app tags:** build the Windows installer (`npm run dist`), install it, choose both smaller models and open a folder. The bar shows "Tagging … of …" and What's in it fills in. This is the first run of the worker, Transformers.js and the onnxruntime binaries from `app.asar.unpacked` under Electron; if it fails, Settings shows **Not working** and the log says why.
31. **Overnight on a real folder:** a folder of a few thousand photos with both smaller models. The next morning it is done; Pause holds and Resume carries on; closing the gallery and opening the folder again starts where it left off, without looking at a photo twice; the PC stays usable meanwhile (tagging uses half the cores).
32. **Is it any good on real photos?** Read the descriptions, keywords and objects of a few dozen real photos (people, food, buildings, landscapes, documents). The keyword cut-off (0.05) and the search-by-meaning cut-offs (cosine 0.27 for CLIP base, 0.24 for large) were set on generated pictures, not real ones: note searches that find too much or too little. The cut-offs are in `src/core/tagModels.ts`.
33. **Search by meaning finds what you expect:** search for things you know are in the folder by a word no keyword uses ("seaside" for harbour photos, "dinner" for food). Check what shows under "Also matching by meaning", and that the grid stays quick while typing.
34. **Remove frees the space:** after Remove, the model's folder under `%APPDATA%\Photobook Gallery\data\models` is gone, the part is Off, and What's in it says "Tagging is off".

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
- **Photo tagging (branch `gallery-score`):** `@huggingface/transformers` (Apache-2.0) ships with `onnxruntime-node` and `onnxruntime-common` (MIT), and its Node build has `onnxruntime-web`'s code (MIT, which uses `guid-typescript`, ISC) inlined, though the separate `onnxruntime-web` package is left out of the app. These licence texts are not yet in the notices: check the generated file and add `scripts/notices/<name>.txt` for any it reports as missing. The models themselves are downloaded by the user, not shipped: Florence-2 (base and large) and CLIP base declare MIT on Hugging Face; CLIP large declares no licence there (see decision 7).

## Next steps, in order

0. **Check the photoinfo branch by hand.** The self-test and unit tests cover it, but nobody has driven it with a mouse: edit `photoinfo.json` in Notepad and watch the star appear within 3 s, drop a JPEG from Explorer onto a frame, an empty page and the library, and run Update from stars on a real book (the 2023 photos).
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
7. **The larger keywords model's licence.** `Xenova/clip-vit-large-patch14` (and OpenAI's own Hugging Face page for CLIP large) declare no licence. OpenAI released CLIP's code and weights on GitHub under MIT, and Settings shows "MIT" on that basis. Either keep it on that basis, or swap the larger keywords choice for SigLIP 2 (`onnx-community/siglip2-large-patch16-384-ONNX`, Apache-2.0), which needs a small change to the worker and a new measurement download.

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
