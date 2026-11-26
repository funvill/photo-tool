# Issue #9 report: Delete, rotate/flip, light and colour, before/after, Ctrl+A/D, Ctrl+C, ? overlay

Branch `gallery-keys-and-colour` in `C:\Users\funvill\Documents\git\photobook_helper-keys`, rebased on the local `issues-integration` at 0b18c30 (v0.1.43, with #4, the album-tags sidecar and #7a). Local only: nothing pushed, no PR, no GitHub writes.

## Commits

| Phase | Commit | What |
|---|---|---|
| 9a | d31ba10 | Ctrl+A / Ctrl+D select all or none; Delete key (same action as the menu's Delete, every selected shown photo, Recycle Bin only) |
| 9b | 97fcbdd | `[` / `]` and the menu rotate without edit mode; Flip horizontally; Light and colour sliders with Auto; the same colour matrix on the page (SVG feColorMatrix, sRGB) and in sharp (recomb + linear) |
| 9c | b0f456a | Ctrl+C: one photo as the picture, several as files (text/uri-list → CF_HDROP), up to 500 |
| 9d | e677bb2, 97f6ea1 (docs) | Hold `\` or Before for the original; `?` overlay from one shortcut table; Help › Keyboard shortcuts after #4's items; README |
| — | 304b7a7 | Version bump on top of issues-integration's 0.1.43 |

## Tests

Final run on the branch as committed (before the version-only commit):

- `npm run typecheck`: clean.
- `npx vitest run` (fast set): 79 files, 1116 passed, 3 skipped.
- `npm run test:slow`: 10 files, 302 passed, 1 skipped.
- Playwright `--project=photo-tool` (ports 5585/5586, sidecar 5587): 58 passed.
- Playwright `--project=editor`: 3 passed.

New or extended tests: `shared/tests/color-adjust.test.ts`, `shared/tests/photo-edit.test.ts`, `shared/tests/photo-edit-render.test.ts` (flip equals sharp's flop, brightness, saturation, page/server colour agreement, greyscale and alpha input), `photo-tool/tests/gallery-edit-server.test.ts` (stored flip/adjust, auto-adjust), `photobook-editor/tests/importer-edit.test.ts` (an adjusted photo imports brighter; flip alone re-renders), `photo-tool/tests/copy-files.test.ts`, `photo-tool/tests/shortcuts.test.ts` (no two rows of a place match one key press; every key the viewer acts on is listed; F1/F2 present), `photo-tool/tests/gallery-store.test.ts`, `photo-tool/tests/photo-tool-shell.test.ts`, `shared/tests/desktop-shell.test.ts`, and 10 new Playwright tests in the `#9` describe of `photo-tool/tests/e2e/gallery.spec.ts` (including a pixel check that the page's colour filter matches the saved colour within 4 levels).

Every phase was committed green (typecheck, vitest, photo-tool Playwright). After the rebase onto 0b18c30, each rebased phase commit (9a d31ba10, 9b 97fcbdd, 9c b0f456a) was checked out on its own and passed `tsc` and the fast vitest set; the full set (slow vitest, both Playwright projects) ran at the tip. The editor's Playwright project was run once at the end because `shared/server/photoEditRender.ts` changed.

## Ctrl+C with several files: the spike

Tried on this Windows 11 machine with throwaway Electron scripts in the scratchpad (`spike-copy/main*.cjs`), run with the main checkout's Electron binary. Nothing installed.

- Electron 45 has no raw clipboard formats any more (`clipboard.writeBuffer` and `availableFormats` are gone; `clipboard.write` takes MIME types only). The custom formats `CF_HDROP` and `15` through other routes did not work.
- Writing a `ClipboardItem` with `text/uri-list` (file URLs, CRLF between) puts **FileDrop (CF_HDROP), FileNameW and FileName** on the Windows clipboard. Read back from a separate process (PowerShell `Get-Clipboard -Format FileDropList`, the formats from Windows Forms' `Clipboard.GetDataObject()`), every path came back exactly, including awkward names (`#`, `%`, `&`, `+`, `'`, Japanese, accents).
- 500 files: written in 3 ms, all 500 read back exactly.
- PowerShell `Set-Clipboard -LiteralPath` also works, but costs 1–6 s per call (a process spawn), so it was not used.
- Not tried: pasting into Explorer by hand (driving the desktop is not allowed here), and Linux at all. On Linux, `text/uri-list` is the standard file-copy type, so it should work in file managers, but this is untested.
- The spike overwrote and then cleared this machine's clipboard while it ran.

Result: multi-file Ctrl+C ships, with no new native dependency, no child process. Only photos of the open folder are copied (the same check as a drag), at most 500, with a toast saying how many.

## Decisions I made

- **Flip and rotate:** `flipEdit` swaps rotate 90 ↔ 270 as well as mirroring the crop (x' = 1 − x − w) and negating straighten. The issue only listed the crop and straighten; without the rotate swap a turned photo would flip the wrong way on screen. A render test checks `flipEdit` on a turned photo equals sharp's `flop()` of the turned result.
- **`PhotoEdit.flip` and `adjust` are optional in the type**, but `parseEdit` always fills them. Default flip and adjust are left out of `photoinfo.json` (`storedEdit`), and `editKey` is unchanged for edits without them, so existing caches and saved edits stay valid.
- **Auto** works from the whole upright photo (the m thumbnail), not the draft crop.
- **The full-screen viewer still shows photos unedited**, as before, so `\` does nothing there; the viewer's `?` list leaves it out.
- **Keys in the table:** each row lists alternatives (`['←', '→']`), a combination is one string (`'Ctrl+Z'`), not the issue's `['Ctrl', 'Z']`, so the overlay can tell "or" from "+". F1, F2 and Ctrl+O are menu accelerators: listed (desktop app only), never matched by a page handler. Keys the viewer only swallows (Tab, PageUp, PageDown) have no rows.
- **The `?` list shows the current place only** (grid and preview, viewer, or edit mode), plus F1 and F2.
- **Help › Keyboard shortcuts** is a new optional `helpMenu` hook on `DesktopProgram`, kept like `fileMenu` and appended as its own group after #4's About. The editor passes none, so its menu is unchanged. #4 had merged, so F1 and F2 are in the table.
- **Before button** sits in the preview caption when the photo has an edit (or is being edited); it uses pointer capture, so the press holds until let go.
- **`\` keyup** is matched by the key's `code` from keydown (Shift mid-hold cannot strand it), and window blur always clears it. `\` and `?` work right after a colour slider was moved with the keyboard.
- The photo menu's key hints come from the same table (Delete now reads "Delete" instead of "Del").

## Checked by hand

Nothing in the desktop app: running it by hand and driving the desktop are not allowed here. Everything was checked through vitest (including source checks of the Electron wiring) and Playwright against the page with a stand-in `window.desktop`. Screenshots from a throwaway Playwright run (fixture photos, temp folders) were looked at by eye: edit mode with the Light and colour row, the preview holding `\` (the Before button, "Original" badge and the unedited picture), and the `?` list (`scratchpad/shots9/`). The Ctrl+C handler imports `ClipboardItem` from `electron` exactly as the spike did, on the same Electron (45.4.1) as the lockfile, and the existing Copy to clipboard already uses it.

## Concerns / not done

- Explorer paste of a multi-file Ctrl+C was not tried by hand; the clipboard contents were verified programmatically only. Linux is untested.
- The Help menu item and the real IPC were not run in Electron (only source-checked and faked in Playwright).
- An older Photobook Editor ignores flip and colour (documented in the README).
- Holding `\` remounts the preview stage (its key includes the edit), so a zoomed-in preview goes back to the whole photo on press and on release.
- "One table" is enforced by construction for the grid and edit mode (handlers switch on the table's ids). The viewer still steps through `viewerStep`'s own key names, guarded by a test that every key it acts on is listed; `PhotoMenu`'s `REVIEW_KEYS` (keys passed through an open menu) is still its own set.
- Versions: the 9d and docs commits bumped to 0.1.44 and 0.1.45; the last commit sets 0.1.44 again, i.e. issues-integration's 0.1.43 plus one bump, as the rules ask.

## Fix round 1

Rebased onto issues-integration 8a849d3 (v0.1.44); the branch is now at v0.1.45 (its version plus one bump, carried by the fix commit c5b447c, which is the tip). Failing tests were written first for both Important items.

- **I1, Delete stopped at 500.** `trashPhotos` (photo-tool/electron/fileActions.ts) no longer slices to 500: it checks the photos with the server 500 at a time, asks once with the real count (2,000 photos: "Move 2000 photos to the Recycle Bin?"), moves every photo the confirm named, and tells the server in batches of 500. Over `MAX_TRASH_FILES` (10,000) nothing is checked, asked or moved; the page refuses first with "Delete takes at most 10,000 photos at a time. Nothing was moved." When some are not moved (a bin failure, or a photo no longer in the folder), the toast reads "Moved X of N photos to the Recycle Bin. Y were not moved: <file>: <reason>". Tests: gallery-file-actions (2,000 in batches, a failure part way, refusal over the cap) and gallery-store (2,000 in one call with the honest toast; refusal before the desktop app is asked).
- **I2, Ctrl+C with several files on Linux.** Chose the second option: multi-file copy stays Windows-only (the one place it was tried). On Linux and macOS the desktop app copies the photos' paths as text, one per line, replies `as: 'paths'`, and the toast says "Copied the paths of N photos as text (copying the files themselves works on Windows only)". The GNOME/KDE formats were not implemented because nothing here can check them. Tests: `copyFilesClipboard` payload per platform (copy-files.test.ts), the toast (gallery-store), and the handler wiring (photo-tool-shell).
- **Minors fixed:** the README no longer claims an older Photobook Editor gets a flipped and turned or cropped photo right. Holding `\` keeps a zoomed-in preview zoomed when the edit keeps the photo's shape (flip, light and colour), checked in Playwright; for a crop or a turn the original has another shape, so the preview starts fitted. The other Minors (M1–M4, M7–M11) are left as the review lists them.

Tests at the tip: typecheck clean; `npm test` 1124 + 302 passed (3 + 1 skipped); Playwright photo-tool 58 passed, editor 3 passed (1 skipped).
