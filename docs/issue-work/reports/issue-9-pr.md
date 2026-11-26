Photo Tool: Delete key, rotate/flip, light and colour, before/after, Ctrl+A/D, Ctrl+C, ? shortcuts

Closes #9

## What this adds

Built from the issue's "Decisions" table, in four phases (one commit each, plus a version bump):

- **9a: Ctrl+A / Ctrl+D and Delete.** Ctrl+A selects every shown photo (filters and folded stacks respected) and keeps the focused one in the preview; Ctrl+D selects none. Delete does what right-click › Delete does: the same confirm, every selected shown photo, Recycle Bin / Trash only, and the selection moves on. The confirm names the real count and every photo it named is moved: the desktop app checks and reports them to the server 500 at a time. Over 10,000 is refused with a message before anything is asked or moved, and when some photos are not moved the message says how many of how many went. In a text field these keys stay the field's own.
- **9b: Rotate, flip, light and colour.** `[` and `]` (and right-click › Rotate left / Rotate right / Flip horizontally) turn or mirror every selected photo as an unsaved edit, one undo step per press, without opening edit mode. Flip is a new step in the shared edit model, applied on the upright photo before the turn. Edit mode gains Flip and a Light and colour row: Brightness, Contrast, Saturation and Warmth (−100..+100, double-click resets), plus Auto, which asks the new `GET /api/gallery/auto-adjust` for values from the photo's own levels. The four sliders become one 3×3 matrix plus an offset (`shared/core/colorAdjust.ts`); the page draws it with an SVG `feColorMatrix` in sRGB and sharp applies the same numbers (`recomb` + `linear`) when the photo is saved, rendered or imported into the Photobook Editor. Default flip and adjust are not written to `photoinfo.json`, and `editKey` is unchanged for edits without them.
- **9c: Ctrl+C.** One photo goes on the clipboard as the picture, as Copy to clipboard does. On Windows, several go as files (up to 500): the desktop app writes a `text/uri-list` of file URLs, which Electron puts on the Windows clipboard as a file drop list (CF_HDROP), the format Explorer and chat apps paste. Only photos of the open folder are taken, with the same check as a drag. On Linux and macOS, where copying files was never tried, several photos are copied as their paths (text, one per line), and the toast says that copying the files themselves works on Windows only. The toast always says what actually went on the clipboard. With text selected, or in a field, Ctrl+C copies text as usual.
- **9d: Before/after, the `?` list, Help › Keyboard shortcuts.** Holding `\` (or the Before button in the preview caption) shows the photo with no edit at all, captioned "Original", in the preview and in edit mode; letting go or leaving the window shows the edit again, and nothing changes. `?` shows the keys for where you are (grid and preview, full-screen viewer, or edit mode), including F1 and F2 from #4; `?` again, Esc or a click outside closes it. Every key handler and the list read one table (`photo-tool/web/shortcuts.ts`), so in the grid and edit mode a handler cannot act on a key the list does not show; the viewer keeps its own step function, with a test that every key it acts on is listed. Help › Keyboard shortcuts comes after #4's Help items, through a new optional `helpMenu` hook on the desktop shell (the editor passes none). The README covers the new keys, the Light and colour row, and that an older Photobook Editor ignores flip and colour (and gets a flipped photo that is also turned or cropped wrong).

## Ctrl+C for several files: the spike

Electron 45 has no raw clipboard formats any more, so the issue's open question was settled by trying it on Windows 11 with throwaway scripts (nothing installed). `clipboard.write` with a `text/uri-list` item produces FileDrop, FileNameW and FileName on the Windows clipboard; read back from another process, 500 files came back exactly (written in 3 ms), including names with `#`, `%`, `&`, `+`, `'` and non-Latin characters. PowerShell `Set-Clipboard -LiteralPath` also works but takes 1 to 6 seconds per call, so it was not used. No native dependency and no child process were added.

## Tests

- `npm run typecheck`: clean.
- `npm test`: 1124 passed, 3 skipped (fast set) and 302 passed, 1 skipped (slow set).
- Playwright: photo-tool 58 passed, editor 3 passed (1 skipped).
- New: colour matrix and Auto unit tests; render tests showing flip equals sharp's `flop()` and the page's matrix equals the saved pixels (including clipping, greyscale and alpha); auto-adjust and stored-edit server tests; an editor import test (an adjusted photo comes in brighter); `copy-files.test.ts`; `shortcuts.test.ts` (no two rows of one place match the same key press, every key the viewer acts on is listed); Delete of 2,000 photos (one confirm, all moved, checked in batches) and the refusal over 10,000; the Ctrl+C clipboard payload per platform and its toast; store and shell tests; 10 Playwright tests (Ctrl+A/D, Delete, menu Delete, `[`/`]` and flip, Light and colour with Save/Auto/Reset, a screen-pixel check of the colour filter, Ctrl+C, hold `\` (keeping the zoom), the `?` list in grid/viewer/edit mode, Help › Keyboard shortcuts).

## Checked by hand

The desktop app was not run by hand, and Explorer paste was not tried by hand. The clipboard contents were checked by a script, the Electron wiring by source tests, and the page by Playwright with a stand-in `window.desktop`. Screenshots of edit mode with the Light and colour row, the preview while `\` is held, and the `?` list were looked at by eye.

## Not done / worth knowing

- Multi-file Ctrl+C copies files on Windows only; Linux and macOS get the paths as text, with a toast that says so (GNOME and KDE file copy could not be tried here).
- The full-screen viewer still shows photos without their edit, as before, so `\` does nothing there.
- `flipEdit` also swaps rotate 90 and 270, beyond what the issue listed; without it a turned photo would mirror the wrong way. A render test checks it against sharp's `flop()`.
- The photo menu's key hints now come from the shortcut table (Delete reads "Delete", not "Del").
- Holding `\` keeps a zoomed-in preview zoomed when the edit keeps the photo's shape (flip, light and colour); for a crop or a turn the original has another shape, so the preview starts fitted.
- Versions: the branch ends at 0.1.45, issues-integration's 0.1.44 plus one bump; earlier commits on the branch carry their own intermediate bumps.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
