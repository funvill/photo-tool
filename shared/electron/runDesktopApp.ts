// The desktop shell both programs run in: starts the program's local server in a utility process on a
// port of 127.0.0.1 (the one it had last time, so the page keeps its origin and settings), shows its page from it in one window, and stops the server when the app quits.
// Everything that differs between the editor and Photo Tool (names, page, menu, IPC, network
// exceptions, self-test) comes in through a DesktopProgram; nothing here imports a program.
//
// Offline by construction: the window can only reach the app's own local server, and Chromium's own
// network features are switched off (see hardenSession). A program may allow more through
// requestAllowed (Photo Tool's map tiles, once the user allows them).
// The one thing the shell itself fetches: electron-updater asks GitHub for a new version (once a day
// at start unless turned off, or from Help; see updates.ts), in its own session, so the window's guard
// is unchanged. Only GitHub's names may be looked up for it (updateRules.UPDATE_HOSTS in each program's
// host-resolver-rules), and never in a self-test. There is deliberately no crash reporter.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, session, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess, type WebContents } from 'electron';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { autoUpdater } from 'electron-updater';
import { CHECK_UPDATES_BUTTON, LICENCE_FILE, MIN_WINDOW, NOTICES_BUTTON, NOTICES_FILE, describeAbout, describeFailure, parseSavedPort, parseSelfTest, restoreWindow, serverPortRequest, type ProgramNames, type SelfTestArgs, type WindowState } from './config';
import { CarryOverError, carryOverRefusal, prepareProgramFolders } from './dataFolders';
import { isAppNavigation, requestHost, type GuardOptions } from './netGuard';
import { SELF_TEST_CONTROL_URLS, type SelfTestContext, type Step } from './selfTest';
import type { HostMessage, HostReply, StartMessage } from './serverHost';
import { githubRepo, latestReleasePage, updateText } from './updateRules';
import { createUpdates, type Updates } from './updates';

/** What a program gives the shell: everything in which the editor and Photo Tool differ. */
export interface DesktopProgram {
  names: ProgramNames;
  /** Windows groups taskbar buttons by this id; it equals the program's appId. */
  appUserModelId: string;
  /** One sentence for Help > About. */
  description: string;
  /** Where the program's source lives, as product.json has it ("github:owner/name"), for Help > About. */
  repository?: string;
  /** The server host bundle beside main.cjs, e.g. 'server-host.cjs'. */
  serverHostFile: string;
  /** The URL the window loads, given the server's (or the Vite dev server's) base URL. */
  page(base: string): string;
  /** Chromium's host-resolver-rules: which names may be looked up at all (the update hosts among them). */
  hostResolverRules: string;
  /** The program's own update channel: its update files are <channel>.yml and <channel>-linux.yml. */
  updateChannel: string;
  /** May the window make this request? `guard` names the app's own ports. */
  requestAllowed(url: string, method: string, guard: GuardOptions): boolean;
  /** Set up header rewriting on the session (Photo Tool's map tile requests). */
  sendHeaders?(session: Electron.Session, version: () => string): void;
  /** The program's own File menu items, before "Open the data folder" and Quit. */
  fileMenu(ctx: ProgramContext): MenuItemConstructorOptions[];
  /** The program's own IPC handlers (the shared desktop:pick-folder is registered already). */
  registerIpc(ctx: ProgramContext): void;
  /** More (or different) fields for the server's start message. */
  startMessage(ctx: ProgramContext): Partial<StartMessage>;
  /** What a second launch hands to the first (requestSingleInstanceLock). */
  singleInstanceData?(): unknown;
  /** A second launch: called before the window is brought forward. */
  onSecondInstance?(data: unknown): void;
  /** Before quitting: false keeps the app running (e.g. unsaved edits the user wants to keep). */
  confirmQuit?(): boolean;
  /** The program's self-test steps, run once the page has loaded. */
  selfTest(ctx: SelfTestContext & ProgramContext): Promise<Record<string, Step>>;
  /** Before anything else of a self-test (e.g. copying the photos); a throw fails the start. */
  prepareSelfTest?(ctx: ProgramContext): Promise<void>;
  /** The window, once made (before its page loads). */
  onWindow?(win: BrowserWindow): void;
}

/** What the shell tells a program's hooks. */
export interface ProgramContext {
  layout: { dataDir: string; profileDir: string };
  photoInfoFallbackDir: string;
  selfTest: SelfTestArgs | null;
  window(): BrowserWindow | null;
  serverPort(): number;
  /** Did this message come from the app's own page? */
  fromApp(e: { senderFrame: Electron.WebFrameMain | null }): boolean;
  log(...a: unknown[]): void;
  resourceRoot(): string | undefined;
}

/**
 * A move failed: say so in a window, then quit. The window waits for the app to be ready (before that,
 * Linux only prints the message). Chromium is first pointed at a throwaway profile folder, so it never
 * makes its default one (<appData>/<package.json productName>), which may be the folder to move to.
 */
function refuseToStart(names: ProgramNames, e: CarryOverError, selfTest: SelfTestArgs | null) {
  console.error(e.message);
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'photo-tools-refused-')));
  const { title, message } = carryOverRefusal(names, e);
  if (selfTest) {
    // Only reachable in CI (a self-test moves folders only with selfTestCarriesOver): the same
    // message box, closed by itself after a few seconds since no one is there to click, and a
    // record of the refusal beside where result.json would be.
    // Written before the box opens (dialogClosed false) and again once it has closed, so the record
    // is there even if the backstop has to end the program.
    const record = (dialogClosed: boolean) => {
      try {
        mkdirSync(selfTest.out, { recursive: true });
        writeFileSync(join(selfTest.out, 'refused.json'), JSON.stringify({ refused: true, step: e.step, from: e.from, to: e.to, title, message, dialogClosed }, null, 2));
      } catch (err) {
        console.error(String(err));
      }
    };
    void app.whenReady().then(async () => {
      record(false);
      const backstop = setTimeout(() => app.exit(1), 15_000);
      try {
        await dialog.showMessageBox({ type: 'error', title, message, buttons: ['Close'], noLink: true, signal: AbortSignal.timeout(3000) });
        record(true);
      } finally {
        clearTimeout(backstop);
        app.exit(1);
      }
    });
    return;
  }
  void app.whenReady().then(() => {
    dialog.showMessageBoxSync({ type: 'error', title, message, buttons: ['Close'], noLink: true });
    app.exit(1);
  });
}

/** Run `program` as this process's desktop app. Call once, at the top of the program's main. */
export function runDesktopApp(program: DesktopProgram): void {
  const { names } = program;
  const NAME = names.productName;
  const env = process.env;
  const envVar = (name: string) => env[`${names.envPrefix}_${name}`];
  const selfTest = parseSelfTest(process.argv);
  // Development (`npm run dev:desktop:editor` or `dev:desktop:photo-tool`): the page comes from the Vite dev server.
  const devUrl = !app.isPackaged ? envVar('DESKTOP_DEV_URL') : undefined;

  // The name and the folders below decide the single-instance lock, so they are set before it is asked for.
  app.setName(NAME);
  // Windows groups taskbar buttons by this id (the installer's shortcuts carry the same one).
  if (process.platform === 'win32') app.setAppUserModelId(program.appUserModelId);
  const appData = app.getPath('appData');

  // The data of the program's old name moves to its new one, once, before anything is written
  // (nothing above has made a folder), and only then is Chromium given its profile folder: Chromium's
  // own default (<appData>/<package.json productName>) is never used. Never in a test run or when the
  // folders are given. Chromium's own files go beside the app's data, never into it.
  let prepared: ReturnType<typeof prepareProgramFolders>;
  try {
    prepared = prepareProgramFolders({ names, appData, packaged: app.isPackaged, env, selfTestOut: selfTest?.out, setUserData: (dir) => app.setPath('userData', dir) });
  } catch (e) {
    if (!(e instanceof CarryOverError)) throw e;
    refuseToStart(names, e, selfTest);
    return;
  }
  const { layout, photoInfoFallbackDir: sharedPhotoInfo, carried } = prepared;

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
  // No name is ever looked up, except what the program allows: without this, every start asks the
  // system's DNS server for redirector.gvt1.com (Chromium going for a spell-check dictionary before
  // setSpellCheckerEnabled below can stop it; seen with strace on Linux, and not a request the filter
  // below ever sees).
  app.commandLine.appendSwitch('host-resolver-rules', program.hostResolverRules);
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
  /** Closing the window to install an update: closing it must not quit the app (see prepareInstall). */
  let installing = false;
  let exitCode = 0;
  let win: BrowserWindow | null = null;
  /** Checking for updates; null in a self-test. */
  let updates: Updates | null = null;

  const appOrigin = () => (devUrl ? new URL(devUrl).origin : `http://127.0.0.1:${serverPort}`);
  const allowedPorts = () => new Set([serverPort, ...(devUrl ? [Number(new URL(devUrl).port || 80)] : [])]);

  function resourceRoot(): string | undefined {
    const given = envVar('RESOURCE_ROOT');
    if (given) return resolve(given);
    if (devUrl) return undefined; // from source: the server finds the project's own folders
    return app.isPackaged ? join(process.resourcesPath, 'assets') : join(__dirname, '..', 'resources');
  }

  /** Did this message come from the app's own page? */
  const fromApp = (e: { senderFrame: Electron.WebFrameMain | null }) => !!e.senderFrame && isAppNavigation(e.senderFrame.url, appOrigin());

  const ctx: ProgramContext = {
    layout,
    photoInfoFallbackDir: sharedPhotoInfo,
    selfTest,
    window: () => win,
    serverPort: () => serverPort,
    fromApp,
    log,
    resourceRoot,
  };

  // The page's origin includes the port, and localStorage is kept per origin: the installed app asks
  // for the port it had last time so the page keeps its settings. Never in development (fixed ports)
  // or a self-test (any free port). The window still loads only from the port the server reports.
  const rememberPort = !devUrl && !selfTest;
  const portFile = () => join(layout.profileDir, 'server-port.json');
  function readSavedPort(): number | null {
    try {
      return parseSavedPort(JSON.parse(readFileSync(portFile(), 'utf8')));
    } catch {
      return null;
    }
  }
  function saveServerPort(port: number) {
    try {
      mkdirSync(layout.profileDir, { recursive: true });
      const tmp = `${portFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ port }));
      renameSync(tmp, portFile());
    } catch (e) {
      log('could not save the server port', String(e));
    }
  }

  function startServer(): Promise<number> {
    return new Promise((done, fail) => {
      let ready = false;
      const child = utilityProcess.fork(join(__dirname, program.serverHostFile), [], { serviceName: `${NAME} server`, stdio: 'pipe' });
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
      // In development the Vite dev server sends the API to a fixed port: ${PREFIX}_PORT, or by default the one
      // above the page's (5173/5174 for the editor, 5175/5176 for Photo Tool).
      const portRequest = serverPortRequest({ devUrl, envPort: envVar('PORT'), selfTest: !!selfTest, saved: rememberPort ? readSavedPort() : null });
      log('asking the server for port', portRequest);
      const start: HostMessage = {
        type: 'start',
        dataDir: layout.dataDir,
        photoInfoFallbackDir: sharedPhotoInfo,
        ...portRequest,
        resourceRoot: resourceRoot(),
        devWebUrl: devUrl,
        ...program.startMessage(ctx),
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
    // The last line of defence: any request that is not to the app's own local server (or one the
    // program allows) is cancelled before it leaves.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const host = requestHost(details.url);
      seen.requestsByHost[host] = (seen.requestsByHost[host] ?? 0) + 1;
      const ok = program.requestAllowed(details.url, details.method, { ports: allowedPorts(), devTools: !app.isPackaged });
      if (!ok) {
        keep(seen.cancelledRequests, details.url);
        log('cancelled request', details.url);
      }
      callback({ cancel: !ok });
    });
    program.sendHeaders?.(ses, () => app.getVersion());
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
      if (isMainFrame && !selfTest) void fatal('page', `${NAME}'s page did not load: ${description} (${code})\n${url}`);
    });
    w.webContents.on('render-process-gone', (_e, details) => {
      log('page process gone', details);
      if (!quitting && details.reason !== 'clean-exit') void fatal('page', `${NAME}'s page process ended: ${details.reason} (exit code ${details.exitCode}).`);
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
      description: program.description,
      dataDir: layout.dataDir,
      licence: licence ? readFileSync(licence, 'utf8') : null,
      repository: program.repository,
      hasNotices: !!legalFile(NOTICES_FILE),
      // Updates work only in the installed program, and never during a self-test.
      canCheckForUpdates: app.isPackaged && !selfTest,
      runtime: `Electron ${process.versions.electron}, ${process.platform} ${process.arch}`,
    });
  }

  async function showAbout() {
    const { buttons, ...words } = aboutBox();
    const options = { type: 'info' as const, ...words, buttons, defaultId: 0, cancelId: 0, noLink: true };
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    // The box has closed by now; the check shows its own result.
    if (buttons[response] === CHECK_UPDATES_BUTTON) {
      void updates?.checkNow();
      return;
    }
    const notices = legalFile(NOTICES_FILE);
    if (buttons[response] !== NOTICES_BUTTON || !notices) return;
    // A plain text file on this computer, opened by whatever the system uses for those.
    const problem = await shell.openPath(notices);
    if (problem) {
      log('could not open', notices, problem);
      shell.showItemInFolder(notices);
    }
  }

  /** The program's own File menu items, kept for building the menu again (the update items change). */
  let fileItems: MenuItemConstructorOptions[] = [];
  /** `fileItems` (the program's own) come first in the File menu. */
  function buildMenu() {
    const about = () => void showAbout();
    const updateItems = updates?.menuItems() ?? [];
    const template: MenuItemConstructorOptions[] = [
      // macOS expects the app menu and the standard Edit menu; Windows and Linux need neither
      // (the page handles its own shortcuts, and text fields work without a menu).
      ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }, { role: 'editMenu' }] as MenuItemConstructorOptions[]) : []),
      { label: '&File', submenu: [...fileItems, { label: 'Open the &data folder', click: () => void shell.openPath(layout.dataDir) }, { type: 'separator' }, { role: 'quit' }] },
      {
        label: '&View',
        submenu: [
          { role: 'togglefullscreen' },
          ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
        ],
      },
      { label: '&Help', submenu: [...updateItems, ...(updateItems.length ? ([{ type: 'separator' }] as MenuItemConstructorOptions[]) : []), { label: `&About ${NAME}`, accelerator: 'F1', click: about }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // ---- updates (the controller is updates.ts; these are its hooks into the app)

  /** A message box over the window (or on its own when there is none); resolves to the button pressed. */
  async function message(text: string, buttons: string[]): Promise<number> {
    const options = { type: 'info' as const, title: NAME, message: text, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true };
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response;
  }

  /**
   * The installed .deb updates through dpkg as root: electron-updater asks for the password with a
   * graphical sudo (pkexec and the like) and falls back to plain sudo, which needs a terminal the app
   * does not have. With none of those, the release page is opened instead, before anything is closed.
   */
  function cannotInstallDeb(): boolean {
    if (process.platform !== 'linux' || env.APPIMAGE) return false;
    const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
    return !['gksudo', 'kdesudo', 'pkexec', 'beesu'].some((cmd) => dirs.some((dir) => existsSync(join(dir, cmd))));
  }

  /**
   * Restart now, before the installer runs: nothing unsaved may be lost and the server must close its
   * database. Photo Tool's unsaved-edits question first; then the window is closed while the server
   * still runs (the editor's page cancels the first close to finish its pending save, so it is tried
   * again each second for up to 10 s); then the server stops. False calls the install off.
   */
  async function prepareInstall(): Promise<boolean> {
    if (cannotInstallDeb()) {
      const repo = githubRepo(program.repository);
      await message(`${NAME} cannot install this update by itself. Download it from the release page and install it from there.`, ['OK']);
      if (repo) void shell.openExternal(latestReleasePage(repo));
      return false;
    }
    if (program.confirmQuit && !program.confirmQuit()) return false;
    installing = true;
    const until = Date.now() + 10_000;
    while (win && !win.isDestroyed() && Date.now() < until) {
      win.close();
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (win && !win.isDestroyed()) {
      installing = false;
      await message(updateText.stillSaving, ['OK']);
      return false;
    }
    // Set first, so that the server's exit is not taken for a crash; before-quit then lets the
    // updater's quit through without asking again or ending the app early.
    quitting = true;
    await stopServer();
    // The installer normally ends the app at once; if it never starts, the app (with no window and no
    // server left) must not linger.
    setTimeout(() => {
      log('the update installer did not start; quitting');
      app.exit(exitCode);
    }, 30_000).unref();
    return true;
  }

  /** Set up checking for updates. Never in a self-test: there autoUpdater is not even touched. */
  function startUpdates() {
    if (selfTest) return;
    autoUpdater.logger = { info: (m: unknown) => log('[updater]', m), warn: (m: unknown) => log('[updater warn]', m), error: (m: unknown) => log('[updater error]', m), debug: () => {} };
    // Testing only: an update feed served on this computer (electron-updater's generic provider).
    const feed = envVar('UPDATE_FEED');
    if (feed) log('update feed', feed);
    if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed, channel: program.updateChannel });
    updates = createUpdates({
      updater: autoUpdater,
      channel: program.updateChannel,
      productName: NAME,
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      repo: githubRepo(program.repository),
      settingsFile: join(layout.profileDir, 'updates.json'),
      ask: ({ message: text, buttons }) => message(text, buttons),
      openExternal: (url) => void shell.openExternal(url),
      setProgress: (f) => {
        if (win && !win.isDestroyed()) win.setProgressBar(f ?? -1);
      },
      refreshMenu: () => buildMenu(),
      prepareInstall,
      log,
      now: () => Date.now(),
    });
  }

  // ---- the page's functions (see each program's preload.ts)

  function registerDesktopApi() {
    ipcMain.handle('desktop:pick-folder', async (e, options: { title?: unknown; defaultPath?: unknown }) => {
      if (!fromApp(e) || !win) return null;
      const defaultPath = typeof options?.defaultPath === 'string' && existsSync(options.defaultPath) ? options.defaultPath : undefined;
      const r = await dialog.showOpenDialog(win, { title: typeof options?.title === 'string' ? options.title : 'Choose a folder', defaultPath, properties: ['openDirectory'] });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    });
    program.registerIpc(ctx);
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
      folders: { dataDir: layout.dataDir, profileDir: layout.profileDir, photoInfoFallbackDir: sharedPhotoInfo, resourceRoot: resourceRoot() ?? null, logFile: openLog() },
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
    log(`${NAME} ${app.getVersion()} starting`, { packaged: app.isPackaged, dataDir: layout.dataDir, profileDir: layout.profileDir, photoInfoFallbackDir: sharedPhotoInfo, carriedOver: carried, resourceRoot: resourceRoot() ?? '(source)', devUrl: devUrl ?? null, selfTest: !!selfTest });
    if (selfTest) {
      mkdirSync(selfTest.out, { recursive: true });
      setTimeout(() => void fatal('start', 'The self-test did not finish within 15 minutes.'), 15 * 60_000).unref();
      try {
        await program.prepareSelfTest?.(ctx);
      } catch (e) {
        return fatal('start', `Could not prepare the self-test: ${String((e as Error)?.message ?? e)}`);
      }
    }
    hardenSession();
    startUpdates();
    fileItems = program.fileMenu(ctx);
    buildMenu();
    registerDesktopApi();
    try {
      serverPort = await startServer();
    } catch (e) {
      return fatal('start', String((e as Error)?.message ?? e));
    }
    log('server ready', { port: serverPort });
    if (rememberPort) saveServerPort(serverPort);
    win = createWindow();
    program.onWindow?.(win);
    const base = devUrl ?? `http://127.0.0.1:${serverPort}/`;
    try {
      await win.loadURL(program.page(base));
    } catch (e) {
      return fatal('page', String((e as Error)?.message ?? e));
    }
    // The quiet daily check, once the window is up (it shows something only when there is a new version).
    if (!selfTest && updates) {
      const u = updates;
      setTimeout(() => void u.checkAtStart({ selfTest: !!selfTest, disabledByEnv: !!envVar('NO_UPDATE_CHECK') }), 5000);
    }
    if (selfTest) {
      const steps = await program.selfTest({ ...ctx, base: `http://127.0.0.1:${serverPort}`, photos: selfTest.photos, out: selfTest.out, win, session: session.defaultSession, log });
      await finishSelfTest(steps);
    }
  }

  if (!app.requestSingleInstanceLock(program.singleInstanceData?.() as Record<string, unknown> | undefined)) {
    // Already running: the first copy shows its window (see 'second-instance').
    app.quit();
    return;
  }
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    // First: what is handed over while this copy is still starting waits for the page instead of being dropped.
    program.onSecondInstance?.(data);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
  app.on('window-all-closed', () => {
    if (installing) return;
    if (!selfTest && !failing) app.quit();
  });
  // Quit only after the server has closed its database.
  app.on('before-quit', (event) => {
    if (quitting) return;
    // app.exit below skips the page's beforeunload, so the program may ask about unsaved work here.
    if (!selfTest && !failing && program.confirmQuit && !program.confirmQuit()) {
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
