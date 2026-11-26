### Spec Compliance

- ✅ Spec compliant. Every item in Tasks 1, 2 and 4 and every global constraint is implemented. Names and signatures match the issue exactly: `listenWithFallback`, `StartMessage.fallbackToAny`, `parseSavedPort`, `serverPortRequest`.
- ⚠️ Cannot verify from diff (Task 3, "No code", manual proof):
  - The editor build (`dist:dir:editor`) was not exercised (report, "Not done"). Photo Tool was checked by hand, in 4 runs.
  - Step 4 (Restart returns on the same port) was not run. The report says only the editor sends `restart`, and the issue wrongly calls it Photo Tool's. The controller should run it on the editor build, or accept the code reading below.
  - I checked the Restart path by reading code outside the diff:
    - Risk: a relaunch racing the old server for the saved port, or the diff changing the restart flow.
    - What I read: `runDesktopApp.ts:286-289` and `:650-661`. The `restart` message calls `app.relaunch()` then `app.quit()`. `before-quit` awaits `stopServer()` and then calls `app.exit`, and Electron starts the relaunched process only after the exit.
    - Finding: the old server has closed before the new one starts, so the saved port is reused. The diff does not touch this flow. If the port were still busy, the fallback still lets the start succeed.

### Strengths

- `parseSavedPort` (`config.ts:128-132`) is strict. It takes an own-property `port` that is an integer from 1024 to 65535, and everything else is null. It covers the string, the low port, out-of-range, float, NaN, array, null and bare-number cases (`desktop-config.test.ts:424`).
- `readSavedPort` (`runDesktopApp.ts:207-213`) wraps both the read and the parse in `try`/`catch`. A corrupt, missing or hostile file can only mean "no saved port".
- The save is a temp file plus rename, and a failure is logged and not fatal (`:214-223`).
- Network exposure is unchanged. `listenOn` hard-codes `127.0.0.1`, and the fallback also uses `'127.0.0.1'` (`serverHost.ts:342`, `:358`). Both the fake-app test and the real-socket test assert the address and host.
- The window and the request guard still use the port from `ready`, never the saved one (`:282`). A source test pins this.
- The fallback is correct:
  - It falls back only on `EADDRINUSE` and `EACCES`, and only with the flag set (`serverHost.ts:356-358`).
  - It does not retry when port 0 itself was refused.
  - The busy-port test uses a real held socket.
  - The Express 5 quirk is handled: the listen callback receives the error, so success is settled once. The `settled` guard covers the callback and the `error` event both firing.
- Dev and self-test never save:
  - `rememberPort = !devUrl && !selfTest` (`:205`) gates both the read (`:300`) and the save (`:279`).
  - `serverPortRequest` returns `fallbackToAny: false` for both modes.
  - The old dev-port rule is preserved, and a test covers it.
- Tests exercise real behaviour (real sockets) and cover all four review-focus cases. The Photo Tool manual run covered same-origin reuse, a busy port, and reuse of the new port.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

None.

#### Minor (Nice to Have)

1. `runDesktopApp.ts:207-213`: `readFileSync` has no size cap. A hand-made multi-GB `server-port.json` would be read whole before the catch. The profile folder is user-owned, so the risk is negligible. A `statSync` size check (a few hundred bytes) would close it.
2. `desktop-shell.test.ts:472-506`: the shell tests are regexes over source text, for example `saveServerPort(` appearing exactly twice, and `{0,300}` windows. They are brittle against harmless refactors. The issue asked for a shell source test, so this is acceptable. It is logged because it is test-mechanics debt.
3. `runDesktopApp.ts:2-3`: the header comment grew into one very long line, against the file's wrapped style. Cosmetic.
4. Residual, accepted: a remembered port is predictable, unlike a random one. On Windows, another local user could bind the same 127.0.0.1 port with `SO_REUSEADDR` after our server does. The issue accepts the design, and nothing outside the shell's own page is ever loaded from a port other than the reported one. No change is requested.

### Assessment

**Task quality:** Approved

**Reasoning:** The implementation matches the issue's design and constraints, handles hostile files and busy or refused ports safely, keeps the server on 127.0.0.1, and never saves in dev or self-test. The only gaps are manual: no editor-build check and no Restart run. By code reading, Restart is unaffected.
