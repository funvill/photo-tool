// The desktop app: starts the local server in a utility process on a free port of 127.0.0.1,
// shows the editor from it in one window, and stops the server when the app quits.
// With `--gallery [folder]` the same build is the gallery program instead: its own name, data,
// server and window, and its own single instance, so it runs beside the editor (see gallery.ts).
//
// Offline by construction: nothing here downloads anything, the window can only reach the app's
// own local server, and Chromium's own network features are switched off (see hardenSession).
// The one exception: the gallery's Map tab may load OpenStreetMap tiles once the user allows it (mapTiles.ts).
// There is deliberately no crash reporter and no updater.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, session, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess, type WebContents } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { GALLERY_APP_ID, GALLERY_PRODUCT_NAME, LICENCE_FILE, MIN_WINDOW, NOTICES_BUTTON, NOTICES_FILE, dataLayout, describeAbout, describeFailure, galleryEnv, parseMode, parseSelfTest, photoInfoFallbackDir, restoreWindow, selfTestOverlap, type WindowState } from './config';
import { GALLERY_DESCRIPTION, galleryDrag, galleryEditActions, galleryFileActions, galleryFolders, galleryMapConsent, galleryPage, launchGallery, type LaunchData } from './gallery';
import { OSM_TILE_ORIGIN, galleryRequestAllowed, hostResolverRules, isMapTileRequest, mapTileRequestHeaders } from './mapTiles';
import { isAllowedRequest, isAppNavigation, requestHost } from './netGuard';
import product from './product.json';
import type { HostMessage, HostReply } from './server-host';

const launch = parseMode(process.argv);
const isGallery = launch.mode === 'gallery';
const NAME = isGallery ? GALLERY_PRODUCT_NAME : product.productName;
/** What the window shows, in messages: "the editor" or "the gallery". */
const WHAT = isGallery ? 'gallery' : 'editor';
// The self-test of whichever program this is (`--gallery` picks the gallery's).
const selfTest = parseSelfTest(process.argv);
// The gallery's self-test replaces <out>/photos with a copy of the photos given. When the two folders
// overlap it stops here, before anything (the profile, the log, result.json, that copy) is written.
const selfTestRefused = isGallery && selfTest ? selfTestOverlap(selfTest.photos, selfTest.out) : null;
if (selfTestRefused) {
  console.error(`Self-test refused: ${selfTestRefused} Nothing was deleted or written.`);
  process.exit(1);
}
// The gallery's self-test opens a copy of the photos given, made in main() (see prepareGalleryPhotos).
const galleryTestPhotos = isGallery && selfTest ? join(selfTest.out, 'photos') : null;
// Development (`npm run dev:desktop`): the page comes from the Vite dev server.
const devUrl = !app.isPackaged ? process.env.PHOTOBOOK_DESKTOP_DEV_URL : undefined;

// The name and the folders below decide the single-instance lock, so they are set before it is asked for.
app.setName(NAME);
// Windows groups taskbar buttons by this id: the gallery's own keeps it apart from the editor
// (the installer's Gallery shortcuts carry the same one).
if (isGallery && process.platform === 'win32') app.setAppUserModelId(GALLERY_APP_ID);
const appData = app.getPath('appData');
const layout = dataLayout({ appData, productName: NAME, packaged: app.isPackaged, env: isGallery ? galleryEnv(process.env) : process.env, selfTestOut: selfTest?.out });
// The gallery keeps photo info for read-only folders in the editor's data folder, so stars reach the
// editor. Its self-test keeps even that inside its output folder, away from a real user's editor.
const editorDataDir = !isGallery
  ? layout.dataDir
  : selfTest
    ? join(selfTest.out, 'editor-data')
    : dataLayout({ appData, productName: product.productName, packaged: app.isPackaged, env: process.env }).dataDir;
// Chromium's own files go beside the app's data, never into it. Must be set before the app is ready.
app.setPath('userData', layout.profileDir);

// Chromium switches, all of them "do less on the network". The window only ever talks to
// 127.0.0.1, so no proxy is wanted (this also stops the proxy auto-detect lookup at start).
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('dns-prefetch-disable');
// No name is ever looked up: without this, every start asks the system's DNS server for
// redirector.gvt1.com (Chromium going for a spell-check dictionary before setSpellCheckerEnabled
// below can stop it; seen with strace on Linux, and not a request the filter below ever sees).
// The gallery also looks up the map tile server's name, for its Map tab (see mapTiles.ts).
app.commandLine.appendSwitch('host-resolver-rules', hostResolverRules(isGallery));
app.commandLine.appendSwitch('disable-features', 'SpellcheckServiceMultilingual,MediaRouter,DialMediaRouteProvider,OptimizationHints,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater');

// ---- log file (in the data folder; the temp folder if that cannot be written)

let logFile: string | null = null;
function openLog(): string {
  if (logFile) return logFile;
  for (const dir of [join(layout.dataDir, 'logs'), join(tmpdir(), `${NAME} logs`)]) {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'desktop.log');
      if (existsSync(file) && statSync(file).size > 2_000_000) renameSync(file, join(dir, 'desktop.previous.log'));
      appendFileSync(file, '');
      return (logFile = file);
    } catch {
      // try the next place
    }
  }
  return (logFile = '');
}
function log(...a: unknown[]) {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  const file = openLog();
  try {
    if (file) appendFileSync(file, line + '\n');
  } catch {
    // a full disk must not take the app down with it
  }
  if (!app.isPackaged || selfTest) console.log(line);
}
process.on('uncaughtException', (e) => log('main uncaughtException', String(e?.stack ?? e)));
process.on('unhandledRejection', (e) => log('main unhandledRejection', String((e as Error)?.stack ?? e)));

// ---- what the self-test records (kept in normal runs too: it is cheap and goes to the log)

const seen = {
  consoleMessages: [] as { level: string; message: string; source?: string }[],
  failedLoads: [] as string[],
  cancelledRequests: [] as string[],
  blockedNavigations: [] as string[],
  deniedPermissions: [] as string[],
  requestsByHost: {} as Record<string, number>,
};
const keep = <T>(list: T[], item: T) => {
  if (list.length < 500) list.push(item);
};

// ---- the local server

let server: UtilityProcess | null = null;
let serverPort = 0;
let serverOutput = '';
let serverStoppedCleanly = false;
let quitting = false;
let exitCode = 0;
let win: BrowserWindow | null = null;

const appOrigin = () => (devUrl ? new URL(devUrl).origin : `http://127.0.0.1:${serverPort}`);
const allowedPorts = () => new Set([serverPort, ...(devUrl ? [Number(new URL(devUrl).port || 80)] : [])]);

function resourceRoot(): string | undefined {
  if (process.env.PHOTOBOOK_RESOURCE_ROOT) return resolve(process.env.PHOTOBOOK_RESOURCE_ROOT);
  if (devUrl) return undefined; // from source: the server finds the project's own folders
  return app.isPackaged ? join(process.resourcesPath, 'assets') : join(__dirname, '..', 'resources');
}

function startServer(): Promise<number> {
  return new Promise((done, fail) => {
    let ready = false;
    const child = utilityProcess.fork(join(__dirname, 'server-host.cjs'), [], { serviceName: `${NAME} server`, stdio: 'pipe' });
    server = child;
    const collect = (stream: string) => (d: Buffer) => {
      const text = String(d).trimEnd();
      serverOutput = (serverOutput + text + '\n').slice(-8000);
      log(`[server ${stream}]`, text);
    };
    child.stdout?.on('data', collect('out'));
    child.stderr?.on('data', collect('err'));
    const timer = setTimeout(() => fail(new Error('The local server did not start within 60 seconds.')), 60_000);
    child.on('message', (m: HostReply) => {
      if (m.type === 'ready') {
        ready = true;
        clearTimeout(timer);
        done(m.port);
      } else if (m.type === 'error') {
        clearTimeout(timer);
        fail(new Error(m.error));
      } else if (m.type === 'stopped') {
        serverStoppedCleanly = true;
      } else if (m.type === 'restart') {
        app.relaunch();
        app.quit();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      server = null;
      log('server exited', { code, quitting });
      if (!ready) fail(new Error(`The local server stopped while starting (exit code ${code}).\n${serverOutput}`));
      else if (!quitting) void fatal('run', `The local server stopped unexpectedly (exit code ${code}).\n${serverOutput}`);
    });
    const start: HostMessage = {
      type: 'start',
      kind: launch.mode,
      dataDir: layout.dataDir,
      ...(isGallery ? { photoInfoFallbackDir: photoInfoFallbackDir(editorDataDir) } : {}),
      port: devUrl ? Number(process.env.PHOTOBOOK_PORT ?? 5174) : 0,
      resourceRoot: resourceRoot(),
      devWebUrl: devUrl,
    };
    child.once('spawn', () => child.postMessage(start));
  });
}

/** Ask the server to close its database and stop; give it a few seconds, then end it. */
function stopServer(): Promise<void> {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      log('server did not stop in time; ending it');
      child.kill();
      done();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    child.postMessage({ type: 'stop' } satisfies HostMessage);
  });
}

// ---- hardening

function hardenSession() {
  const ses = session.defaultSession;
  // On Windows and Linux the spell-checker downloads dictionaries from the internet.
  ses.setSpellCheckerEnabled(false);
  void ses.setProxy({ mode: 'direct' });
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    keep(seen.deniedPermissions, permission);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // The last line of defence: any request that is not to the app's own local server is cancelled
  // before it leaves.
  // The gallery alone may also fetch map tiles, and only while the user allows maps (see mapTiles.ts).
  ses.webRequest.onBeforeRequest((details, callback) => {
    const host = requestHost(details.url);
    seen.requestsByHost[host] = (seen.requestsByHost[host] ?? 0) + 1;
    const guard = { ports: allowedPorts(), devTools: !app.isPackaged };
    const ok = isGallery ? galleryRequestAllowed(details.url, details.method, { ...guard, mapsAllowed: mapsAllowed() }) : isAllowedRequest(details.url, guard);
    if (!ok) {
      keep(seen.cancelledRequests, details.url);
      log('cancelled request', details.url);
    }
    callback({ cancel: !ok });
  });
  if (isGallery) {
    // A tile request names the program and its version, nothing more (OpenStreetMap's tile policy):
    // only Accept and that User-Agent go out.
    ses.webRequest.onBeforeSendHeaders({ urls: [`${OSM_TILE_ORIGIN}/*`] }, (details, callback) => {
      if (!isMapTileRequest(details.url, details.method)) return callback({ cancel: true });
      callback({ requestHeaders: mapTileRequestHeaders(details.requestHeaders, app.getVersion()) });
    });
  }
}

// ---- the gallery's map (the one network exception; see mapTiles.ts)

/** The gallery's own settings, beside Chromium's profile: `{ "mapsOnline": boolean }` once asked. */
const gallerySettingsFile = () => join(app.getPath('userData'), 'settings.json');
let mapsOnline = false;
/** Tiles may load: in the gallery, after the user chose Load maps (never during a self-test). */
const mapsAllowed = () => isGallery && mapsOnline && !selfTest;

function hardenContents(contents: WebContents) {
  const block = (what: string) => (event: { preventDefault: () => void }, url: string) => {
    if (isAppNavigation(url, appOrigin())) return;
    event.preventDefault();
    keep(seen.blockedNavigations, url);
    log(`blocked ${what}`, url);
  };
  contents.on('will-navigate', block('navigation'));
  contents.on('will-redirect', block('redirect'));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    log('denied new window', url);
    return { action: 'deny' };
  });
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}

// ---- window

const stateFile = () => join(layout.profileDir, 'window-state.json');
function readWindowState(): unknown {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}
function saveWindowState(w: BrowserWindow) {
  try {
    const state: WindowState = { bounds: w.getNormalBounds(), maximized: w.isMaximized() };
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch (e) {
    log('could not save the window state', String(e));
  }
}

function createWindow(): BrowserWindow {
  const place = restoreWindow(readWindowState(), screen.getAllDisplays().map((d) => d.workArea));
  const icon = join(resourceRoot() ?? '', 'icon.png');
  const w = new BrowserWindow({
    ...place.bounds,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    title: NAME,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#ffffff',
    // Windows takes the icon from the .exe; Linux needs it given.
    ...(process.platform === 'linux' && existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      additionalArguments: [`--photobook-version=${app.getVersion()}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  if (place.maximized && !selfTest) w.maximize();
  w.webContents.on('console-message', (e) => {
    keep(seen.consoleMessages, { level: String(e.level), message: e.message, source: e.sourceId ? `${e.sourceId}:${e.lineNumber}` : undefined });
    if (e.level === 'error' || e.level === 'warning') log(`[page ${e.level}]`, e.message);
  });
  w.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (code === -3) return; // aborted: a navigation replaced by another, or one the app blocked
    keep(seen.failedLoads, `${code} ${description} ${url}`);
    log('failed load', { code, description, url, isMainFrame });
    if (isMainFrame && !selfTest) void fatal('page', `The ${WHAT} did not load: ${description} (${code})\n${url}`);
  });
  w.webContents.on('render-process-gone', (_e, details) => {
    log('page process gone', details);
    if (!quitting && details.reason !== 'clean-exit') void fatal('page', `The ${WHAT}'s page process ended: ${details.reason} (exit code ${details.exitCode}).`);
  });
  w.once('ready-to-show', () => {
    if (!selfTest) w.show();
  });
  w.on('close', () => saveWindowState(w));
  w.on('closed', () => {
    if (win === w) win = null;
  });
  return w;
}

/** A licence file in the app's resource folder, or null (a copy run from source has none). */
function legalFile(name: string): string | null {
  const root = resourceRoot();
  const file = root ? join(root, name) : '';
  return file && existsSync(file) ? file : null;
}

function aboutBox() {
  const licence = legalFile(LICENCE_FILE);
  return describeAbout({
    productName: NAME,
    version: app.getVersion(),
    description: isGallery ? GALLERY_DESCRIPTION : product.description,
    dataDir: layout.dataDir,
    licence: licence ? readFileSync(licence, 'utf8') : null,
    repository: (product as { repository?: string }).repository,
    hasNotices: !!legalFile(NOTICES_FILE),
    mode: launch.mode,
  });
}

async function showAbout() {
  const { buttons, ...words } = aboutBox();
  const options = { type: 'info' as const, ...words, buttons, defaultId: 0, cancelId: 0, noLink: true };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  const notices = legalFile(NOTICES_FILE);
  if (buttons[response] !== NOTICES_BUTTON || !notices) return;
  // A plain text file on this computer, opened by whatever the system uses for those.
  const problem = await shell.openPath(notices);
  if (problem) {
    log('could not open', notices, problem);
    shell.showItemInFolder(notices);
  }
}

/** `fileItems` come first in the File menu: the editor's "Open Gallery", or the gallery's own. */
function buildMenu(fileItems: MenuItemConstructorOptions[]) {
  const about = () => void showAbout();
  const template: MenuItemConstructorOptions[] = [
    // macOS expects the app menu and the standard Edit menu; Windows and Linux need neither
    // (the editor handles its own shortcuts, and text fields work without a menu).
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }, { role: 'editMenu' }] as MenuItemConstructorOptions[]) : []),
    { label: '&File', submenu: [...fileItems, { label: 'Open the &data folder', click: () => void shell.openPath(layout.dataDir) }, { type: 'separator' }, { role: 'quit' }] },
    {
      label: '&View',
      submenu: [
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    { label: '&Help', submenu: [{ label: `&About ${NAME}`, click: about }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- the page's functions (see preload.ts)

/** Did this message come from the app's own page? */
const fromApp = (e: { senderFrame: Electron.WebFrameMain | null }) => !!e.senderFrame && isAppNavigation(e.senderFrame.url, appOrigin());

/** The gallery's folders to open (null in the editor). */
const folders = isGallery ? galleryFolders({ window: () => win, fromApp, log }, galleryTestPhotos ?? launch.folder) : null;

/** The gallery's edit saving (null in the editor). */
let galleryEdits: ReturnType<typeof galleryEditActions> | null = null;

function registerDesktopApi() {
  /** An export's file name → its full path, or null when it is not a file in the exports folder. */
  const exportPath = (name: unknown): string | null => {
    if (typeof name !== 'string' || !name || basename(name) !== name) return null;
    const path = join(layout.dataDir, 'exports', name);
    return existsSync(path) && statSync(path).isFile() ? path : null;
  };
  ipcMain.handle('desktop:pick-folder', async (e, options: { title?: unknown; defaultPath?: unknown }) => {
    if (!fromApp(e) || !win) return null;
    const defaultPath = typeof options?.defaultPath === 'string' && existsSync(options.defaultPath) ? options.defaultPath : undefined;
    const r = await dialog.showOpenDialog(win, { title: typeof options?.title === 'string' ? options.title : 'Choose a folder', defaultPath, properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('desktop:open-file', async (e, name: unknown) => {
    const path = fromApp(e) ? exportPath(name) : null;
    if (!path) return false;
    if (selfTest) return true; // a test must not pop a PDF viewer open
    const problem = await shell.openPath(path);
    if (problem) {
      // No app for this kind of file: showing where it is still helps.
      log('could not open', path, problem);
      shell.showItemInFolder(path);
    }
    return true;
  });
  ipcMain.handle('desktop:show-in-folder', (e, name: unknown) => {
    const path = fromApp(e) ? exportPath(name) : null;
    if (!path) return false;
    if (!selfTest) shell.showItemInFolder(path);
    return true;
  });
  if (!isGallery) {
    ipcMain.handle('desktop:open-gallery', (e) => {
      if (fromApp(e) && !selfTest) launchGallery(log);
    });
  } else {
    // Dragging photos out: the main process asks the gallery's own server which files it may drag.
    galleryDrag({ fromApp, serverPort: () => serverPort, log });
    // The right-click menu's copy, show in folder and delete (to the Recycle Bin), same checks.
    galleryFileActions({ window: () => win, fromApp, serverPort: () => serverPort, log });
    // The edit setting, Save to file, Save as, and the question before closing with unsaved edits.
    galleryEdits = galleryEditActions({ window: () => win, fromApp, serverPort: () => serverPort, file: gallerySettingsFile(), log });
    // The Map tab's "Load maps from the internet?" answer, kept here so the request guard can read it.
    galleryMapConsent({ window: () => win, fromApp, file: gallerySettingsFile(), onChange: (on) => (mapsOnline = on), log });
  }
}

// ---- failures: always a message, never a blank window

let failing = false;
let startupFailure: Record<string, unknown> | null = null;

async function fatal(phase: 'start' | 'run' | 'page', detail: string) {
  if (failing || quitting) return;
  failing = true;
  const f = describeFailure(detail, { productName: NAME, dataDir: layout.dataDir, phase, mode: launch.mode });
  const technical = [`${NAME} ${app.getVersion()} (${process.platform} ${process.arch}, Electron ${process.versions.electron})`, `Data folder: ${layout.dataDir}`, `Log file: ${openLog() || '(none)'}`, '', detail].join('\n');
  log('FATAL', phase, f.title, '\n' + technical);
  if (selfTest) {
    // Recorded, not shown: a test cannot click a dialog away.
    startupFailure = { phase, dialog: f, technical, logFile: openLog() };
    return finishSelfTest({});
  }
  const buttons = phase === 'start' ? ['Close', 'Copy details', 'Open the log folder'] : ['Restart', 'Close', 'Copy details', 'Open the log folder'];
  for (;;) {
    const options = { type: 'error' as const, title: f.title, message: `${f.message}\n\n${f.advice}`, detail: technical.slice(0, 2500), buttons, defaultId: 0, cancelId: buttons.indexOf('Close'), noLink: true };
    const { response } = win && !win.isDestroyed() && win.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    const choice = buttons[response];
    if (choice === 'Copy details') clipboard.writeText(technical);
    else if (choice === 'Open the log folder') void shell.openPath(join(openLog(), '..'));
    else {
      if (choice === 'Restart') app.relaunch();
      break;
    }
  }
  exitCode = 1;
  app.quit();
}

// ---- self-test

async function finishSelfTest(steps: Record<string, { ok: boolean }>) {
  if (!selfTest) return;
  const { SELF_TEST_CONTROL_URLS } = await import('./selfTest');
  // The two control requests are the test's own proof that blocking works; they are listed apart.
  const control = (u: string) => SELF_TEST_CONTROL_URLS.includes(u);
  const cancelled = seen.cancelledRequests.filter((u) => !control(u));
  const consoleErrors = seen.consoleMessages.filter((m) => m.level === 'error');
  const hosts = Object.keys(seen.requestsByHost);
  // The app's own server (and, in development, the Vite dev server); port 9 is the control request.
  const own = [...allowedPorts()].map((p) => `127.0.0.1:${p}`);
  const otherHosts = hosts.filter((h) => ![...own, ...own.map((o) => `blob:${o}`), 'data:', '127.0.0.1:9'].includes(h));
  quitting = true;
  await stopServer();
  const stepNames = Object.keys(steps);
  // A packaged app must carry its own licence and the third-party notices.
  const notices = legalFile(NOTICES_FILE);
  const legalOk = !app.isPackaged || (!!legalFile(LICENCE_FILE) && !!notices);
  const ok = legalOk && !startupFailure && stepNames.length > 0 && stepNames.every((k) => steps[k]!.ok) && consoleErrors.length === 0 && seen.failedLoads.length === 0 && cancelled.length === 0 && otherHosts.length === 0 && serverStoppedCleanly;
  const result = {
    ok,
    finishedAt: new Date().toISOString(),
    app: { name: NAME, version: app.getVersion(), packaged: app.isPackaged, execPath: process.execPath, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch },
    folders: { dataDir: layout.dataDir, profileDir: layout.profileDir, resourceRoot: resourceRoot() ?? null, logFile: openLog() },
    // What Help > About shows, and the licence files it reads and opens.
    about: { ...aboutBox(), licenceFile: legalFile(LICENCE_FILE), noticesFile: notices, noticesBytes: notices ? statSync(notices).size : 0 },
    mode: selfTest.mode,
    photos: selfTest.photos,
    // The gallery works on a copy (see prepareGalleryPhotos), never on the photos given.
    ...(galleryTestPhotos ? { photosCopy: galleryTestPhotos } : {}),
    startupFailure,
    steps,
    serverStoppedCleanly,
    consoleErrors: consoleErrors.length,
    consoleMessages: seen.consoleMessages,
    failedLoads: seen.failedLoads,
    cancelledRequests: cancelled,
    controlRequestsCancelled: seen.cancelledRequests.filter(control),
    blockedNavigations: seen.blockedNavigations,
    deniedPermissions: seen.deniedPermissions,
    requestsByHost: seen.requestsByHost,
    requestsToOtherHosts: otherHosts,
  };
  try {
    mkdirSync(selfTest.out, { recursive: true });
    writeFileSync(join(selfTest.out, 'result.json'), JSON.stringify(result, null, 2));
  } catch (e) {
    log('could not write result.json', String(e));
  }
  log('self-test finished', { ok });
  app.exit(ok ? 0 : 1);
}

// ---- start

async function main() {
  log(`${NAME} ${app.getVersion()} starting`, { packaged: app.isPackaged, dataDir: layout.dataDir, profileDir: layout.profileDir, resourceRoot: resourceRoot() ?? '(source)', devUrl: devUrl ?? null, selfTest: !!selfTest });
  let galleryTest: { sourceBefore: Record<string, string> } | null = null;
  if (selfTest) {
    mkdirSync(selfTest.out, { recursive: true });
    setTimeout(() => void fatal('start', 'The self-test did not finish within 15 minutes.'), 15 * 60_000).unref();
    if (galleryTestPhotos) {
      // Before the page can ask for the folder (galleryFolders hands it over once the page listens).
      const { prepareGalleryPhotos } = await import('./selfTest');
      try {
        galleryTest = prepareGalleryPhotos(selfTest.photos, selfTest.out);
      } catch (e) {
        return fatal('start', `Could not copy the photos for the self-test: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }
  hardenSession();
  buildMenu(folders ? folders.fileMenu() : [{ label: 'Open &Gallery', click: () => launchGallery(log) }, { type: 'separator' }]);
  registerDesktopApi();
  try {
    serverPort = await startServer();
  } catch (e) {
    return fatal('start', String((e as Error)?.message ?? e));
  }
  log('server ready', { port: serverPort });
  win = createWindow();
  folders?.watch(win);
  galleryEdits?.watch(win);
  const base = devUrl ?? `http://127.0.0.1:${serverPort}/`;
  try {
    await win.loadURL(isGallery ? galleryPage(base) : base);
  } catch (e) {
    return fatal('page', String((e as Error)?.message ?? e));
  }
  if (selfTest) {
    const { runGallerySelfTest, runSelfTest } = await import('./selfTest');
    const ctx = { base: `http://127.0.0.1:${serverPort}`, photos: selfTest.photos, out: selfTest.out, win, session: session.defaultSession, log };
    const steps = galleryTest && galleryTestPhotos ? await runGallerySelfTest({ ...ctx, photos: galleryTestPhotos, source: selfTest.photos, sourceBefore: galleryTest.sourceBefore }) : await runSelfTest(ctx);
    await finishSelfTest(steps);
  }
}

// The gallery passes its command line along: a second `--gallery <folder>` opens that folder.
if (!app.requestSingleInstanceLock(isGallery ? ({ argv: process.argv, cwd: process.cwd() } satisfies LaunchData) : undefined)) {
  // Already running: the first copy shows its window (see 'second-instance').
  app.quit();
} else {
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    // First: a folder handed over while this copy is still starting waits for the page instead of being dropped.
    folders?.secondInstance(data);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
  app.on('window-all-closed', () => {
    if (!selfTest && !failing) app.quit();
  });
  // Quit only after the server has closed its database.
  app.on('before-quit', (event) => {
    if (quitting) return;
    // app.exit below skips the page's beforeunload, so the gallery asks about unsaved edits here.
    if (!selfTest && !failing && galleryEdits && !galleryEdits.confirmQuit()) {
      event.preventDefault();
      return;
    }
    quitting = true;
    if (!server) return;
    event.preventDefault();
    void stopServer().then(() => app.exit(exitCode));
  });
  void app.whenReady().then(main);
}
