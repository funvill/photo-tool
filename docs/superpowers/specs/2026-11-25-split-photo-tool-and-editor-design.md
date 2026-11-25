# Split into two programs: Photo Tool and Photobook Editor

Date: 2026-11-25. Status: draft for Steven's approval.

## Intent

Today one Electron program is two tools: the photobook editor, and — started with `--gallery` — the photo gallery.
One installer puts both on the machine. Steven wants them to be two separate programs in this one repository, each
with its own installer, with the code both use in one shared folder. Right now only the gallery is being worked on,
and the editor should stay out of its way.

The repository started from `jkw2lo/photobook_studio`, but everything since is this fork's own work. Nothing will
be pushed to or pulled from that repository again, so the split also cuts the last ties to it.

## Decided by Steven

- **Two programs, one repository**, with shared code in a folder both use.
- **Names.** The gallery becomes **Photo Tool**. The editor (today "Photobook Studio") becomes **Photobook
  Editor**. (Steven wrote "Photobook editor"; the capital E matching "Photo Tool" is my call.)
- **Three top-level folders:** `photo-tool/`, `photobook-editor/`, `shared/` (approach B below).
- **Separate installers**, one for each program, on Windows and Linux.
- **The GitHub Pages web version is dropped.**
- **Cut from upstream.** No more pushes to or pulls from `jkw2lo/photobook_studio`.
- **`photoinfo.json` files are used by both programs**, as today (stars and other per-photo info written beside
  the photos).

## Goals

1. `photo-tool/` builds, tests, runs and packages as Photo Tool, with no editor code in its bundle or installer.
2. `photobook-editor/` does the same as Photobook Editor, with no gallery code.
3. Anything both use lives in `shared/` and nowhere else. A test fails if `photo-tool/` imports from
   `photobook-editor/` or the other way round, or if `shared/` imports from either.
4. Each program can be built, started and tested on its own with one npm command each.
5. Both programs read and write the same `photoinfo.json` files, and the same fallback folder for read-only
   photo folders.
6. Nothing in the repository still points at `jkw2lo/photobook_studio`.

## Non-goals

- No new features in either program. Behaviour stays the same apart from the names, data folders and the removed
  "Open gallery" link.
- No new work on the editor beyond keeping it building, passing its tests and packaging under its new name.
- No npm workspaces: one `package.json` at the root (approach C below).
- Renaming code identifiers is not a goal. Inside Photo Tool, names like `galleryApi`, `/api/gallery/...`,
  `gallery.css` and `GalleryApp` stay. Only what a person sees (window titles, menus, installer, shortcuts, About,
  page text, README) says "Photo Tool". (My call: renaming every identifier is churn with no change for anyone using
  it. If Steven wants it, it is a later, separate pass.)

## Anti-goals

- A split that loses anyone's books, stars, settings, downloaded tagging models or thumbnails. Existing data must
  carry over (see Data folders).
- A shared folder that turns into "everything": a module goes to `shared/` only because both programs import it.
- Either installer silently including the other program.

## Approaches

The options were laid out in conversation. Steven picked **B**.

- **A. Split inside `src/` and `electron/`.** `src/gallery`, `src/editor`, `src/shared`, plus `electron/` split
  the same way. Fewer moves, same tools. Not chosen.
- **B. Three top-level folders (chosen)**, named `photo-tool/`, `photobook-editor/` and `shared/`. Each program's
  Electron, server, page and test code sit together. This means more moves, and the Vite, Vitest, Playwright and
  packaging paths all change, but the layout says plainly which program owns what.
- **C. npm workspaces**, one package each. Not chosen: native modules (sharp, onnxruntime-node) and
  electron-builder are fussy about workspace layouts, for little gain over an import-boundary test.

## Layout

```
photo-tool/
  electron/        main, preload, server-host, drag/edit/file actions, map tiles, self-test (gallery parts)
  server/          today's src/gallery/server (incl. tagging, models)
  web/             today's src/gallery/web (index.html, main.tsx, components, gallery.css)
  core/            gallery-only modules from src/core (gallerySort, galleryStacks, galleryMap, galleryViewer,
                   galleryEdit, photoScore, tagModels — whichever only Photo Tool imports)
  tests/           its unit tests and e2e specs
  product.json     name, appId, description
  electron-builder.config.cjs
photobook-editor/
  electron/, server/ (today's src/server), web/ (today's src/web), core/ (book modules), tests/,
  product.json, electron-builder.config.cjs, installer.nsh, linux/ ...
shared/
  core/            modules both import (e.g. photoEdit, previewZoom, if both use them)
  photoinfo/       today's src/photoinfo
  server/          media, resources, places, photoEditRender — the server parts both use
  web/             shared page parts (Icon, Modal, HoverPreview, desktop, virtualGrid, eta) and the CSS both
                   pages use (fonts.css and whatever part of styles.css Photo Tool needs)
  electron/        the window, server-host, network guard and config helpers both mains use
  tests/           tests of shared code
scripts/           build scripts, one per program where they differ (desktop build, dev, notices)
docs/, fixtures/   stay at the root
```

**The rule for where a module goes:** if only one program imports it, it goes to that program. If both do, it
goes to `shared/`. This is decided from the import graph, not by guessing. The folder names inside each program
above are a guide; the builder may adjust them, as long as the three top-level folders and the import rule hold.

`src/shared/` (today: desktopApi, flipbookViewer, pdfWriter, places) is sorted by the same rule. Most of it is
editor-only.

**CSS.** Photo Tool's page today imports the editor's `src/web/fonts.css` and `src/web/styles.css`. The parts it
uses move to `shared/web/`, and the rest stays with the editor. Photo Tool must look the same after the split
(the e2e tests plus a side-by-side screenshot check).

## The two programs

| | Photo Tool | Photobook Editor |
|---|---|---|
| Was | Photobook Gallery (`--gallery`) | Photobook Studio |
| Started by | its own executable; a folder may be given as the first argument (today `--gallery <folder>`) | its own executable |
| appId / Windows AppUserModelID | `app.phototool.desktop` | `app.photobookeditor.desktop` |
| Linux package / install folder | `photo-tool` | `photobook-editor` |
| Installer (Windows) | `Photo Tool Setup <version>.exe` | `Photobook Editor Setup <version>.exe` |
| Version | the root `package.json` version, shared by both (one bump per commit, as today) | same |

- The `--gallery` switch and every "which mode am I" branch in `electron/main.ts`, config and preload go away.
  Each program has its own main.
- **"Open gallery" in the editor is removed** (the IPC handler, the preload entry, `desktopApi.openGallery`,
  `galleryLaunchCommand` and the menu or button that used it). My call, put to Steven in conversation: starting the
  other installed program would tie them together again.
- The editor installer's extra Photobook Gallery shortcuts (`installer.nsh`) and the Linux second launcher
  (`photobook-gallery.desktop`) go. Photo Tool's installer makes its own Start-menu and desktop shortcuts.
- **Both programs ship on Linux too (Steven's decision).** Each gets its own `.deb` and AppImage (x64), its own
  `.desktop` launcher and icons, and its own `linux/` folder for that. The Linux build steps that exist today (the
  sharp shim and patchelf, trimming onnxruntime-node to the platform's binaries, the `deb` depends list, the static
  AppImage runtime) apply to Photo Tool. The editor's Linux build drops onnxruntime. CI (`desktop.yml`) builds,
  installs and self-tests both programs' `.deb` and AppImage under xvfb, as it does for the one program today.
  Photo Tool's self-test also checks that its tagging worker and onnxruntime-node load in the installed Linux
  package. That check uses no downloaded model: CI has no network for models.
- Each installer carries only its own program's runtime modules and licence notices. Photo Tool needs sharp,
  onnxruntime-node and Transformers.js. The editor needs sharp and its PDF and font modules, and not onnxruntime.

## Data folders

Today (Windows `%APPDATA%`, with a ` Dev` suffix when not packaged):

- `Photobook Studio\data` — the editor's books and settings, and `photoinfo\` (the fallback for read-only folders).
- `Photobook Gallery\data` — the gallery's catalogue, thumbnails, tagging models and settings.

After the split:

- `Photobook Editor\data`, `Photo Tool\data` (and their `\browser` profiles), named after the new product names
  as `dataLayout` already does.
- **Shared photo-info fallback:** `%APPDATA%\Photo Tools Shared\photoinfo` (my call on the name), used by both
  programs for read-only photo folders. It no longer lives in either program's data folder. Like the other folders,
  it gets the ` Dev` suffix when not packaged (`Photo Tools Shared Dev`). It can be moved with
  `PHOTOINFO_FALLBACK_DIR`, and a self-test keeps it inside its output folder, as today. Tests and Playwright always
  set it, so they never write into a real one. (My call.)
- **Running from source (`./data`).** Today `npm run dev` and the desktop dev script use `./data` for the editor,
  `./data/gallery` for the gallery (nested inside the editor's) and `./data/photoinfo` for the fallback. After the
  split they use `./data/photobook-editor`, `./data/photo-tool` and `./data/photoinfo-shared`. On the first start
  after the split, the dev scripts move the old folders there with the same move-or-refuse rule as below. (My call:
  `./data` holds real working books, stars and models, so it is carried over, never left orphaned.)
- **Carrying data over:** on first start, if a program's new folder does not exist and its old one does, the old
  folder is **renamed** (moved) to the new name. If a rename isn't possible (for example the old program is still
  running and has the folder open), the program says so and quits without starting on an empty folder. The old
  editor's `photoinfo\` moves to the shared fallback folder the same way, from whichever program starts first.
  (My call: a move rather than a copy, so a large tagging-model or thumbnail folder isn't doubled.)
- The environment overrides keep working, renamed per program: `PHOTOBOOK_DATA_DIR` / `PHOTOBOOK_PROFILE_DIR` for
  the editor, and `PHOTO_TOOL_DATA_DIR` / `PHOTO_TOOL_PROFILE_DIR` for Photo Tool, which replace
  `PHOTOBOOK_GALLERY_*`. The tests use these.
- The old installed "Photobook Studio" program is not uninstalled by the new installers (it has a different
  appId). The README says to uninstall it by hand after installing the new ones.

## npm commands

One root `package.json`. Commands are named per program. The final names are the builder's, but there must be one
for each of these:

- Photo Tool: dev (Vite and server with watch), desktop dev, desktop build, start the built desktop app, installer
  (`dist`), installer folder only (`dist:dir`), e2e.
- Photobook Editor: the same, plus the plain `npm start` server.
- `test` runs every unit test (both programs and shared), and `typecheck` checks everything.

Build output goes to per-program folders (e.g. `dist/photo-tool/...`, `dist/photobook-editor/...`) so building one
doesn't overwrite the other.

## Vite, tests, packaging

- Each program gets its own Vite config, and its page is its own `index.html` at its root. This removes today's
  plugin that serves the gallery page as `/gallery.html` from outside the editor's root.
- Vitest stays one config that finds tests in all three folders.
- Playwright gets one project per program, each with its own server and data folder. The Photo Tool project no
  longer needs the editor's build to run first.
- Each program has its own electron-builder config and its own `product.json`. `scripts/desktop/build.mjs` takes
  the program as an argument (or is split in two), and copies only that program's bundles, runtime modules and
  resources (fonts, world-atlas, libheif, PDFium only where that program uses them).
- Existing test files move with the code they test, and their imports change. No test is dropped. The count of
  passing tests after the split equals the count before (998 unit tests and the e2e suites as of v0.1.16), apart
  from tests of the removed "Open gallery" link and the `--gallery` switch, which are replaced by tests of the new
  per-program start-up.

## Cutting from upstream

- Remove the `upstream` git remote.
- `product.json`'s `repository` becomes `github:funvill/photo-tool` (in both programs' `product.json`).
- **The GitHub Pages web version is dropped (Steven's decision).** `.github/workflows/pages.yml` is deleted, and
  so are the `build:pages` and `preview:pages` commands, the README's "Use it in your browser" section and
  `docs/WEB_VERSION.md`. The editor is a desktop program only. Its in-browser backend code (`__BROWSER_BACKEND__`,
  IndexedDB, `--mode pages`) can stay in `photobook-editor/` for now: it is dead code, not a tie to upstream.
  Removing it is a later editor clean-up, not part of this split. (My call, to keep the split about moving, not
  rewriting.)
- The README's other links and wording about `jkw2lo/photobook_studio` are removed or pointed at this repository.
- Comments in the code that refer to upstream are reworded where they would mislead.
- Old design docs in `docs/` stay as they are: they are history.

## README

The README is split into a short root README (what the two programs are, how to build each), plus
`photo-tool/README.md` (today's "Photobook Gallery" section and the gallery-related parts) and
`photobook-editor/README.md` (the rest).

## What's left to the builder

- The exact folder layout inside each program, within the rules above.
- Which modules land in `shared/`, decided by the import rule.
- Command names, and whether `build.mjs` is one parameterised script or two.
- The order of moves. Each step should leave the suite green (e.g. move shared code first, then the editor, then
  Photo Tool, then packaging), committed in small steps with the version bumped on every commit as usual.

## How we'll know it's done

- `typecheck`, all unit tests and both e2e projects pass.
- Both installers build on Windows. Each installs and starts its program, with the right name in the title bar,
  the taskbar, the Start menu and About.
- The `desktop.yml` CI job builds, installs and self-tests both programs' `.deb` and AppImage on Linux, including
  Photo Tool's tagging worker loading there.
- Photo Tool's installed bundle contains no editor code, and the editor's contains no Photo Tool code or
  onnxruntime.
- A machine with old `Photobook Studio Dev` / `Photobook Gallery Dev` folders starts both new programs with its
  books, stars, catalogue and models intact.
- `git grep jkw2lo` finds nothing outside `docs/` history files.
