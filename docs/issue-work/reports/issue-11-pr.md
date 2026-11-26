Closes #11

## What was built

The desktop shell now remembers the local server's port, so the page keeps its origin, and with it its `localStorage` (thumbnail size, panel widths, open sections, the editor's last folder, the Shelf), across restarts. This fixes both programs at once. No page code changed.

- `shared/electron/serverHost.ts`: new `StartMessage.fallbackToAny` and `listenWithFallback(app, port, fallbackToAny)`. It listens on `127.0.0.1` only. When the flag is set, a port that is busy (`EADDRINUSE`) or refused (`EACCES`, for example one Windows reserves for Hyper-V or WSL) is dropped for any free port. Any other error, or the flag off, fails the start as before. It also checks the error Express 5 passes to the `listen` callback, so a failed listen is never taken as success.
- `shared/electron/config.ts`: `parseSavedPort` accepts only an integer from 1024 to 65535; anything else counts as no saved port. `serverPortRequest` covers four cases: development keeps `<PREFIX>_PORT` or the page port + 1 with no fallback; a self-test asks for port 0; a saved port is asked for with fallback; with nothing saved it asks for port 0.
- `shared/electron/runDesktopApp.ts`: reads `<profileDir>/server-port.json` (the same try/parse pattern as `window-state.json`) and spreads `serverPortRequest(...)` into the start message. After `ready`, it saves the reported port: a temp file, then a rename. A failed write is logged and never stops the app. Nothing is read or saved in development or in a self-test. The window, `appOrigin` and `allowedPorts` still use only the port from the server's `ready` reply, never the saved number.
- `docs/electron-plan.md`: a note under the architecture diagram.

## Tests

- `shared/tests/server-host.test.ts` (new) runs real `express()` apps on `127.0.0.1` and covers:
  - a free port, which it listens on exactly;
  - a port held by a real `node:http` server: with fallback it gets a different port, without fallback it rejects with `EADDRINUSE`;
  - a faked `EACCES`: with fallback the second call asks for port 0 on `127.0.0.1`, without fallback it rejects;
  - other errors and a request for port 0, which do not retry.
- `shared/tests/desktop-config.test.ts`: `parseSavedPort` (valid, edge and corrupt values: `{port:'52659'}`, `{port:80}`, `{port:70000}`, `null`, `'x'` and others) and the four `serverPortRequest` cases.
- `shared/tests/desktop-shell.test.ts`: source checks that:
  - the start message's port comes from `serverPortRequest`;
  - the port is kept in `server-port.json` in `layout.profileDir`, through a temp file and a rename;
  - the save sits behind `rememberPort = !devUrl && !selfTest`;
  - the window URL uses `serverPort` from `ready`.
- `npm run typecheck` is clean, and `npx vitest run` gives 1137 passed and 4 skipped (79 files).
- Playwright was not run. Its `webServer` starts `tsx <program>/server/main.ts` directly, which does not go through `serverHost.ts` or the shell, and no page code changed.

## Checked by hand (Task 3)

I built `npm run dist:dir:photo-tool` (version 0.1.38 at build time, the same code as this branch), then started `dist/installer/photo-tool/win-unpacked/Photo Tool.exe` four times in a row. All five folder variables (`PHOTO_TOOL_DATA_DIR`, `PHOTO_TOOL_PROFILE_DIR`, `PHOTOBOOK_DATA_DIR`, `PHOTOBOOK_PROFILE_DIR`, `PHOTOINFO_FALLBACK_DIR`) pointed at a throwaway folder, and `--remote-debugging-port` was set. I read the page's origin and `localStorage` through the DevTools protocol, and the port from `server-port.json` and the `desktop.log` lines.

| Run | Asked for | Page origin | `issue11.check` at start | `server-port.json` |
|---|---|---|---|---|
| 1 | `{port:0, fallbackToAny:false}` | `http://127.0.0.1:50284` | `null` (then set to `kept-250`) | `{"port":50284}` |
| 2 | `{port:50284, fallbackToAny:true}` | `http://127.0.0.1:50284` | `"kept-250"` | `{"port":50284}` |
| 3 (50284 held by another listener) | `{port:50284, fallbackToAny:true}` | `http://127.0.0.1:55274` | `null` (new origin, as expected) | `{"port":55274}` |
| 4 (50284 released) | `{port:55274, fallbackToAny:true}` | `http://127.0.0.1:55274` | `null` | `{"port":55274}` |

Both starts of the bug's check use the same port and origin, and the value set in run 1 is there in run 2. A held port falls back to a free one within the same start, the new port is saved, and the next start reuses it.

Each run was ended by its own process ID. A plain `taskkill /PID … /T` was refused for the utility child, so every run was force-ended about 10 s later. The value from run 1 still survived, after a 3 s wait for Chromium to flush.

## Not done

- **The Photobook Editor build was not checked by hand.** The dispatch asked only for `dist:dir:photo-tool`. The shell code is shared and the unit tests cover it.
- **Restart was not checked by hand** (issue Task 3 Step 4). The `restart` message is sent only by the editor's server host (`photobook-editor/electron/server-host.ts`), not Photo Tool's. By the code, `before-quit` waits for the server to stop before `app.exit`, so the port should be free for the relaunch.
- Settings saved before this fix sit under old random ports and are not carried over, as the issue says.

## Decisions I made

- `listenWithFallback` does not retry when port 0 itself was asked for.
- The shell logs the port request (`asking the server for port {...}`) to `desktop.log`, to make a fallback visible in a support log.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
