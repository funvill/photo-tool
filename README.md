# Photo Tool and Photobook Editor

Two local-first desktop programs for your own photos, for Windows and Linux. Photos never leave your computer.

- **[Photo Tool](photo-tool/README.md)**: look through a folder of photos, star, hide, score, edit and tag them, and drag the best ones out. It was called Photobook Gallery.
- **[Photobook Editor](photobook-editor/README.md)**: import a folder of photos, get an automatic first draft of a photobook or poster, refine it, and export a print-ready PDF. It was called Photobook Studio.

The two are installed and run separately. They share each photo's star, date, place, people and notes through a small `photoinfo.json` file beside the photos, so a star set in one shows up in the other within seconds. Each program's README says how to use it.

## Building, running and testing

Requires Node 22.13+ (it uses the built-in `node:sqlite`). Then:

```bash
npm install
```

Each program has its own commands:

| | Photo Tool | Photobook Editor |
| --- | --- | --- |
| Run from source in a browser (Vite with hot reload, and the server) | `npm run dev:photo-tool`, then open http://127.0.0.1:5175 | `npm run dev` (or `npm run dev:editor`), then open http://127.0.0.1:5173 |
| Run from source in its desktop window | `npm run dev:desktop:photo-tool` | `npm run dev:desktop:editor` |
| Build its page | `npm run build:photo-tool` | `npm run build:editor` (`npm start` then serves it at http://127.0.0.1:5174) |
| Build the desktop program, and start it | `npm run desktop:build:photo-tool`, `npm run start:photo-tool` | `npm run desktop:build:editor`, `npm run start:editor` |
| Make the installer | `npm run dist:photo-tool` | `npm run dist:editor` |
| Make the installed folder only, without an installer | `npm run dist:dir:photo-tool` | `npm run dist:dir:editor` |
| End-to-end tests (in your installed Chrome) | `npm run e2e:photo-tool` | `npm run e2e:editor` |

- `npm test` runs every unit test (both programs and `shared/`), `npm run typecheck` checks all the code, and `npm run test:e2e` runs both programs' end-to-end tests.
- `npm run dist:all` makes both installers. Each builds for the platform it runs on, into its own folder, `dist/installer/photo-tool/` and `dist/installer/photobook-editor/`: on Windows a per-user installer (`Photo Tool Setup <version>.exe`, `Photobook Editor Setup <version>.exe`, no administrator prompt), on Linux a `.deb` and an AppImage (x64 only, `photo-tool-<version>-amd64.deb`, `photo-tool-<version>-x86_64.AppImage` and the same for `photobook-editor`). Everything a program needs is inside; nothing is downloaded when installing or running it.
- The installers are not code-signed, so Windows shows "Windows protected your PC" (choose **More info**, then **Run anyway**).
- From Windows, `node scripts/desktop/linux/docker-build.mjs` makes the Linux packages in Docker, and `node scripts/desktop/linux/docker-test.mjs` installs and self-tests them on clean Linux desktops with the network off.
- `npm run fixtures` writes 21 synthetic trip photos to `fixtures/generated/trip`, to try either program without your own photos.
- The code: `photo-tool/` and `photobook-editor/` are the two programs, and `shared/` is what both use (the desktop shell, `photoinfo.json`, reading photos). Neither program imports the other; a test checks it.

## Where the data lives

**Installed**, each program keeps its own data in a per-user folder, and uninstalling leaves it in place:

- Photo Tool: `%APPDATA%\Photo Tool\data` on Windows, `~/.config/Photo Tool/data` on Linux (thumbnails, recent folders, tagging models).
- Photobook Editor: `%APPDATA%\Photobook Editor\data` on Windows, `~/.config/Photobook Editor/data` on Linux (books, thumbnails, exports).
- Shared by both: `%APPDATA%\Photo Tools Shared\photoinfo` (`~/.config/Photo Tools Shared/photoinfo` on Linux), the stars and notes for photos in folders that can't be written (a read-only drive).

**File → Open the data folder** in each program shows its folder. A desktop program started from source (`npm run start:photo-tool`, `npm run start:editor`) uses the same names with " Dev" added (`%APPDATA%\Photo Tool Dev`, `%APPDATA%\Photobook Editor Dev`, `%APPDATA%\Photo Tools Shared Dev`), so development never touches the installed programs' data.

**Run from source** (`npm run dev`, `npm run dev:photo-tool` and the `dev:desktop` commands), the data is in the project's `./data` folder: `./data/photo-tool`, `./data/photobook-editor` and, shared, `./data/photoinfo-shared`.

**Moving them.** `PHOTO_TOOL_DATA_DIR` and `PHOTO_TOOL_PROFILE_DIR` choose Photo Tool's data and browser-profile folders, `PHOTOBOOK_DATA_DIR` and `PHOTOBOOK_PROFILE_DIR` the editor's, and `PHOTOINFO_FALLBACK_DIR` the shared one. `PHOTO_TOOL_WEB_PORT` / `PHOTO_TOOL_PORT` and `PHOTOBOOK_WEB_PORT` / `PHOTOBOOK_PORT` move the ports.

### Coming from Photobook Studio and Photobook Gallery

Your books, stars, catalogue and tagging models come with you; nothing is copied, merged or deleted.

- **Installed.** The first time each new program starts, it renames its old folder to its new name, if the new one does not exist yet: `Photobook Studio` becomes `Photobook Editor`, and `Photobook Gallery` becomes `Photo Tool` (the " Dev" folders too). Whichever program starts first also moves the old editor's `data\photoinfo` folder to `Photo Tools Shared\photoinfo`. If a folder can't be moved, most often because the old program is still running, the new one says which folder and quits rather than start empty: close the old program and start the new one again.
- **From source.** Each program moves its own part of the old `./data` layout the first time it runs: the editor's files at the top of `./data` go to `./data/photobook-editor`, `./data/gallery` goes to `./data/photo-tool`, and `./data/photoinfo` to `./data/photoinfo-shared`. If old data is still there when its new folder exists already, it is left alone and a warning names it and where it belongs. `npx tsx scripts/carry-over-dev-data.ts` moves every part at once.
- Nothing is moved for a folder you chose yourself with one of the variables above.

**Uninstall the old program by hand.** The new installers do not remove the old "Photobook Studio" program (it is a different program to Windows and Linux). After installing Photo Tool and Photobook Editor and starting each once, so that your data has moved, uninstall Photobook Studio by hand: on Windows from **Settings → Apps → Installed apps**, on Linux with `sudo apt remove photobook-studio`. Its old shortcuts, including the "Photobook Gallery" one, go with it.

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the editor is built.
- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md): what the editor does not do yet.
- The other files in `docs/` are the history of the project: plans, research and design notes, kept as they were written.

## Licence

[MIT](LICENSE) © 2026 Jennifer Lo. Bundled fonts come from `@fontsource` packages under the SIL Open Font License; other dependencies keep their own licences. **Help → About** in each program lists the licences of everything it ships (`THIRD-PARTY-NOTICES.txt`, made by `scripts/make-notices.ts`).
