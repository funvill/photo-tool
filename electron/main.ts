// The desktop app: starts the local server in a utility process on a free port of 127.0.0.1,
// shows the editor from it in one window, and stops the server when the app quits.
//
// Offline by construction: nothing here downloads anything, the window can only reach the app's
// own local server, and Chromium's own network features are switched off (see hardenSession).
// There is deliberately no crash reporter and no updater.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, session, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess, type WebContents } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { LICENCE_FILE, MIN_WINDOW, NOTICES_BUTTON, NOTICES_FILE, dataLayout, describeAbout, describeFailure, parseSelfTest, restoreWindow, type WindowState } from './config';
import { isAllowedRequest, isAppNavigation, requestHost } from './netGuard';
import product from './product.json';
import type { HostMessage, HostReply } from './server-host';

const NAME = product.productName;
const selfTest = parseSelfTest(process.argv);
// Development (`npm run dev:desktop`): the editor comes from the Vite dev server.
const devUrl = !app.isPackaged ? process.env.PHOTOBOOK_DESKTOP_DEV_URL : undefined;

app.setName(NAME);
const layout = dataLayout({ appData: app.getPath('appData'), productName: NAME, packaged: app.isPackaged, env: process.env, selfTestOut: selfTest?.out });
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
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
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
    const start: HostMessage = { type: 'start', dataDir: layout.dataDir, port: devUrl ? Number(process.env.PHOTOBOOK_PORT ?? 5174) : 0, resourceRoot: resourceRoot(), devWebUrl: devUrl };
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
  ses.webRequest.onBeforeRequest((details, callback) => {
    const host = requestHost(details.url);
    seen.requestsByHost[host] = (seen.requestsByHost[host] ?? 0) + 1;
    const ok = isAllowedRequest(details.url, { ports: allowedPorts(), devTools: !app.isPackaged });
    if (!ok) {
      keep(seen.cancelledRequests, details.url);
      log('cancelled request', details.url);
    }
    callback({ cancel: !ok });
  });
}

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
    if (isMainFrame && !selfTest) void fatal('page', `The editor did not load: ${description} (${code})\n${url}`);
  });
  w.webContents.on('render-process-gone', (_e, details) => {
    log('page process gone', details);
    if (!quitting && details.reason !== 'clean-exit') void fatal('page', `The editor's page process ended: ${details.reason} (exit code ${details.exitCode}).`);
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
    description: product.description,
    dataDir: layout.dataDir,
    licence: licence ? readFileSync(licence, 'utf8') : null,
    repository: (product as { repository?: string }).repository,
    hasNotices: !!legalFile(NOTICES_FILE),
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

function buildMenu() {
  const about = () => void showAbout();
  const template: MenuItemConstructorOptions[] = [
    // macOS expects the app menu and the standard Edit menu; Windows and Linux need neither
    // (the editor handles its own shortcuts, and text fields work without a menu).
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }, { role: 'editMenu' }] as MenuItemConstructorOptions[]) : []),
    { label: '&File', submenu: [{ label: 'Open the &data folder', click: () => void shell.openPath(layout.dataDir) }, { type: 'separator' }, { role: 'quit' }] },
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

// ---- the page's four functions (see preload.ts)

function registerDesktopApi() {
  const fromApp = (e: Electron.IpcMainInvokeEvent) => !!e.senderFrame && isAppNavigation(e.senderFrame.url, appOrigin());
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
}

// ---- failures: always a message, never a blank window

let failing = false;
let startupFailure: Record<string, unknown> | null = null;

async function fatal(phase: 'start' | 'run' | 'page', detail: string) {
  if (failing || quitting) return;
  failing = true;
  const f = describeFailure(detail, { productName: NAME, dataDir: layout.dataDir, phase });
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
    photos: selfTest.photos,
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
  if (selfTest) {
    mkdirSync(selfTest.out, { recursive: true });
    setTimeout(() => void fatal('start', 'The self-test did not finish within 15 minutes.'), 15 * 60_000).unref();
  }
  hardenSession();
  buildMenu();
  registerDesktopApi();
  try {
    serverPort = await startServer();
  } catch (e) {
    return fatal('start', String((e as Error)?.message ?? e));
  }
  log('server ready', { port: serverPort });
  win = createWindow();
  try {
    await win.loadURL(devUrl ?? `http://127.0.0.1:${serverPort}/`);
  } catch (e) {
    return fatal('page', String((e as Error)?.message ?? e));
  }
  if (selfTest) {
    const { runSelfTest } = await import('./selfTest');
    const steps = await runSelfTest({ base: `http://127.0.0.1:${serverPort}`, photos: selfTest.photos, out: selfTest.out, win, session: session.defaultSession, log });
    await finishSelfTest(steps);
  }
}

if (!app.requestSingleInstanceLock()) {
  // Already running: the first copy shows its window (see 'second-instance').
  app.quit();
} else {
  app.on('second-instance', () => {
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
    quitting = true;
    if (!server) return;
    event.preventDefault();
    void stopServer().then(() => app.exit(exitCode));
  });
  void app.whenReady().then(main);
}
