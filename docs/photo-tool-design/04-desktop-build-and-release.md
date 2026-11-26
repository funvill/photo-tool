# Desktop program, build, test and release

Photo Tool is shipped as an Electron desktop program (Windows x64: per-user NSIS installer; Linux x64: `.deb` and AppImage). There is no web version and no macOS build, although the shell contains a few macOS branches. This section describes the shell (`shared/electron/`), the parts Photo Tool adds (`photo-tool/electron/`), the desktop API exposed to the page (`shared/desktop/desktopApi.ts`), and how the program is built, tested and released (`scripts/`, `.github/workflows/`, `photo-tool/electron-builder.config.cjs`, `package.json`, vitest and Playwright configs).

The shell is shared with a second program (Photobook Editor). Nothing in `shared/electron/` imports a program: every difference is passed in through a `DesktopProgram` object (see "Program contract"). Only the Photo Tool side is described here.

Identity constants (`photo-tool/product.json`):

| Field | Value |
| --- | --- |
| `productName` | `Photo Tool` |
| `appId` | `app.phototool.desktop` (also the Windows AppUserModelID) |
| `maintainer` | `Photo Tool <photo-tool@localhost>` |
| `repository` | `github:funvill/photo-tool` |
| `description` | "Look through a folder of photos, star the best ones and drag them into other programs. Uses the network only for map tiles (if you choose Load maps), to download photo-tagging models you ask for, and to check GitHub for a new version." |

The old product name, whose data folder is moved once, is `Photobook Gallery`. The program's version is the single `version` in the root `package.json` (0.1.43 at the time of writing), shared with the editor.

### 1. Process model

```
Electron main process  (main.cjs, built from photo-tool/electron/main.ts + shared/electron/runDesktopApp.ts)
  |  utilityProcess.fork(server-host.cjs)   -- stdio piped, serviceName "Photo Tool server"
  |      +-- Express app (createGalleryApp) listening on 127.0.0.1:<port>
  |      +-- tagging worker thread (tagging-worker.cjs; onnxruntime-node) started by the server
  |  BrowserWindow (one)  -- renderer: Photo Tool's React page, loaded from http://127.0.0.1:<port>/
  |      +-- preload.cjs  -- exposes window.desktop (contextBridge)
  |  electron-updater (main process, own network use, GitHub only)
```

- **Main process** owns the window, menus, dialogs, IPC handlers, file-system actions that need the OS (Recycle Bin, drag out, clipboard, reveal in folder), the request guard, the log, update checking and the self-test.
- **The local HTTP server runs in a child, not in the main process.** It is an Electron `utilityProcess` (Node environment) forked from `server-host.cjs`, so a long scan or image render never freezes the window. It listens only on `127.0.0.1`. The same Express app (`photo-tool/server/app.ts`, `createGalleryApp`) is what `npm run dev:photo-tool` runs standalone from source (`photo-tool/server/main.ts`), so the page and the API are identical in both.
- **Renderer** is an ordinary sandboxed web page: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `spellcheck: false`, `webviewTag: false`, `navigateOnDragDrop: false`, `devTools` only when not packaged. Its preload (`preload.cjs`) may only `require('electron')`.
- **Main to server** messages (`shared/electron/serverHost.ts`):

| Direction | Message | Meaning |
| --- | --- | --- |
| main to server | `{ type: 'start', dataDir, photoInfoFallbackDir, port, fallbackToAny?, resourceRoot?, devWebUrl? }` | Create the app and listen. `port` 0 = any free port. |
| main to server | `{ type: 'stop' }` | Close the HTTP server (`closeAllConnections`), then close the app (database), reply `stopped`, `process.exit(0)`. |
| server to main | `{ type: 'ready', port }` | The port actually bound. |
| server to main | `{ type: 'error', error }` | Start failed; `error` is the stack text. |
| server to main | `{ type: 'stopped' }` | Clean stop done (the main process records `serverStoppedCleanly`). |
| server to main | `{ type: 'restart' }` | Main would call `app.relaunch()` + `app.quit()`. Nothing in Photo Tool sends it (see open points). |

- The server's stdout/stderr are collected: each chunk is logged as `[server out]` / `[server err]` and the last 8000 characters are kept for error dialogs.
- **Server host body** (`runServerHost`): does nothing unless `process.parentPort` exists. On `start`: if `resourceRoot` is given, verify the resource files (below); `mkdir -p dataDir`; `create()` (the program's factory, which dynamically imports `../server/app` so a native-module load failure such as sharp reaches the main process as an `error` message rather than a crash); listen; reply. A server `uncaughtException` logs `uncaughtException <stack>` to stderr and exits with code 1.
- **Server inputs built by `server-host.ts`:** `createGalleryApp(msg.dataDir, { photoInfoFallbackDir, tagging: { workerFile: taggingWorkerPath(__dirname) }, ...(resourceRoot ? { resourceRoot, staticDir: <resourceRoot>/web } : { devWebUrl }) })`. In a packaged app the page is served as static files from `<resourceRoot>/web` (every non-`/api/` GET returns `index.html`). In development the server `302`-redirects non-API GETs to the Vite dev server (`devWebUrl`), and with neither it answers `503` "Photo Tool has not been built yet. Run `npm run build:photo-tool`."
- **Resource files the packaged server needs** (`PHOTO_TOOL_RESOURCES`, checked by `checkPhotoToolResources` before listening; missing ones throw `App files are missing:\n  <path>...`): `web/index.html`, `world-atlas/countries-10m.json`, `libheif/libheif-bundle.js`. Photo Tool needs no fonts and no PDFium.
- **Tagging worker path** (`taggingWorkerPath(bundleDir)` in `shared/electron/config.ts`): the bundle directory with the segment `app.asar` replaced by `app.asar.unpacked` (separator kept as the one used in the input), plus `tagging-worker.cjs`. From source or an unpacked build the folder is returned unchanged plus the file name.
- **The Express CSP header** (set on every response by the server): `default-src 'self'; img-src 'self' blob: data: https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; script-src 'self' 'unsafe-inline'`. The page's `<meta>` CSP must be identical (a test checks it equals the editor's except the tile host in `img-src`).

### 2. Program contract (`DesktopProgram`)

`runDesktopApp(program)` is called once at the end of `photo-tool/electron/main.ts`. Photo Tool supplies:

| Field | Photo Tool's value |
| --- | --- |
| `names` | `{ productName: 'Photo Tool', envPrefix: 'PHOTO_TOOL', oldProductName: 'Photobook Gallery' }` |
| `appUserModelId` | `product.appId` |
| `description`, `repository` | from `product.json` |
| `serverHostFile` | `server-host.cjs` |
| `page(base)` | `base` (the page is `index.html` at the server root) |
| `hostResolverRules` | `mapHostResolverRules()` (see netGuard) |
| `updateChannel` | `'photo-tool'` |
| `requestAllowed(url, method, guard)` | `galleryRequestAllowed(url, method, { ...guard, mapsAllowed: mapsOnline && !selfTest })` |
| `sendHeaders` | rewrites headers of tile requests (see netGuard) |
| `fileMenu(ctx)` | Photo Tool's File items (Open folder…) |
| `registerIpc(ctx)` | drag, file actions, edit actions, map consent handlers |
| `startMessage` | `{}` (nothing extra) |
| `singleInstanceData` | `{ argv: process.argv, cwd: process.cwd(), defaultApp: !!process.defaultApp }` |
| `onSecondInstance(data)` | opens the folder named by the second launch |
| `confirmQuit`, `allowClose` | unsaved-edits question (section 8) |
| `onWindow(win)` | `folders.watch(win)`, `edits.watch(win)` |
| `prepareSelfTest`, `selfTest` | Photo Tool's self-test (section 11) |

### 3. Startup sequence

Before the shell runs, `main.ts` checks `--self-test` arguments: if the photo folder and `--self-test-out` overlap (same folder, one inside the other; case-insensitive on Windows; trailing separators ignored) it prints `Self-test refused: <reason> Nothing was deleted or written.` and `process.exit(1)` before anything is created.

Then `runDesktopApp`:

1. Parse the self-test flags. `devUrl = !app.isPackaged ? env.PHOTO_TOOL_DESKTOP_DEV_URL : undefined`.
2. `app.setName('Photo Tool')`; on Windows `app.setAppUserModelId(appId)`. `appData = app.getPath('appData')`.
3. **Folders** (`prepareProgramFolders`): carry-over of old folders (section 6), compute `dataDir`/`profileDir`, then `app.setPath('userData', profileDir)`. Chromium's default profile folder (`<appData>/<package.json productName>`) is never used. If a carry-over throws `CarryOverError`, `refuseToStart` shows an error box (title `Photo Tool can't start yet`), points `userData` at a throwaway temp folder (`<tmp>/photo-tools-refused-XXXX`) and exits with code 1. In a self-test (reachable only in CI) the box closes itself after 3 s (`AbortSignal.timeout(3000)`), `<out>/refused.json` is written (`{ refused, step, from, to, title, message, dialogClosed }`, before the box opens and again after it closes), and a 15 s backstop calls `app.exit(1)`.
4. **Chromium switches** (all "do less on the network"): `no-proxy-server`, `disable-background-networking`, `disable-component-update`, `disable-domain-reliability`, `disable-sync`, `disable-client-side-phishing-detection`, `no-pings`, `dns-prefetch-disable`, `host-resolver-rules=<program.hostResolverRules>`, and `disable-features=SpellcheckServiceMultilingual,MediaRouter,DialMediaRouteProvider,OptimizationHints,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater`.
5. Install `uncaughtException` / `unhandledRejection` handlers in the main process (they log; they do not quit).
6. `requestSingleInstanceLock(<singleInstanceData>)`. If not obtained, `app.quit()` and stop (section 5).
7. Register `second-instance`, `web-contents-created` (hardens every WebContents), `window-all-closed`, `before-quit`.
8. `app.whenReady()` then `main()`:
   1. Log `Photo Tool <version> starting` with `{ packaged, dataDir, profileDir, photoInfoFallbackDir, carriedOver, resourceRoot|'(source)', devUrl, selfTest }`.
   2. Self-test only: `mkdir -p out`; arm a 15-minute watchdog (`fatal('start', 'The self-test did not finish within 15 minutes.')`); run `prepareSelfTest` (copy photos); a failure there is `fatal('start', 'Could not prepare the self-test: ...')`.
   3. `hardenSession()` (request guard, permissions, proxy off, spell-checker off).
   4. `startUpdates()` (skipped in a self-test).
   5. `program.fileMenu(ctx)` then `buildMenu()`.
   6. `registerDesktopApi()`: the shared `desktop:pick-folder` handler, then `program.registerIpc(ctx)`.
   7. `startServer()` (60 s timeout) and log `server ready { port }`. Failure: `fatal('start', message)`.
   8. If `rememberPort`, save the port to `server-port.json`.
   9. `createWindow()`, `program.onWindow(win)`.
   10. `win.loadURL(base)` where `base = devUrl ?? http://127.0.0.1:<port>/`. Failure: `fatal('page', ...)`.
   11. Unless self-test and if updates are on: 5 seconds later run the quiet start check.
   12. Self-test: run the steps, write `result.json`, `app.exit(ok ? 0 : 1)`.

The window is created hidden (`show: false`, `paintWhenInitiallyHidden: true`, `backgroundColor: '#ffffff'`) and shown on `ready-to-show` (never in a self-test). On Linux the window gets `<resourceRoot>/icon.png` as its icon when that file exists; on Windows the icon comes from the `.exe`.

**Window geometry.** Default `1440 x 900`, minimum `960 x 600` (`DEFAULT_WINDOW`, `MIN_WINDOW`). `<profileDir>/window-state.json` holds `{ "bounds": {x,y,width,height}, "maximized": boolean }`, written (plain `writeFileSync`, not atomic) on every window `close` from `getNormalBounds()` and `isMaximized()`. `restoreWindow(saved, displayWorkAreas)`: not an object means default; bounds with any non-finite number means default size, `maximized` still honoured; width/height are clamped up to the minimum and rounded; the remembered position is used only if the title bar is reachable on some display, i.e. for some display `d`: `x + width > d.x + 100` and `x < d.x + d.width - 100` and `y >= d.y - 10` and `y < d.y + d.height - 50`; otherwise only the size is kept (the system centres the window). A saved maximized state calls `maximize()` (not in a self-test).

**Quit and close behaviour.**
- `window-all-closed`: quit, except while `installing` (an update is closing the window), in a self-test, or while a fatal dialog is up.
- `before-quit`: if already `quitting`, let it through. Otherwise (not self-test, not failing) call `program.confirmQuit()`; `false` cancels the quit (unsaved edits kept). Then set `quitting`, and if the server still runs, cancel the quit, `stopServer()` (post `stop`; if no exit within 5 s, `kill()`), then `app.exit(exitCode)`.

### 4. The server port

Why: the page's origin includes the port and the browser stores `localStorage` per origin, so the installed app asks for the port it used last time, keeping the page's settings (grid widths, thumbnail size, etc.).

`serverPortRequest({ devUrl, envPort, selfTest, saved })` returns `{ port, fallbackToAny }`:

| Situation | Result |
| --- | --- |
| Development (`PHOTO_TOOL_DESKTOP_DEV_URL` set, not packaged) | `port = Number(PHOTO_TOOL_PORT ?? <vite port> + 1)`, `fallbackToAny = false` (the Vite dev server proxies `/api/` to this fixed port; defaults 5175 web, 5176 API) |
| Self-test | `port 0`, no fallback |
| A saved port exists | `port = saved`, `fallbackToAny = true` |
| Otherwise | `port 0`, no fallback |

`rememberPort = !devUrl && !selfTest`. `<profileDir>/server-port.json` is `{ "port": <integer> }`. `parseSavedPort` accepts only an object whose `port` is a number, an integer, `>= 1024` and `<= 65535`; anything else (string, low port, array, hand-edited junk, unreadable file) means "no saved port". After `ready`, the port actually bound is written via a temp file `server-port.json.tmp` and `rename`. A write failure is logged (`could not save the server port`) and ignored. The window always loads from the port reported in `ready`, never from the saved number.

`listenWithFallback(app, port, fallbackToAny)` in `serverHost.ts`: bind `127.0.0.1:port`. On error, if `fallbackToAny` is true, `port !== 0` and the error code is `EADDRINUSE` or `EACCES` (EACCES covers ports Windows reserves for Hyper-V or WSL), retry once with port 0 (any free port); every other error, or a failure with fallback off or port 0, rejects (the start then fails with the error text). Express 5 passes a listen error to the listen callback as well as emitting `error`; the helper settles once and treats either as failure. The server never binds any address other than `127.0.0.1`.

### 5. Single instance, windows and second launches

- One window only. `app.requestSingleInstanceLock(data)` with `data = { argv, cwd, defaultApp }`. The lock is per `userData` (the profile folder), so two copies with different `PHOTO_TOOL_PROFILE_DIR` can run side by side (the self-test relies on this).
- A second launch quits itself. The first copy gets `second-instance`: first `onSecondInstance(data)`, which parses the second launch's argv with `launchFolder(argv, defaultApp)` and opens `resolve(cwd, folder)` (a relative path is resolved against the second launch's working directory); then, if a window exists, it restores it from minimised, shows and focuses it.
- **Command line.** `Photo Tool [folder]`: the folder is the first argv entry that is not a flag. The program itself is argv[0] when packaged; when run as `electron <appFolder>` (`process.defaultApp`) the app folder is argv[1] and is skipped (`argv.slice(defaultApp ? 2 : 1)`). `--self-test` and `--self-test-out` and the value after each are skipped; any other argument beginning `--` is skipped. The self-test supplies its own folder (`<out>/photos`) instead of argv.
- **Handing a folder to the page** (`galleryFolders`): a folder is `pending` until the page listens. The page's preload calls `onOpenFolder(cb)`, which sends `gallery:ready-for-folders`; the main process then sends `gallery:open-folder` with the pending folder (once) and from then on sends each new folder immediately. When the page's last listener stops (preload sends `gallery:not-ready-for-folders`) or a main-frame load starts (`did-start-loading`), folders wait again; the latest one replaces any earlier pending one. Only messages from the app's own page are accepted (`fromApp`).
- Windows: no child windows. `setWindowOpenHandler` denies everything (logs `denied new window <url>`). `will-attach-webview` is prevented. WebRTC IP handling `disable_non_proxied_udp`.

### 6. Menus

The menu is rebuilt (`buildMenu`) whenever update state changes (download progress, ready to install, auto-check toggled); the File items are computed once. On macOS the template starts with `appMenu` and `editMenu` roles; Windows and Linux have neither. Mnemonics use `&`.

| Menu | Item | Accelerator | Action |
| --- | --- | --- | --- |
| File | `&Open folder…` | `CmdOrCtrl+O` | Native "Open a folder of photos" dialog (`openDirectory`), modal to the window if it exists; a chosen folder is sent to the page as `gallery:open-folder` (or kept pending). |
| File | (separator) | | |
| File | `Open the &data folder` | none | `shell.openPath(dataDir)`. |
| File | (separator) | | |
| File | Quit (`role: 'quit'`) | role default | Quits through `before-quit` (unsaved-edits question). |
| View | Toggle full screen (`role: 'togglefullscreen'`) | role default (F11 on Windows/Linux) | |
| View | (packaged: nothing more) | | |
| View | not packaged only: separator, Reload (`role: 'reload'`), Toggle Developer Tools (`role: 'toggleDevTools'`) | role defaults | |
| Help | first item, one of: `Check for &updates…`; or while downloading, disabled `Downloading update… N %`; or once a download is ready, `Install &update <version>…` | none | Runs a manual update check / offers the install again (section 9). |
| Help | `Check for updates &automatically` (checkbox) | none | Toggles `auto` in `updates.json` and rebuilds the menu. |
| Help | (separator) | | |
| Help | `Send &feedback on GitHub…` (only when `product.json` repository is `github:owner/repo`) | `F2` | `shell.openExternal` of the new-issue URL (below). |
| Help | (separator) | | |
| Help | `&About Photo Tool` | `F1` | The About message box (below). |

Groups that would be empty are dropped; separators sit only between non-empty groups. F1 and F2 are menu accelerators, so they work whenever the window has focus, in installed and source builds; the page must not use them (the menu wins).

**Feedback URL** (`feedbackUrl`): `https://github.com/<owner>/<repo>/issues/new?` + URL-encoded `title=[Photo Tool <version>] ` and `body=Program: Photo Tool <version>\nSystem: <runtime>\n\nWhat happened, or what would you like?\n`, where `<runtime>` is `Electron <electronVersion>, <platform> <arch>` (for example `Electron 45.4.1, win32 x64`). Nothing else (no folders, names) is included. It opens in the user's own browser; the window's guard is unaffected.

**About box** (F1; `describeAbout`): a native message box of type `info`, title `About Photo Tool`, message `Photo Tool <version>`, detail made of these paragraphs separated by blank lines:
1. `Version <version> (<runtime>)`
2. the product description
3. "Everything stays on this computer. Photo Tool uses the network only for OpenStreetMap map tiles, and only after you choose Load maps on the Map tab; to download photo-tagging models from Hugging Face when you ask for one in Settings; and to check GitHub for a new version once a day, unless you turn that off in Help."
4. "Its thumbnails and recent folders are kept in:\n<dataDir>"
5. credit lines: `Built from the open-source project <owner/repo> on GitHub, under the <licence name>.` (licence name is the first non-empty line of `LICENSE.txt` with "license" turned into "licence"), the licence's `Copyright ...` line, and, when a notices file exists, `It includes fonts and software from other projects, each under its own licence: see "Third-party notices".`

Buttons: `OK` (default and cancel), then `Check for updates` (only when updates work: packaged, not self-test, updater present), then `Third-party notices` (only when `THIRD-PARTY-NOTICES.txt` exists in the resource folder). Choosing Check for updates runs the same check as the menu item (after the box closes). Choosing Third-party notices opens the file with `shell.openPath`; if that fails, it is logged and the file is shown in its folder.

### 7. Config and data folders

All locations are per user. `<appData>` is Electron's `appData`: `%APPDATA%` (Roaming) on Windows, `$XDG_CONFIG_HOME` or `~/.config` on Linux. A copy run from source (not packaged) adds the suffix ` Dev` to each program folder name so development never touches an installed app.

| Purpose | Installed | From source (`start:photo-tool`) | Override |
| --- | --- | --- | --- |
| Program root | `<appData>/Photo Tool` | `<appData>/Photo Tool Dev` | none |
| App data (`dataDir`) | `<appData>/Photo Tool/data` | `<appData>/Photo Tool Dev/data` | `PHOTO_TOOL_DATA_DIR` |
| Chromium profile (`profileDir`, set as `userData`) | `<appData>/Photo Tool/browser` | `<appData>/Photo Tool Dev/browser` | `PHOTO_TOOL_PROFILE_DIR` |
| Shared photo info fallback | `<appData>/Photo Tools Shared/photoinfo` | `<appData>/Photo Tools Shared Dev/photoinfo` | `PHOTOINFO_FALLBACK_DIR` |
| Dev desktop (`dev:desktop:photo-tool`) | `./data/photo-tool`, `./data/photo-tool-browser`, `./data/photoinfo-shared` | | env vars set by `scripts/desktop/dev.mjs` |

**Layout rules** (`dataLayout`):
- Data override and profile override both given: each is used (`resolve`d to an absolute path).
- Only one of the two given (outside a self-test): the other goes beside it, as `<given>-browser` (profile) or `<given>-data` (data). Never under `<appData>/Photo Tool`, because creating that folder would count as "the carry-over already happened".
- Self-test: both default inside the output folder, `<out>/data` and `<out>/profile`, and the shared photo info is `<out>/photoinfo-shared`, unless the environment names them.

**Files in the data folder (`dataDir`) owned by the shell:** `logs/desktop.log` (and `desktop.previous.log`). The catalogue, thumbnails, tagging models and other server files in `dataDir` belong to the server section.

**Files in the profile folder (`profileDir`) owned by Photo Tool or the shell** (everything else there is Chromium's own cache, cookies, local storage, `lockfile`, `SingletonLock`):

| File | Shape | Written by | Rules |
| --- | --- | --- | --- |
| `server-port.json` | `{ "port": number }` | shell | section 4; temp file + rename |
| `window-state.json` | `{ "bounds": {x,y,width,height}, "maximized": boolean }` | shell | section 3 |
| `updates.json` | `{ "auto": boolean, "lastCheck": number \| null }` (pretty-printed, trailing newline) | updater controller | section 9; temp `.tmp` + rename; missing, unreadable or non-object file gives `{ auto: true, lastCheck: null }`, field by field; `lastCheck` must be a finite number |
| `settings.json` | `{ "mapsOnline"?: boolean, "editTarget"?: "info" \| "file", ... }` (pretty-printed, trailing newline) | Photo Tool main | each write re-reads the file, keeps every other key, writes `<file>.tmp`, renames. `mapsOnline` unset until the user answers the Map tab's question; `editTarget` is `'file'` only if exactly that, else `'info'`. An unreadable or non-object file reads as empty. |

**Carry-over of old folders** (`carryOverAll`, run once at start, before anything is written). Skipped entirely, step by step:
- Step 1 (the program's own folder) is skipped when a self-test runs (unless the CI carry-over flag below is set), or when `PHOTO_TOOL_DATA_DIR` or `PHOTO_TOOL_PROFILE_DIR` is set.
- Step 2 (shared photo info) is skipped in a self-test (same exception) or when `PHOTOINFO_FALLBACK_DIR` is set.

Step 1: `from = <appData>/Photobook Gallery[ Dev]`, `to = <appData>/Photo Tool[ Dev]`.
- If `to` exists, has no `data` subfolder, and `from` has a `data` subfolder: throw `CarryOverError` with step `new-folder-without-data` (a leftover stub is never merged into). Nothing moves.
- If `to` does not exist, `from` exists, and a program is running from `from`: throw step `data`. "Running" means: Windows, `from/browser/lockfile` cannot be opened with `r+` (error `EBUSY`, `EPERM` or `EACCES`); Linux/macOS, `from/browser/SingletonLock` is a symlink to `<host>-<pid>` and that pid is alive (`kill(pid, 0)` succeeds, or fails with `EPERM`).
- `carryOver(from, to)`: `to` exists means `already-there` (both left alone); `from` missing means `nothing-to-move`; otherwise `mkdir -p dirname(to)` and a single `rename(from, to)` (nothing is copied, merged or deleted). A rename failure throws `CarryOverError` step `data`.

Step 2: the editor's photo info is moved to the shared folder. `root` is the first of `<appData>/Photobook Studio[ Dev]` and `<appData>/Photobook Editor[ Dev]` that has `data/photoinfo`; none means `nothing-to-move`. If the target does not exist and a program runs from `root`, throw step `photoinfo`. Else `rename(root/data/photoinfo, <appData>/Photo Tools Shared[ Dev]/photoinfo)` (step `photoinfo` on failure). Either program may run this first.

**CI exception.** `PHOTO_TOOLS_CI_SELF_TEST_CARRY_OVER=1` together with `GITHUB_ACTIONS=true` lets a self-test run the carry-over against the real `<appData>`. Either alone means a self-test moves nothing.

**Refusal message** (`carryOverRefusal`, title `Photo Tool can't start yet`, button `Close`, then exit code 1): the text names the old and new folders and, by step: `data` says "Photobook Gallery may still be running. Close Photobook Gallery, then start Photo Tool again. Nothing was changed."; `new-folder-without-data` explains the new folder has only browser settings, tells the user to close both programs and delete or rename the new folder; `photoinfo` says Photobook Studio or Photobook Editor may still be running. Each ends by listing `<from>\n→ <to>`.

**Development data layout** (from source, not the packaged shell): `./data/photo-tool`, `./data/photoinfo-shared`; an older `./data/gallery` is renamed to `./data/photo-tool` and `./data/photoinfo` to `./data/photoinfo-shared`, once, by `shared/server/devData.ts` (`carryOverDevData`; `scripts/carry-over-dev-data.ts` runs it for all parts; skipped for a part whose folder variable is set; old data left behind because the new folder already exists is reported as a leftover, never merged). The standalone server's `resolveDirs` uses `PHOTO_TOOL_DATA_DIR`, else `<PHOTO_TOOL_PROFILE_DIR>-data`, else `./data/photo-tool`.

### 8. Photo Tool's IPC and desktop API (`window.desktop`)

The preload defines `window.desktop` with `contextBridge.exposeInMainWorld`. It is missing in a plain browser, so the page feature-detects every use (`window.desktop?.pickFolder`). Photo Tool implements these members of `DesktopApi`; the editor's `pathForFile`, `openFile` and `showInFolder` are not implemented (and the preload must not contain `desktop:open-file` or `desktop:show-in-folder`). Every string argument is coerced with `String()`; every path array is mapped to strings (non-array becomes `[]`).

| Member | Mechanism and channel | Arguments | Result |
| --- | --- | --- | --- |
| `version: string` | read from `--photobook-version=<v>` in the window's `additionalArguments` (the app version); `''` if absent | | |
| `pickFolder(options?)` | `invoke 'desktop:pick-folder'` | `{ title?, defaultPath? }` | `Promise<string \| null>`. Main: ignored (null) unless the sender is the app page and a window exists; `defaultPath` used only if it is a string naming an existing path; title defaults to `Choose a folder`; native open dialog with `openDirectory`, modal to the window; cancel gives null. |
| `startDrag(paths)` | `send 'gallery:start-drag'` | `string[]` | void |
| `prepareDrag(paths)` | `send 'gallery:prepare-drag'` | `string[]` | void |
| `onDragFailed(cb)` | main sends `'gallery:drag-failed'` | `cb(message)`; non-string payload becomes "Couldn't drag the photos." | returns an unsubscribe function |
| `copyText(text)` | `invoke 'gallery:copy-text'` | string | `{ ok, error? }` |
| `copyImage(path)` | `invoke 'gallery:copy-image'` | string | `{ ok, error? }` |
| `showPhotoInFolder(path)` | `invoke 'gallery:show-in-folder'` | string | `{ ok, error? }` |
| `trashPhotos(paths)` | `invoke 'gallery:trash'` | `string[]` | `{ trashed: string[], failed: {path,message}[], cancelled: boolean }` |
| `getMapConsent()` | `invoke 'gallery:get-map-consent'` | | `boolean \| null` (null = never asked) |
| `setMapConsent(on)` | `invoke 'gallery:set-map-consent'` | only exactly `true` counts as true at the preload; main ignores non-booleans | `void` |
| `getEditTarget()` | `invoke 'gallery:get-edit-target'` | | `'info' \| 'file'` |
| `setEditTarget(t)` | `invoke 'gallery:set-edit-target'` | anything but `'file'` is sent as `'info'` | `void` |
| `saveEditToFile(path, edit)` | `invoke 'gallery:save-edit-file'` | string, `PhotoEdit` (passed on unchanged; the server validates) | `{ ok, saved?, error?, item? }` |
| `saveEditAs(path, edit, info?)` | `invoke 'gallery:save-edit-as'` | string, `PhotoEdit`, optional info object | `{ ok, saved?, cancelled?, error?, savedPath?, item? }` |
| `setUnsavedEdits(count)` | `send 'gallery:unsaved-edits'` | `Number(count) \|\| 0` | void |
| `onOpenFolder(cb)` | main sends `'gallery:open-folder'`; the preload sends `'gallery:ready-for-folders'` on subscribing, and `'gallery:not-ready-for-folders'` when the last listener unsubscribes (a counter) | `cb(folder: string)`; non-strings ignored | returns an unsubscribe function (idempotent) |

**Trust rules.** All handlers ignore a sender that is not the app's own page (`fromApp`: `senderFrame.url` has the same origin as `http://127.0.0.1:<serverPort>`, or the Vite origin in development). The invoke handlers for file actions, map consent, edit target and edit saving additionally require `e.sender === window.webContents` of the one window (`allowed`); when not allowed they return `{ ok: false, error: 'Not allowed' }` (trash returns `cancelled: true`; `get-*` return `null` / `'info'`; `set-*` do nothing). The drag handlers check only `fromApp`.

**Which files may be touched.** The main process never trusts a path from the page. It asks Photo Tool's own server (`http://127.0.0.1:<serverPort>`, Node `fetch`, with timeouts):

| Check | Route | Body | Reply | Timeout | Used by |
| --- | --- | --- | --- | --- | --- |
| drag-check | `POST /api/gallery/drag-check` | `{ paths }` | `{ paths: string[], icon: string \| null }` (catalogued paths in asked order; first one's 400 px thumbnail file) | 3 s | drag |
| file-check | `POST /api/gallery/file-check` | `{ paths }` | `{ paths }` (photos of a folder open now; stricter than drag-check: a photo catalogued in an earlier session is refused) | 3 s | copy image, show in folder, trash, save to file, save as |
| image | `GET /api/gallery/image?path=<p>` | | full-size PNG bytes | 60 s | copy image |
| removed | `POST /api/gallery/removed` | `{ paths }` | any 2xx | 10 s | after trash |
| render | `POST /api/gallery/edit/render` | `{ path, edit }` | `{ file, format? }` (a temp file in the data folder) | 120 s | save edit |
| refresh | `POST /api/gallery/refresh` | `{ paths }` | array of the server's refreshed `GalleryItem` | 60 s | save edit |
| info | `PATCH /api/gallery/info` | `{ path, patch }` | JSON | 120 s | clear edit, copy info |

A non-2xx reply becomes an `Error` whose message is the reply's `error` string if present, else `<path> answered <status>`. (The routes' own behaviour belongs to the server section.) After the server's answer the main process also requires each path to be a regular file (`statSync(p).isFile()`).

**Drag out** (`galleryDrag`; pure rules in `drag.ts`):
- `MAX_DRAG_FILES = 500`. `dragRequest(raw)`: an array, keep non-empty strings, first 500. `dragFiles(requested, catalogued, exists)`: keep requested order, only catalogued paths that exist, at most 500.
- `PREPARED_DRAG_MS = 10_000`. Windows starts a drag from the mouse position when `startDrag` is called, so a drag that waits for the server could miss a quick flick. The page sends `gallery:prepare-drag` on pointer-down on a tile; main checks the list ahead (per window `webContents.id`) and stores `{ requested, files, icon, at }`. On `gallery:start-drag` (dragstart): if a prepared drag exists for exactly the same list (same paths, same order) and is at most 10 s old (and not from the future), start at once; else wait for the check in flight if it is for the same list; else run the check now. A failed check sends `gallery:drag-failed` with "Couldn't drag the photos: Photo Tool did not answer in time. Try again.".
- The drag is `sender.startDrag({ file: files[0], files, icon })`. The file list is re-checked synchronously for existence right before starting; nothing happens if none is left. Original files are dragged (never copies).
- Icon: the first photo's small thumbnail (`DRAG_ICON_PX = 128` on the longest side, never enlarged), or a plain grey 48 x 48 square (`0x88` bytes of bitmap) when there is no thumbnail.
- State is dropped when the page's WebContents is destroyed.

**Right-click file actions** (`galleryFileActions`; rules in `fileActions.ts`):
- Copy path (`gallery:copy-text`): text must be a non-empty string of at most `MAX_COPY_TEXT = 500 * 4097 = 2_048_500` characters; else `{ ok:false, error:'Nothing to copy.' }`. Written with `clipboard.writeText` (the page's own clipboard is denied in the app).
- Copy image (`gallery:copy-image`): one path through file-check; fetch the full-size PNG; if Electron cannot decode it, `Couldn't read that photo.`; else `clipboard.write([ClipboardItem image/png])`. Errors: `That photo is not in the open folder any more.` / `Couldn't copy the photo: <reason>`.
- Show in folder (`gallery:show-in-folder`): one path through file-check, then `shell.showItemInFolder(path)`.
- Trash (`gallery:trash`): `trashPhotos(raw, deps)`: ask the server (file-check) which of the requested paths are photos of an open folder (and files); none means `{ trashed:[], failed:[], cancelled:false }`. Then a native confirm; no window means no. The confirm is a `warning` box with buttons `Move to Recycle Bin` (Linux: `Move to Trash`) and `Cancel`; `defaultId` and `cancelId` are Cancel; message `Move "<file name>" to the Recycle Bin?` for one photo or `Move <n> photos to the Recycle Bin?`; detail `You can restore them from the Recycle Bin.` Cancel gives `cancelled: true`, nothing moved. Yes: each file goes through `shell.trashItem` one at a time; failures (for example a network drive with no bin) are collected as `{ path, message }` and the file stays where it is; never retried another way, never erased. Then `POST /api/gallery/removed` with the trashed paths (a failure there is ignored, because the server leaves missing files out of listings anyway). Logged as `trash { trashed, failed, cancelled }`.

**Map consent** (`galleryMapConsent`): `answer = readMapConsent(settings.json)` at start (boolean or null). `onChange(answer === true)` feeds the shell's request guard variable `mapsOnline`. `set-map-consent` updates `answer` and the guard immediately (even if the file cannot be written; the failure is logged as `could not save the map setting`), then persists `mapsOnline`.

**Edit saving** (`galleryEditActions`; rules in `editActions.ts`):
- `get/set-edit-target`: setting `editTarget` (`'info'` default or `'file'`); persisted in `settings.json`.
- One save per photo at a time: a second save of the same path answers `{ ok:false, error:'That photo is already being saved.' }`.
- **Save to file** (`saveToFile`): path must be in file-check, else `That photo is not in the open folder any more.` Formats that cannot be written (`capabilities.editInPlace === false`, i.e. HEIC) answer `<label> photos can only be saved as a copy.` Steps: (1) render the edit to a temp file in the data folder (`POST /api/gallery/edit/render`); if the server's reported `format` differs from `editFormatFor(path)` delete the temp and answer "Photo Tool wrote the edited photo in an unexpected format, so nothing was changed."; render errors answer `Couldn't make the edited photo: <reason>`. (2) Move the original to the Recycle Bin (`shell.trashItem`); failing, delete the temp and answer `Couldn't move the original to the Recycle Bin, so nothing was changed: <reason>`. (3) Move the temp onto the original path with retries: `MOVE_TRIES = 3` attempts, `MOVE_RETRY_MS = 200` apart, retried only for errno `EBUSY`, `EPERM`, `EACCES` (OneDrive, antivirus or a viewer holding the file on Windows). The move itself is `rename`, and on `EXDEV` (another drive) it copies to `<target>.<pid>-<ms>.part`, renames that into place (removing the `.part` on failure) and unlinks the source (a leftover source is only a stray temp; the server sweeps its edits folder). If step 3 fails the original is in the Recycle Bin and the edited file stays at the temp path (kept about an hour); the error says so and tells the user to restore the original or copy the temp file. (4) `PATCH /api/gallery/info { path, patch: { edit: null } }` to clear the saved edit; failing gives `{ ok:false, saved:true, error:'The photo was saved, but its old edit could not be cleared from the photo info: ...' }`. (5) `POST /api/gallery/refresh { paths:[path] }`; success gives `{ ok:true, item: <first item> }`; failing gives `{ ok:false, saved:true, error:'The photo was saved, but Photo Tool could not read it again: ...' }`.
- **Save as** (`saveAs`): file-check as above. Default name `<dir>/<name>-edited<ext>` (a copy-only format such as HEIC uses the written format's extension). A save dialog (`Save the edited photo as`; one filter `<format label> photo` with that format's extensions; dialog asks before replacing) returns the chosen path; cancel gives `{ ok:false, cancelled:true }`. The chosen name's extension is forced to fit the written format (`.jpg`, `.png` or `.webp`; a chosen `.jpeg` for JPEG is kept). A target equal to the original (case-insensitive on Windows) answers `Choose a different name: Save as keeps the original.` If the extension was changed (the dialog did not confirm that name) and a file already exists there: `A file with that name already exists. Choose another name.` Then render (same format check), move with the same retry rule (failing: delete the temp, `Couldn't save the copy: <reason>`), then refresh the target; a refresh failure answers `{ ok:false, saved:true, savedPath, error:'The copy was saved as <path>, but Photo Tool could not read it: ...' }`. If the server returns no item the copy is outside the open folder: `{ ok:true, savedPath }`. Otherwise `PATCH /api/gallery/info` on the copy with `copyablePatch(info)`: always `edit: null`, plus whichever of `star`, `people`, `date`, `location`, `description`, `notes` the page supplied (not `undefined`); failing gives `{ ok:false, saved:true, savedPath, error:'The copy was saved as <path>, but its star, people, date, location, description and notes could not be copied to it: ...' }`; success gives `{ ok:true, savedPath, item }`.
- **Unsaved edits.** The page reports a count with `setUnsavedEdits` (floored, at least 0; kept per window id; zero removes the entry; reset on a main-frame navigation or window destroy). Closing or reloading the window while the page's own `beforeunload` question stops it triggers `will-prevent-unload`; main then asks (below) and lets the page go (`preventDefault()`) when the answer is "Close without saving" or the close was pre-confirmed. `confirmQuit()` (File > Quit and before an update install, which skip `beforeunload`) asks the same question when the count is above 0. The question is a native `warning` box with buttons `Close without saving` and `Keep editing` (default and cancel = Keep editing), message `<n> photo has edits that are not saved.` / `<n> photos have edits that are not saved.`, detail `Closing now throws those edits away.` `allowClose(true)` (set while the shell closes the window for an update install, after the question was already answered) suppresses a second question.

### 9. The network guard (`netGuard`) and hardened session

The offline guarantee is code. The window may load only from the app's own local server.

`isAllowedRequest(url, { ports, devTools })`:

| Scheme | Allowed when |
| --- | --- |
| `http:` / `ws:` | hostname is exactly `127.0.0.1` and the port (default 80) is in `ports` (the server's port; in development also the Vite port) |
| `blob:` | the embedded origin (`blob:http://127.0.0.1:1234/<id>`) is itself allowed |
| `data:` | always |
| `about:` | only `about:blank` and `about:srcdoc` |
| `devtools:` | only when `devTools` (= not packaged) |
| anything else (`https`, `wss`, `ftp`, `file`) | never |

Unparseable URLs are refused. `isAppNavigation(url, appOrigin)`: protocol `http:`/`https:` and same origin as the app. Navigation (`will-navigate`) and redirects (`will-redirect`) elsewhere are `preventDefault`ed, tallied and logged (`blocked navigation|redirect <url>`).

**Photo Tool's one extension**: `galleryRequestAllowed = isAllowedRequest || (mapsAllowed && isMapTileRequest)`. `isMapTileRequest(url, method)` requires method `GET`; no `?` or `#` anywhere in the URL; protocol `https:`, host exactly `tile.openstreetmap.org`, default port, no user name or password; and the path matching `^/\d{1,2}/\d{1,7}/\d{1,7}\.png$` (zoom/column/row). `mapsAllowed = mapsOnline && !selfTest`, where `mapsOnline` is the saved answer to "Load maps from the internet?".

**Request header rewriting** (`sendHeaders`): for `https://tile.openstreetmap.org/*`, `onBeforeSendHeaders` cancels anything that is not a valid tile request, and otherwise sends only `Accept` (as Chromium wrote it) and `User-Agent: PhotoTool/<app version>`. Accept-Language, Sec-CH-UA and other Sec-* headers, Referer, Cookie and Origin are dropped (OpenStreetMap's tile policy; Chromium still adds Host, Connection and Accept-Encoding).

**Chromium host resolver rules** (`hostResolverRules(lookups)`), as set by `--host-resolver-rules`: `MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE tile.openstreetmap.org, EXCLUDE github.com, EXCLUDE api.github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com`. So no DNS name is ever resolved except those. Without this rule Chromium looked up `redirector.gvt1.com` for spell-check dictionaries at every start. GitHub's names are for the updater alone: its requests do not pass through the window session's guard.

**Session hardening** (`hardenSession`, on `session.defaultSession`): spell-checker off; `setProxy({ mode: 'direct' })`; permission request handler denies everything (and tallies), permission check handler and device permission handler deny; a single `webRequest.onBeforeRequest` cancels every request not allowed by `requestAllowed` (tallied per host in `requestsByHost`, cancelled URLs logged as `cancelled request <url>`).

**Hugging Face model downloads.** These are made by the server utility process (Node `fetch` in `photo-tool/server/models/download.ts`), not by Chromium, so neither the request guard nor the host-resolver rules apply to them. The server limits them itself (https, default port, no user info, host `huggingface.co` or under `.huggingface.co` or `.hf.co`, files checked against the catalogue). Documented here only because About lists them.

There is deliberately no crash reporter and no `update-electron-app` (a test forbids `crashReporter` and `update-electron-app` in Photo Tool's electron files).

### 10. Update checking

Implementation: `electron-updater` 6.8.12 driven by a controller (`shared/electron/updates.ts`) with pure rules in `updateRules.ts`. The controller takes the updater as a parameter, so it is tested with a fake. Updates work only in the installed (packaged) program, and never in a self-test (no updater is even created there).

**Feed and channel.** Releases of the GitHub repository from `product.json` (`funvill/photo-tool`). `updater.channel = 'photo-tool'`, so the update files are `photo-tool.yml` (Windows) and `photo-tool-linux.yml` (Linux); each lists the installer(s) and their sha512. `resources/app-update.yml` (written by electron-builder from the `publish` block: provider `github`, channel `photo-tool`) points the installed app at the repository. Only the program's own channel is read, so Photo Tool and the editor can never install each other.

**Testing feed.** `PHOTO_TOOL_UPDATE_FEED=<url>` makes the updater use `{ provider: 'generic', url, channel: 'photo-tool' }` (an address such as `http://127.0.0.1:5650/` serving a folder containing `photo-tool.yml` and the installer). It is logged (`update feed <url>`). Testing only. Updater set-up failures (for example a malformed feed) are caught: logged as `updates are off: the updater could not be set up ...` and the menu simply lacks update items; they never block start-up.

**Updater settings** (`createUpdates`): `autoDownload = false`, `autoInstallOnAppQuit = false`, `allowDowngrade = false` (electron-updater would otherwise switch downgrade on when a channel is set; an older release is never offered), `disableDifferentialDownload = true` (the whole installer is always downloaded; no block maps are published).

**Privacy.**
- Only these hosts are looked up (`UPDATE_HOSTS`): `github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`.
- electron-updater normally makes a random per-install id (`<userData>/.updaterId`) and sends it as `x-user-staging-id` with every check. Photo Tool never makes it: `requestHeaders['x-user-staging-id']` is set to the all-zero id `00000000-0000-0000-0000-000000000000` (`NO_STAGING_ID`) for everyone, `isUserWithinRollout` is replaced by a function returning true, and `stagingUserIdPromise` is replaced with a resolved promise of the zeros. Releases are never staged.
- Nothing about the user or install is sent. The check is logged only as `update check ...` lines.
- The updater logger writes `[updater]`, `[updater warn]`, `[updater error]` lines into `desktop.log` (debug dropped).

**When it checks.**
- **At start (quiet):** 5 seconds after the page has loaded (`setTimeout(..., 5000)`), `checkAtStart` runs `shouldCheckAtStart`: all of packaged, not a self-test, `PHOTO_TOOL_NO_UPDATE_CHECK` unset (any non-empty value disables; an empty string does not), `settings.auto === true`, and `lastCheck` is `null`, or later than now (clock turned back), or at least `CHECK_INTERVAL_MS = 86_400_000` (24 h) ago. A skip is logged `update check at start skipped`. There is no timer for later checks while the program stays open: at most one automatic check per start. A failure is logged and never shown. If an update is found (and is not the version already downloaded) the Download offer is shown.
- **Manual:** Help > Check for updates… or the About box's Check for updates button. Always shows a result. Not packaged: message `Updates only work in the installed Photo Tool.` The manual check ignores both the setting and the env variable.
- `lastCheck` (ms since epoch) is saved to `updates.json` after any check that got an answer, including "no release published yet".
- One check, one offer, one download and one install question at a time; a second request joins the one in flight. A manual check while a download, offer or install question is open does nothing; if an update is already downloaded and waiting, it re-offers the install.

**Outcome rules.**
- `isNoRelease(error)` means "up to date", not an error: electron-updater codes `ERR_UPDATER_NO_PUBLISHED_VERSIONS` or `ERR_XML_MISSED_ELEMENT` whose message starts `No published versions on GitHub`; an `HttpError` named error with status 404; `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` or `ERR_UPDATER_INVALID_RELEASE_FEED` whose message matches `Unable to find latest version on GitHub (...), please ensure a production release exists: HttpError: 404`. `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` (a release without `photo-tool.yml`) is a failure, not "up to date". Draft releases are invisible to the updater.
- Failure text: `Could not check for updates: <first non-empty line of the error, trimmed, at most 300 characters>`.

**Dialogs (all native message boxes with the app name as title; `defaultId` 0).**

| Moment | Message | Buttons |
| --- | --- | --- |
| Update found | `Photo Tool <latest> is available (you have <current>).` | `Download`, `Release notes` (only when the repository is known; opens `https://github.com/<owner>/<repo>/releases/tag/v<version>` in the browser and asks again), `Later` |
| Up to date (manual) | `You have the newest version of Photo Tool (<current>).` | `OK` |
| Download failed | `The update did not download: <reason>` | `Try again`, `Close` |
| Downloaded | `Photo Tool <version> is ready to install. The app will close and restart.` | `Restart now`, `Later` |
| Not installable | `Photo Tool cannot install this update by itself: <problem> Download it from the release page and install it from there.` | `Open the release page` (`https://github.com/<owner>/<repo>/releases/latest`), `Close` |
| Still saving | `Your latest changes are still being saved. Try again in a moment.` | `OK` |
| Install failed after closing | `The update did not install: <reason>\n\nPhoto Tool will start again. You can download the update from the release page.` | `Open the release page`, `OK` |

**Download.** Choosing Download starts `downloadUpdate()`. Progress sets the taskbar progress bar (`win.setProgressBar(percent/100)`, `-1` to clear) and the first Help item reads `Downloading update… N %` (disabled; menu rebuilt each time the rounded percent changes). When done, the version is remembered as `ready` (so Later keeps it; the first Help item then reads `Install update <version>…`), and the Restart now / Later question is shown.

**Restart now: `prepareInstall`** (nothing is closed until the checks pass):
1. `installProblem(...)`: the downloaded files must still exist (`the downloaded update is gone.`); AppImage: `$APPIMAGE` must exist and its folder be writable (`it cannot write to <folder>.`); `.deb` (Linux, non-AppImage): a graphical sudo must exist (first found in `gksudo`, `kdesudo`, `pkexec`, `beesu` on `PATH`; else `there is no graphical way to ask for the administrator password (pkexec).`). A problem shows the "cannot install" box with the release-page offer and returns false.
2. `.deb` with `pkexec` and not root: run `pkexec --disable-internal-agent dpkg --version` once (5 minute timeout) to learn that a password prompt can really appear. Exit 0 means ok; 126 means the user dismissed the prompt (call the install off silently); any other code or not running means `it cannot ask for the administrator password (pkexec found no way to ask, or was refused).` This asks for the password once before closing; the install asks again.
3. `program.confirmQuit()` (the unsaved-edits question, asked once; Keep editing calls the install off).
4. Set `installing = true` (so closing the window does not quit the app) and `allowClose(true)`; call `win.close()` every second for up to 10 s until the window is gone (the page may cancel the first close to finish a pending save); `allowClose(false)`. If the window is still there: `installing = false`, show "still saving", return false.
5. Set `quitting = true` (so the server's exit is not a crash), `stopServer()`.
6. Arm a 30 s backstop (`app.exit` if still running).

Then `updater.quitAndInstall(true, true)` (silent install, run after finish; Linux ignores the first flag). Install per platform: Windows runs the NSIS installer silently as the current user (no elevation) and restarts the program; Linux `.deb` installs with `dpkg` through the graphical sudo; Linux AppImage deletes the old AppImage and moves the new file into place, then starts it. Failure detection: an `error` event or exception during `quitAndInstall`, or electron-updater's `quitAndInstallCalled` false afterwards. On failure `installFailed`: clear the backstop, log, show the "did not install" box, then `app.relaunch()` (an AppImage relaunches from its own file, `relaunchOptions`, because its mount disappears at exit) and `app.exit(exitCode)`.

**Which updater.** `updaterKind`: on Linux with `APPIMAGE` set use `AppImageUpdater` directly (never the `autoUpdater` getter, which would choose by `resources/package-type`: the AppImage may carry `deb` there since both Linux packages are built from one folder). If `APPDIR` is also set, the program's `execPath` must be inside it, otherwise it is a `.deb` install launched from another AppImage that inherited the variables, and the default updater is used (AppImageUpdater's install deletes `$APPIMAGE`, so this matters). Otherwise `autoUpdater`.

**Opt-out.** Help > Check for updates automatically (checkbox, persisted as `auto` in `updates.json`), or `PHOTO_TOOL_NO_UPDATE_CHECK`. Both stop only the quiet check at start.

### 11. Logs

- File: `<dataDir>/logs/desktop.log`. If that folder cannot be created or written, `<os temp>/Photo Tool logs/desktop.log`; if neither works, logging is silently off.
- Rotation: when `desktop.log` is larger than 2,000,000 bytes at the time the log is first opened in a run, it is renamed to `desktop.previous.log` (replacing an older one). No rotation during a run.
- Line format: `[<ISO-8601 UTC timestamp>] <items joined by a space>`; non-string items are `JSON.stringify`ed. Appended with `appendFileSync`; write errors (full disk) are swallowed. Lines are also written to the console when not packaged or in a self-test.
- Contents: the start line (version, `packaged`, folders, `carriedOver` result, resource root, dev URL, self-test flag); `asking the server for port <{port, fallbackToAny}>`; `server ready`; the server's `[server out]` / `[server err]` output; `server exited { code, quitting }`; page console messages at level error or warning as `[page error|warning] <message>`; `failed load`; `page process gone`; `cancelled request <url>`; `blocked navigation|redirect <url>`; `denied new window <url>`; `gallery: open folder <path>`; `drag { files }` and drag check errors; `trash { trashed, failed, cancelled }`; `copy text failed` / `copy image failed` / `show in folder failed`; `maps online <bool>`; `edit target <value>`; `save edit to file { ok }` / `save edit as { ok }` and their failures; update lines (`update feed`, `update check ...`, `update downloaded <version>`, `installing update <version>`, `update install called off`, `the update cannot be installed ...`, `pkexec before installing ...`, updater lines); `FATAL <phase> <title>` followed by the technical block; `main uncaughtException` and `main unhandledRejection` with stacks; `self-test <step> <result>` and `self-test finished { ok }`.
- The log never contains photo content, but it does contain folder paths and file paths named in the lines above.

### 12. Crash handling

There is no crash reporter and nothing is uploaded. Failures are always a message, never a blank window.

- **Main process** `uncaughtException` / `unhandledRejection`: logged only.
- **Server utility process**: an uncaught exception prints and exits with code 1; the main process sees the exit. If the server had not yet reported ready, start fails with `The local server stopped while starting (exit code <n>).` plus the captured output. If it exits after ready and the app is not quitting, `fatal('run', 'The local server stopped unexpectedly (exit code <n>).\n<output>')`.
- **Renderer**: `render-process-gone` with a reason other than `clean-exit` while not quitting gives `fatal('page', "Photo Tool's page process ended: <reason> (exit code <n>).")`. A main-frame `did-fail-load` (error code -3, aborted, ignored) gives `fatal('page', "Photo Tool's page did not load: <description> (<code>)\n<url>")` (not in a self-test).
- **`fatal(phase, detail)`** (once only; ignored while quitting): logs `FATAL`; in a self-test it records `startupFailure` and finishes the self-test instead of showing a box. Otherwise shows an `error` message box (modal to the window if visible) with `message = <message>\n\n<advice>` and `detail` = the first 2500 characters of a technical block (`Photo Tool <version> (<platform> <arch>, Electron <v>)`, `Data folder: ...`, `Log file: ...`, blank line, the detail). Buttons: for phase `start`: `Close`, `Copy details`, `Open the log folder`; for `run` and `page`: `Restart`, `Close`, `Copy details`, `Open the log folder`. Copy details puts the technical block on the clipboard and the box returns; Open the log folder opens the log's folder and the box returns; Restart calls `app.relaunch()`; Close or Restart ends with exit code 1 and `app.quit()`.
- **Wording** (`describeFailure`; Photo Tool says "gallery" and not "book"). Phase `run`: title `Photo Tool stopped working`; message `The part of Photo Tool that reads your photos stopped unexpectedly. Stars and notes up to your last change are saved.`; advice `Restart Photo Tool. If this keeps happening, send the details below to the person who gave you the app.` Phase `page`: title `Photo Tool could not show the gallery`; message `Photo Tool started, but its window could not load.`; advice `Restart Photo Tool. If this keeps happening, reinstall it.` Phase `start` (title `Photo Tool could not start`) chooses by the detail text, first match wins: `App files are missing|MODULE_NOT_FOUND|Cannot find module` gives "Some of Photo Tool's own files are missing or damaged." / "Reinstall Photo Tool."; `EACCES|EPERM|EROFS|ENOSPC|ENOTDIR|ENOENT|read-?only|unable to open database|SQLITE_(CANTOPEN|READONLY|FULL|IOERR)` gives "Photo Tool could not save to its data folder:\n<dataDir>" / "Check that the disk is not full and that you are allowed to save files in that folder, then start the app again."; `SQLITE_BUSY|database is locked` gives "Another program is using Photo Tool's library." / "Close other copies of Photo Tool, then start it again."; `sharp|ERR_DLOPEN_FAILED|\.node\b|libvips` gives "A part of Photo Tool that reads photos could not be loaded." / "Reinstall Photo Tool. If that does not help, send the details below to the person who gave you the app."; otherwise "Photo Tool ran into a problem while starting." / "Start it again. If this keeps happening, reinstall Photo Tool or send the details below to the person who gave you the app."
- **Server shutdown** is orderly: on quit the main process sends `stop` and waits up to 5 s for the server to exit before killing it, so the SQLite catalogue is closed properly.

### 13. The desktop self-test

An acceptance test built into the program, run only with both flags (`parseSelfTest`; both values must be present and not start with `--`):

```
"Photo Tool" --self-test <photo folder> --self-test-out <folder>
```

Behaviour changes in a self-test: data, profile and shared photo info all live under `<out>` (section 7); any free port is used and not remembered; no updater is created and no start check runs; map tiles are never allowed; the window is never shown (screenshots fall back to `showInactive()` if the capture is empty); `window-all-closed` and `before-quit` do not interfere; fatal errors are recorded not shown; a 15-minute watchdog applies. The photos given are never written: `prepareGalleryPhotos` deletes `<out>/photos`, snapshots the source (relative path to `size:mtimeMs`), and copies the source recursively to `<out>/photos`; the program opens that copy as if it were given on the command line.

Steps (`result.steps`, each `{ ok, ms, error?, ... }`; a thrown error is recorded as `ok:false` with the stack; polling interval 500 ms):

| Step | What it checks |
| --- | --- |
| `health` | `GET /api/health` returns `{ ok: true, app: 'gallery' }`. |
| `openFolder` | within 120 s the top bar's `.gallery-bar-title .gallery-root` text equals the copy's path, no `.gallery-progress` element, at least one `.gallery-tile`, every tile image loaded (`complete`, `naturalWidth > 0`), and no `.toast-error`; screenshot `gallery.png`. |
| `starInViewer` | picks the first tile without class `starred`, double-clicks it, waits up to 10 s for `.gallery-viewer` whose `.gallery-viewer-bar strong` equals the file name; dispatches a `keydown` `s`; waits up to 10 s for `.gallery-viewer-starred`; waits up to 10 s for `photoinfo.json` beside the photo to have `photos[<file name>].star === true` and `format === 'photoinfo/1'`, inside the copy; screenshot `gallery-viewer.png`; `Escape` closes the viewer and the tile is `starred`. |
| `sourceUntouched` | the source folder snapshot is unchanged and a photo was starred. |
| `taggingWorkerLoads` | starts `tagging-worker.cjs` (the unpacked copy when installed) as a `worker_threads` Worker, sends `{ type: 'ping' }`, expects `{ type: 'pong', ort }` with `ort` matching `^\d+\.\d+\.\d+` (onnxruntime-node loaded; no model, no download), within 30 s. |
| `filterControl` | `session.fetch('http://127.0.0.1:9/self-test-control')` must fail with `ERR_BLOCKED_BY_CLIENT` (the guard blocked a local port that is not the app's). |
| `navigationBlocked` | setting `location.href` to `http://127.0.0.1:9/self-test-navigation` leaves the window's URL unchanged after 800 ms. |

Overall `ok` is true only when all of these hold: the program is not packaged, or it has both `LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` in its resource folder; no startup failure; at least one step and every step ok; zero console `error` messages; zero failed loads; zero cancelled requests other than the two control URLs; zero requests to any host other than `127.0.0.1:<own port>` (plus `blob:` of it, `data:`, and `127.0.0.1:9`); and the server stopped cleanly. The server is stopped before the verdict.

`<out>/result.json` (pretty-printed) holds: `ok`, `finishedAt`, `app` (`name, version, packaged, execPath, electron, chrome, node, platform, arch`), `folders` (`dataDir, profileDir, photoInfoFallbackDir, resourceRoot, logFile`), `about` (the About box content plus `licenceFile`, `noticesFile`, `noticesBytes`), `photos`, `startupFailure`, `steps`, `serverStoppedCleanly`, `consoleErrors` (count), `consoleMessages` (max 500), `failedLoads`, `cancelledRequests`, `controlRequestsCancelled`, `blockedNavigations`, `deniedPermissions`, `requestsByHost`, `requestsToOtherHosts`. Each of the recorded lists keeps at most 500 entries. The process exits `0` when `ok`, else `1`. Screenshots `gallery.png` and `gallery-viewer.png` land in `<out>`.

### 14. Packaging

**Build pipeline** (`npm run dist:photo-tool` = `desktop:build:photo-tool` then electron-builder):
1. `npm run build:photo-tool`: `tsc --noEmit` then `vite build --config photo-tool/vite.config.ts` into `dist/photo-tool/web` (root `photo-tool/web`, `base '/'`, target `es2022`, no public dir, `__APP_VERSION__` defined from the root `package.json` version for the top bar).
2. `node scripts/desktop/ensure-electron.mjs`: Electron 45 does not download its program at `npm install`; this fetches it once (runs `node_modules/electron/install.js` if `path.txt` or the executable is missing; errors if still missing). This is the only download, on the build machine.
3. `node scripts/desktop/build.mjs --program photo-tool` (table of programs in `scripts/desktop/programs.mjs`):
   - esbuild (0.28.2), options `{ bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: false, legalComments: 'none' }`, output in `dist/photo-tool/desktop/app/`:
     - `main.cjs` from `photo-tool/electron/main.ts`, external `electron`.
     - `server-host.cjs` from `photo-tool/electron/server-host.ts`, external `electron`, `sharp`, `@huggingface/transformers`.
     - `tagging-worker.cjs` from `photo-tool/server/tagging/worker.ts`, external `@huggingface/transformers`.
     - `preload.cjs` from `photo-tool/electron/preload.ts` with `platform: 'browser'` (the sandboxed preload may require only `electron`), external `electron`.
   - `app/package.json` is written: `name: 'photo-tool'`, `productName`, `version` (root package version), `description`, `author` (the maintainer), `repository`, `desktopName: 'photo-tool.desktop'` (the window class on Linux, tying it to the launcher entry), `license`, `private: true`, `main: 'main.cjs'`, `dependencies` of the external modules at their installed versions (electron-builder packs only what this list leads to). No `type` field (the bundles are CommonJS).
   - Run-time modules are copied (`runtimeModules`): the external packages and everything they depend on (dependencies and installed optional dependencies, found the way Node would), each copied into `app/node_modules/...` without nested `node_modules` (needed nested ones are in the list themselves). `onnxruntime-web` is left out (Transformers.js carries its own web runtime inside its Node build; saves about 140 MB). From `onnxruntime-node`, only `bin/napi-v<N>/<platform>/<arch>` for the build machine is kept (the package carries about 290 MB for all platforms). The build fails if `node_modules/onnxruntime-node/bin/napi-v6/<platform>/<arch>` is missing, or if no `@img/sharp-<platform>` binary is installed (run `npm install` on the target platform).
   - Linux only, sharp mode `PHOTOBOOK_LINUX_SHARP`: `shim` (default) patches the copied sharp binary (`scripts/desktop/linux/patch-sharp.mjs`: compiles `libsharp-glib-shim.so` with gcc, renames the binding's seven glib imports `g_free, g_malloc, g_object_ref, g_object_unref, g_log_set_handler, g_signal_connect_data, g_utf8_validate` to `q_...` and links the shim, using patchelf) because inside Electron sharp's glib calls reach the system glib and memory is never returned; `wasm` ships sharp's WebAssembly build (`@img/sharp-wasm32`, fetched checksum-verified by `ensure-sharp-wasm.mjs`) and omits the Linux native sharp packages; `native` is untouched (not for release). Any other value throws.
   - `scripts/collect-resources.ts <out>/resources --program photo-tool` builds the resource folder (`dist/photo-tool/desktop/resources/`): `web/` (copy of `dist/photo-tool/web`), `world-atlas/countries-10m.json`, `libheif/` (`libheif-bundle.js`, its `LICENSE`, `LICENSE.libheif-js`, and a `package.json` containing `{ "type": "commonjs" }` so Node does not treat the bundle as an ES module under a `"type": "module"` project), `LICENSE.txt` (the repository `LICENSE`), `THIRD-PARTY-NOTICES.txt`. No fonts, no PDFium. It aborts listing missing inputs.
   - Notices (`scripts/make-notices.ts`): licence text of every package the program ships (its entry files' imports via `scripts/import-graph.ts` plus resource packages `world-atlas`, `libheif-js`), their dependencies, installed optional packages (sharp binaries), the Electron runtime, and libraries compiled into the binary engines (libvips inside sharp, libheif with libde265). Read offline from `node_modules`; a missing text is listed as "missing, needs adding by hand" (supply it as `scripts/notices/<name>.txt`, `/` written as `+`); `--strict` makes missing texts exit 1. `onnxruntime-web` and `@napi-rs/canvas*` are marked not shipped.
   - Icon: `scripts/launcher/make-icon.ts` draws a 1024 px PNG (Photo Tool: a blue tile with a grid of photo tiles and a star; the editor is a warm tile) to `dist/photo-tool/desktop/icon.png`, copied to `resources/icon.png`; sharp resizes it to `icons/{16,24,32,48,64,128,256,512}x<same>.png` for Linux launchers (the hicolor theme has no 1024 px folder).
   - `--dev` builds only the four bundles plus `package.json` into `dist/photo-tool/desktop/dev` (run from the project's own `node_modules`).
4. `electron-builder --config photo-tool/electron-builder.config.cjs --publish never` (26.18.0). `--publish never` still writes the update files. `dist:dir:photo-tool` adds `--dir` (unpacked folder, no installer).

**`photo-tool/electron-builder.config.cjs`:**

| Key | Value |
| --- | --- |
| `appId` | `product.appId` |
| `productName` | Windows: `Photo Tool`; Linux: `photo-tool` (the name is also `/opt/<name>`, and Chromium's setuid sandbox fallback cuts a path at a space) |
| `directories` | `app: dist/photo-tool/desktop/app`, `output: dist/installer/photo-tool`, `buildResources: dist/photo-tool/desktop` |
| `electronDist` / `electronVersion` | `node_modules/electron/dist` / read from `node_modules/electron/package.json` |
| `files` | `**/*` minus `*.map`, `*.d.ts`, `*.d.cts`, `*.d.mts`, `*.md`, `*.ts` |
| `asar` | `true` |
| `asarUnpack` | `node_modules/**` and `tagging-worker.cjs` (sharp and onnxruntime-node and their DLLs/shared libraries only load from real files; the tagging worker thread starts from a real file and Node resolves its `require`s on the real disk, so every module it reaches must be unpacked: all of the small node_modules is unpacked rather than a list that could silently miss one) |
| `npmRebuild`, `nodeGypRebuild` | `false` (modules already prebuilt for this platform) |
| `extraResources` | `dist/photo-tool/desktop/resources` copied to `resources/assets` (so `resourceRoot` in a packaged app is `process.resourcesPath/assets`) |
| `electronLanguages` | `['en-US']` |
| `publish` | `{ provider: 'github', owner, repo, channel: 'photo-tool', releaseType: 'draft' }` (owner/repo parsed from `product.repository`) |
| `afterPack` | removes `resources/default_app.asar` (Electron's demo app) |
| `icon` | `dist/photo-tool/desktop/icon.png` |
| `win.target` | NSIS, x64 |
| `nsis` | `oneClick: true`, `perMachine: false`, `allowElevation: false`, `createDesktopShortcut: true`, `createStartMenuShortcut: true`, `runAfterFinish: true`, `deleteAppDataOnUninstall: false`, `packElevateHelper: false`, `differentialPackage: false`, `include: 'photo-tool/electron/installer.nsh'`, `artifactName: '${productName} Setup ${version}.${ext}'` |
| `linux.target` | `deb` and `AppImage`, x64 |
| `linux` | `category: Graphics`, `desktop.entry.Name: 'Photo Tool'` (name in menus), `synopsis` = description, `maintainer`, `syncDesktopName: true` (the `.desktop` file is named after `desktopName`), `artifactName: '${name}-${version}-${arch}.${ext}'`, `icon: dist/photo-tool/desktop/icons` |
| `deb` | `packageCategory: graphics`; `depends: libgtk-3-0, libnss3, libgbm1, libasound2, libatspi2.0-0, libcups2, libxkbcommon0, xdg-utils` (what the program links against, so `dpkg -i` with no network succeeds; `xdg-utils` opens the data folder and shows a photo in its folder); `recommends: []` (the default `libappindicator3-1` no longer exists in current Ubuntu or Debian and the app has no tray icon) |
| `toolsets.appimage` (Linux only) | `PHOTOBOOK_APPIMAGE_TOOLSET` or `'1.0.3'` (electron-builder's newer static runtime, mounts with fuse3; `0.0.0` builds the old way) |

**File names produced** (version V from the root `package.json`):
- Windows: `dist/installer/photo-tool/Photo Tool Setup V.exe`, `dist/installer/photo-tool/win-unpacked/Photo Tool.exe`, update file `photo-tool.yml`.
- Linux: `photo-tool-V-amd64.deb`, `photo-tool-V-x86_64.AppImage`, update file `photo-tool-linux.yml`. The `.deb`'s package name is `photo-tool`; it installs to `/opt/photo-tool/photo-tool`, the command `photo-tool` resolves to it, and `/usr/share/applications/photo-tool.desktop` exists.
- GitHub release assets have no spaces: `Photo-Tool-Setup-V.exe`. Each update file names its installers that way; `scripts/release/collect-assets.mjs` copies each installer under the name the yml gives (found by sha512).

**Windows installer extra step** (`photo-tool/electron/installer.nsh`): electron-builder keeps a full copy of the installer in `%LOCALAPPDATA%\<name>-updater` as the base for differential downloads, and its uninstaller never removes it. Photo Tool always downloads the whole installer, so macro `removeInstallerCopy` (`Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"` and `RMDir` of its parent, which succeeds only if empty so a pending update download is left alone) runs from `customInstall` and `customUnInstall`. Exactly those three macros exist; no shortcuts, no taskbar ids, no `$APPDATA` or user-data deletion. electron-builder's own shortcuts carry the AppUserModelID = `appId`. Uninstalling leaves user data. The installer is not code-signed (SmartScreen warns).

**Licence notices in the package:** `resources/assets/LICENSE.txt` and `resources/assets/THIRD-PARTY-NOTICES.txt` (opened from Help > About; a packaged self-test fails if either is missing).

**Dev and test scripts for the desktop program:**

| Script | Effect |
| --- | --- |
| `npm run dev:photo-tool` | server (`tsx watch photo-tool/server/main.ts`, port `PHOTO_TOOL_PORT` 5176) and Vite (port `PHOTO_TOOL_WEB_PORT` 5175, proxying `/api/` to 5176) in a browser, no Electron |
| `npm run dev:desktop:photo-tool [-- <folder>]` | `scripts/desktop/dev.mjs --program photo-tool`: moves old `./data` layout once; `ensureElectron()`; builds the dev bundles; starts Vite; waits up to 30 s (120 x 250 ms) for its port; starts Electron on `dist/photo-tool/desktop/dev` with env `PHOTO_TOOL_WEB_PORT`, `PHOTO_TOOL_PORT`, `PHOTO_TOOL_DATA_DIR` (default `./data/photo-tool`, or `<PROFILE_DIR>-data`), `PHOTO_TOOL_PROFILE_DIR` (default `./data/photo-tool-browser`), `PHOTOINFO_FALLBACK_DIR` (default `./data/photoinfo-shared`), `PHOTO_TOOL_DESKTOP_DEV_URL=http://127.0.0.1:<webPort>/`, `ELECTRON_RUN_AS_NODE` removed; arguments after `--` go to the app. Kills both when either exits. |
| `npm run start:photo-tool` | `electron dist/photo-tool/desktop/app` (the packaged-layout folder, run unpacked; uses " Dev" folders) |
| `node scripts/desktop/linux/docker-build.mjs` | builds Linux packages in Docker (`build-in-container.sh`: `npm ci` then `npm run dist:all` inside the container) |
| `node scripts/desktop/linux/docker-test.mjs` | installs and self-tests the Linux packages with `--network none` on Ubuntu 24.04 and 22.04, Debian 12 (deb and AppImage) and Fedora (AppImage), optional `--userns`, `--suid`, `--fuse`; evidence in `<work>/test/<program>-<distro>-<mode>/` |

### 15. CI workflows

`.github/workflows/test.yml` (name "Tests"): triggers `pull_request` and `push` to `main`. One job `test` on a matrix of `windows-latest` and `ubuntu-latest` (`fail-fast: false`), Node 26, npm cache. Steps: `npm ci`, `npm run typecheck`, `npm run fixtures`, `npm test` (fast then slow vitest sets), `npm run build:editor && npm run build:photo-tool`. macOS is not tested. Playwright e2e is not run in CI.

`.github/workflows/desktop.yml` (name "Desktop installers"): triggers `workflow_dispatch`, `push` to `main`, and tags `v*`. Both programs are matrix entries (`program`, `dist`, `product`, `old_product`, `env_prefix`, `required_step`); Photo Tool's entry: `dist: dist:photo-tool`, `product: Photo Tool`, `old_product: Photobook Gallery`, `env_prefix: PHOTO_TOOL`, `required_step: taggingWorkerLoads`. Jobs:

1. **`windows`** (`windows-latest`, per program, `fail-fast: false`): checkout, Node 26, `npm ci`, `npm run <dist>`. Verifies `dist\installer\<program>\<product> Setup <version>.exe` and `win-unpacked\<product>.exe` exist. Uploads artifact `<program>-windows-x64` (`*.exe` and `<program>.yml`, error if none). `npm run fixtures`. **Self-test the packaged program**: data, profile and `PHOTOINFO_FALLBACK_DIR` under `$RUNNER_TEMP\selftest`; runs `win-unpacked\Photo Tool.exe --self-test <fixtures\generated\trip> --self-test-out <t>\out`; prints the log and each step; fails if the required step (`taggingWorkerLoads`) is missing or not ok; exit code is the program's. **First start carries the old folder over (real `%APPDATA%`)**: requires a clean runner (none of the old, new, `Photobook Studio`, `Photo Tools Shared` folders exist); creates fake `Photobook Gallery\data\marker.txt` and `Photobook Studio\data\photoinfo\x.json`; sets `PHOTO_TOOLS_CI_SELF_TEST_CARRY_OVER=1`, unsets the data, profile and shared variables; runs the self-test (waits up to 10 minutes); asserts exit 0, old folder gone, `Photo Tool\data\marker.txt` equals `carried`, `Photo Tools Shared\photoinfo\x.json` exists, `Photobook Studio\data\photoinfo` gone, and no unexpected folder matching `photo|electron` appears under `%APPDATA%` besides the product and `Photo Tools Shared`. **Refusal checks**: case `old-program-running` (holds `Photobook Gallery\browser\lockfile` open exclusively; expects `refused.json` step `data`) and case `new-folder-without-data` (a `Photo Tool\browser` stub; expects step `new-folder-without-data` and nothing changed); each expects a non-zero exit within 2 minutes, no `result.json`, the old marker unchanged. Uploads `<program>-windows-self-test` (result.json, PNGs, desktop.log, refused.json) always.
2. **`windows-side-by-side`** (needs `windows`, runs unless cancelled): downloads both `*-windows-x64` artifacts; silent `/S` install of both; checks each registry uninstall entry, the `.exe`, Start-menu and Desktop shortcuts and their AppUserModelID equals the `appId` (`app.phototool.desktop`, `app.photobookeditor.desktop`), that both installed to different folders; self-tests each installed copy; uninstalls the editor (silent) and checks it is gone while Photo Tool still self-tests; then uninstalls Photo Tool and checks everything is gone.
3. **`linux`** (`ubuntu-latest`, per program): `npm ci`; `apt-get install patchelf jq` (patchelf with the runner's gcc is for `patch-sharp.mjs`); `npm run <dist>`; checks `<P>-V-amd64.deb` and `<P>-V-x86_64.AppImage` exist and the deb's `Package` field equals the program name; uploads `<program>-linux-x64` (`*.deb`, `*.AppImage`, `<program>-linux.yml`); `npm run fixtures`; installs the `.deb` with `xvfb` and checks `/opt/<P>/<P>` is executable, the command resolves to it, the `.desktop` file exists; self-test with `xvfb-run -a -s '-screen 0 1600x1000x24'` and verifies `result.json` `app.execPath` is `/opt/<P>/<P>` and the required step ok; self-tests the AppImage with `APPIMAGE_EXTRACT_AND_RUN=1` (no libfuse2 on the runner); first-start carry-over test with `XDG_CONFIG_HOME` pointing at a fresh folder holding fake `Photobook Gallery` and `Photobook Studio` data (same assertions), and a refusal test with a symlink `<old>/browser/SingletonLock -> <hostname>-<pid of the shell>` (expects `refused.json` step `data`, non-zero exit, nothing moved); a check that no `desktop.log` contains `GLib-GObject-CRITICAL` (sharp mixing two copies of glib); uploads `<program>-linux-self-test`.
4. **`release`** (`needs: [windows, linux]`, only when `github.ref` starts with `refs/tags/v` and `github.repository == 'funvill/photo-tool'`; `permissions: contents: write`): checks `package.json` version prefixed with `v` equals the tag; downloads artifacts matching `*-x64` into `in`; runs `node scripts/release/collect-assets.mjs in out` (no npm install needed); verifies `photo-tool.yml`, `photo-tool-linux.yml`, `photobook-editor.yml`, `photobook-editor-linux.yml` exist; creates a **draft** release named after the tag (`gh release create <tag> --draft --verify-tag --title <tag> --generate-notes`) or adds to an existing draft (an already published release is an error); `gh release upload <tag> out/* --clobber`. Publishing the draft is a person's job; until then no installed program is offered the update.

`collect-assets.mjs`: for each yml under the input folder that has a `files:` list (a small line parser reads `- url:` and `sha512:`; builder-debug.yml has none and is skipped), find the installer under the input folder whose base64 sha512 equals the one in the yml and copy it to the output under the `url` name (must be a plain file name with no path and no leading dot, and have a sha512); copy the yml beside. Two different files with one target name, no hash match, or no update file at all each throw.

### 16. Tests

**Vitest** (`vitest` 5): `vitest.config.ts` (the fast set) includes `tests/**/*.test.ts`, `shared/tests/**/*.test.ts`, `photo-tool/tests/**/*.test.ts` and `photobook-editor/tests/**/*.test.ts`, excludes vitest's defaults plus the files listed in `vitest.slow-files.json`, `testTimeout: 60_000`, `hookTimeout: 120_000`. `vitest.slow.config.ts` includes only the slow list, same timeouts.

Slow list (`vitest.slow-files.json`): `photo-tool/tests/gallery-server.test.ts`, `gallery-catalog.test.ts`, `gallery-edit-server.test.ts`, `photo-tool/tests/tagging-worker-ping.test.ts`, `shared/tests/boundaries.test.ts` (includes "photo-tool builds its own page" and the import-boundary rule that neither program imports the other), and for the editor `fonts`, `portable`, `milestone`, `cutouts`, `editor-shell`. A test file not in the list is fast by default (add one only if it takes more than about 10 s). `tests/test-split.test.ts` checks that every listed file exists and is listed once.

| Script | Command |
| --- | --- |
| `npm run test:fast` / `npx vitest run` | fast set (about 900 tests, about 21 s at v0.1.40) |
| `npm run test:slow` | slow set (about 300 tests, about 83 s) |
| `npm test` / `npm run test:all` | fast then slow (CI runs this) |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7) |

Desktop-related test files (evidence for behaviour): `shared/tests/desktop-config.test.ts` (flags, folders, port, window place, failures, About), `shared/tests/desktop-shell.test.ts` (offline filter, sandbox flags, port file, update wiring, F1/F2, menu order), `shared/tests/data-folders.test.ts`, `shared/tests/server-host.test.ts` (`listenWithFallback` for free, busy, EACCES, other error, port 0), `shared/tests/update-rules.test.ts`, `shared/tests/updates.test.ts`, `shared/tests/dev-data.test.ts`, `photo-tool/tests/photo-tool-shell.test.ts` (builder config, resource check, entry-point closure with no editor code, notices, preload channels, names, CSP, built page loads nothing remote), `photo-tool/tests/gallery-map.test.ts`, `gallery-drag.test.ts`, `gallery-file-actions.test.ts`, `gallery-edit-actions.test.ts`, `gallery-edit-settings.test.ts`, `photo-tool/tests/tagging-worker-ping.test.ts`, `tests/desktop-scripts.test.ts` (build scripts and the program table), `tests/release-assets.test.ts`, `tests/import-graph.test.ts`, `tests/test-split.test.ts`.

**Playwright** (`playwright.config.ts`, `@playwright/test` 1.64): runs in the system Chrome (`channel: 'chrome'`), viewport 1440 x 900, `timeout: 120_000`, `workers: 1` (tests share one server). Projects:

| Project | `testDir` | `baseURL` |
| --- | --- | --- |
| `editor` | `photobook-editor/tests/e2e` | `http://127.0.0.1:5185` (`PHOTOBOOK_E2E_PORT`) |
| `photo-tool` | `photo-tool/tests/e2e` (`gallery.spec.ts`) | `http://127.0.0.1:5186` (`PHOTO_TOOL_E2E_PORT`) |

Two `webServer` entries start one after the other, each `reuseExistingServer: false`, `timeout: 120_000`, readiness at `/api/health`. The Photo Tool one empties `PHOTO_TOOL_DATA_DIR` and `PHOTOINFO_FALLBACK_DIR` (with a `node -e rmSync` one-liner that works in cmd.exe and sh), runs `vite build --config photo-tool/vite.config.ts` and `tsx photo-tool/server/main.ts` with env `NODE_ENV=production`, `PHOTO_TOOL_PORT=5186`, `PHOTO_TOOL_DATA_DIR=test-results/e2e-photo-tool`, `PHOTOINFO_FALLBACK_DIR=test-results/e2e-photo-tool-photoinfo`, `PHOTO_TOOL_FAKE_TAGGING=1` (fake models and backend served from memory by `photo-tool/tests/support/fakeTagging.ts`, with 40 ms delays: never the network). The editor's server (port 5185, `test-results/e2e-data`, `test-results/e2e-photoinfo`) is started first. `npm run e2e:photo-tool` = `playwright test --project=photo-tool` (each project starts both servers; about 47 passing tests, about 6 min at v0.1.40). `PHOTO_TOOL_SIDECAR_E2E_PORT` (default 5931) is read by one spec that starts its own extra server.

The Photo Tool e2e tests drive the page in a browser (no Electron): each opens a private copy of `fixtures/generated/trip` in a temp folder via `POST /api/gallery/open {folder, recursive:false}` (expects 202), sets `localStorage` `gallery.gridWidth=900` and `gallery.thumbSize=96` so every tile is on screen, and clicks the recent-folder button.

**Fixtures** (`npm run fixtures` = `tsx scripts/make-fixtures.ts`, deterministic, no personal photos). `npm run fixtures` writes `fixtures/generated/trip` (the folder is deleted and recreated each run); `npm run fixtures -- <N>` writes `fixtures/generated/large-<N>`. Synthetic scenes are SVG (sky gradient from one of 8 palettes, a ridge, water, 60 faint texture lines, a subject circle with a label, and a "TOP" caption to show orientation) rendered by sharp with a seeded PRNG (`mulberry32`). JPEG quality 90. EXIF on JPEGs: `Make = Photobook Fixture`, `Model = Synthetic`, `DateTimeOriginal = 2026:03:<13 + day> HH:MM:00`, GPS latitude `<35 + day>/1 40/1 0/1 N`, longitude `139/1 45/1 0/1 E`. The `trip` has exactly 21 files (landscape 3000 x 2000, portrait 2000 x 3000):

| File(s) | Purpose |
| --- | --- |
| `day1-01-arrival` ... `day1-06-dusk` (6 files, `day1-05-harbour-pano` is 5400 x 2000) | mixed orientations, a panorama |
| `day2-01-trail`, `day2-02-burst-a/b/c`, `day2-03-blurry`, `day2-04-lake`, `day2-05-rotated` | a burst of 3 near-duplicates (b and c share seed 8, subject shifted slightly, 10:00 and 10:01), a blurred frame (blur 14), an EXIF-rotated file (stored rotated 90 degrees with orientation 6) |
| `day3-01-cafe` ... `day3-04-departure` (4 files) | more days |
| `day1-03-market-copy.jpg` | an exact byte duplicate of `day1-03-market.jpg` |
| `day3-05-lowres.jpg` | 640 x 480 low resolution |
| `undated-scan.png` | 2400 x 2400 PNG with no EXIF (undated, no location) |
| `day2-06-heic-sunset.heic` | HEVC HEIC made with `elheif` (libheif + kvazaar as WebAssembly, same on every platform), pixels only: no EXIF date or GPS |

The `large-<N>` set is `IMG_0001.jpg` ... with `i = 0..N-1`: portrait 1200 x 1800 when `i % 3 === 0`, else landscape 1800 x 1200; day `1 + floor(i / 60)`; time `08:00 + (i % 60) * 12` minutes; hue `i`; seed `1000 + i`; label `#<i+1>`; same EXIF scheme.

**Version bump convention.** One version for both programs, in the root `package.json` `version` (read by the build, shown in Photo Tool's top bar via `__APP_VERSION__`, used in installer names and checked against the release tag). Practice in the history: each commit (or merge) bumps the patch number ("chore: version 0.1.43 after merging update-check"; the handoff notes say "bumped once per commit"). To release: bump and commit, tag that commit `v<version>` (for example `v0.1.48`) and push the tag; CI builds, self-tests, and the `release` job creates the draft release; a person edits the generated notes and presses Publish on GitHub, after which installed programs are offered the update.

### 17. Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `PHOTO_TOOL_DATA_DIR` | shell, server `dirs.ts`, `dev.mjs`, e2e | Photo Tool's data folder. Setting it (or the profile one) disables the old-folder carry-over. |
| `PHOTO_TOOL_PROFILE_DIR` | same | Chromium profile folder (`userData`). If only this is set, data goes to `<profile>-data`; if only the data one is set, the profile goes to `<data>-browser`. |
| `PHOTOINFO_FALLBACK_DIR` | shell, server, e2e, CI | Shared photo-info folder. Disables carry-over step 2. |
| `PHOTO_TOOL_PORT` | `serverPortRequest` (development only), standalone server, Vite proxy | Fixed API port (default 5176; in the desktop shell default is the Vite port + 1). Ignored by an installed program. |
| `PHOTO_TOOL_WEB_PORT` | Vite config, standalone server, `dev.mjs` | Vite dev server port (default 5175). |
| `PHOTO_TOOL_DESKTOP_DEV_URL` | shell, only when not packaged | Load the window from this Vite URL; also puts the shell in development mode (fixed ports, no port memory, relaxed guard for the Vite port and devtools). |
| `PHOTO_TOOL_RESOURCE_ROOT` | shell | Overrides the resource folder (default `process.resourcesPath/assets` packaged, `<bundle>/../resources` otherwise, none in development). |
| `PHOTOBOOK_RESOURCE_ROOT` | server `resources.ts` | Fallback resource root for the standalone server and scripts (the shell passes `resourceRoot` explicitly). |
| `PHOTO_TOOL_NO_UPDATE_CHECK` | shell | Any non-empty value stops the quiet check at start. |
| `PHOTO_TOOL_UPDATE_FEED` | shell | Generic update feed URL for testing. |
| `PHOTO_TOOL_FAKE_TAGGING` | standalone server (`main.ts`) | `1` serves fake tagging models from memory (e2e only). |
| `PHOTO_TOOL_E2E_PORT`, `PHOTO_TOOL_SIDECAR_E2E_PORT` | Playwright | e2e server ports (5186; 5931 for the sidecar spec). |
| `PHOTOBOOK_E2E_PORT`, `PHOTOBOOK_E2E_DATA_DIR`, `PHOTOBOOK_E2E_PHOTOINFO_DIR` | Playwright (editor project) | editor e2e server settings. |
| `PHOTOBOOK_TAGGING_MODELS_DIR` | `gallery-tagger-backend.test.ts` | Points the real-model test at downloaded models; the test is skipped when unset. |
| `PHOTO_TOOLS_CI_SELF_TEST_CARRY_OVER` | shell | `1` plus `GITHUB_ACTIONS=true` lets a self-test run the old-folder carry-over (CI only). |
| `NODE_ENV` | standalone server | `production` serves the built page (`--production` flag is the same). |
| `APPIMAGE`, `APPDIR` | shell | Set by the AppImage runtime; decide the updater kind and the AppImage relaunch. |
| `PATH` | shell | Searched for `gksudo`, `kdesudo`, `pkexec`, `beesu`. |
| `PHOTOBOOK_LINUX_SHARP` | build | `shim` (default), `wasm`, `native`. |
| `PHOTOBOOK_APPIMAGE_TOOLSET` | builder config | AppImage toolset version (default `1.0.3`). |
| `ELECTRON_RUN_AS_NODE` | `dev.mjs` | Deleted from the child environment so Electron starts as an app. |
| `XDG_CONFIG_HOME` | Electron (Linux) | Moves `appData`; used by CI to test the carry-over. |
| `APPIMAGE_EXTRACT_AND_RUN` | AppImage runtime (CI) | Unpack-and-run instead of FUSE mount. |

### Open points

- `role: 'quit'` and `role: 'togglefullscreen'` take Electron's per-platform default accelerators; they are not set in the code, so the exact keys (for example whether Windows shows Ctrl+Q) were not verified here.
- The `HostReply` type `{ type: 'restart' }` is handled by the shell (`app.relaunch()` and quit) but nothing in Photo Tool's server sends it; it may be a leftover from the editor.
- `README.md` says `PHOTO_TOOL_NO_UPDATE_CHECK` "to any value" stops the check; the code tests truthiness (`!!envVar(...)`), so an empty string does not.
- The `.deb`'s post-install behaviour (the Linux CI step mentions an install script setting up what Chromium's sandbox needs on Ubuntu 24.04, and `test-in-container.sh` lists `/etc/apparmor.d/<name>`) is not configured in `photo-tool/electron-builder.config.cjs`; it appears to come from electron-builder's own deb template, which was not read.
- Server-side limits of the Hugging Face downloads (`photo-tool/server/models/download.ts`) and the exact behaviour of every route in the table of section 8 belong to the server section; here only the desktop-side calls are described.
- `window-state.json` is written with a plain `writeFileSync` (not temp-and-rename like the other files), so a crash mid-write could corrupt it; a corrupt file is read as "no saved place".
- The README's timings (21 s, 83 s, 900 and 300 tests, 47 e2e tests) are for version 0.1.40 on one machine; test counts were not re-measured against 0.1.43.
- macOS: the shell has `darwin` branches (app and edit menus, `.app` resources path in `afterPack`) but no mac packaging target exists in the builder config.
