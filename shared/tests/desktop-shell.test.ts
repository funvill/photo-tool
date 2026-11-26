// The desktop shell both programs run in (shared/electron), as far as it needs no Electron and is not
// shared/electron/config.ts's (that is shared/tests/desktop-config.test.ts): which addresses the window
// may reach, and the page's sandbox. Each program's own parts are in photo-tool/tests/photo-tool-shell.test.ts
// and photobook-editor/tests/editor-shell.test.ts; the build scripts in tests/desktop-scripts.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedRequest, isAppNavigation, requestHost } from '../electron/netGuard';

const root = resolve(__dirname, '../..');
const read = (f: string) => readFileSync(resolve(root, f), 'utf8');

describe('offline filter', () => {
  const app = { ports: new Set([51234]) };
  const dev = { ports: new Set([5174, 5173]), devTools: true };

  it('lets the window reach only the app\'s own local server', () => {
    expect(isAllowedRequest('http://127.0.0.1:51234/', app)).toBe(true);
    expect(isAllowedRequest('http://127.0.0.1:51234/api/projects?x=1', app)).toBe(true);
    expect(isAllowedRequest('ws://127.0.0.1:51234/socket', app)).toBe(true);
    expect(isAllowedRequest('data:image/png;base64,AAAA', app)).toBe(true);
    expect(isAllowedRequest('blob:http://127.0.0.1:51234/0b6c1d6e-1111-2222-3333-444455556666', app)).toBe(true);
    expect(isAllowedRequest('about:blank', app)).toBe(true);
  });

  it('cancels everything else', () => {
    for (const url of [
      'https://example.com/',
      'http://example.com/',
      'http://127.0.0.1:9/', // this computer, but not the app's port
      'http://127.0.0.1/', // port 80
      'https://127.0.0.1:51234/',
      'wss://127.0.0.1:51234/',
      'http://localhost:51234/', // a name needs a lookup; the app only uses the address
      'http://127.0.0.1.example.com:51234/',
      'http://127.0.0.1:51234@example.com/',
      'http://[::1]:51234/',
      'http://0.0.0.0:51234/',
      'http://192.168.1.10:51234/',
      'ws://example.com:51234/',
      'file:///C:/Windows/win.ini',
      'file://server/share/x.png',
      'ftp://127.0.0.1:51234/',
      'blob:https://example.com/0b6c1d6e',
      'blob:http://127.0.0.1:9/0b6c1d6e',
      'devtools://devtools/bundled/inspector.html',
      'chrome://settings',
      'about:config',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(isAllowedRequest(url, app), url).toBe(false);
    }
  });

  it('in development also allows the Vite dev server, its websocket and the developer tools', () => {
    expect(isAllowedRequest('http://127.0.0.1:5173/src/main.tsx', dev)).toBe(true);
    expect(isAllowedRequest('ws://127.0.0.1:5173/?token=abc', dev)).toBe(true);
    expect(isAllowedRequest('http://127.0.0.1:5174/api/health', dev)).toBe(true);
    expect(isAllowedRequest('devtools://devtools/bundled/inspector.html', dev)).toBe(true);
    expect(isAllowedRequest('https://example.com/', dev)).toBe(false);
    // The developer-tools allowance never reaches through a blob URL.
    expect(isAllowedRequest('blob:devtools://devtools/x', dev)).toBe(false);
  });

  it('keeps navigation inside the app\'s own origin', () => {
    const origin = 'http://127.0.0.1:51234';
    expect(isAppNavigation('http://127.0.0.1:51234/#/book/abc', origin)).toBe(true);
    expect(isAppNavigation('http://127.0.0.1:51234/api/exports/a.pdf?download=1', origin)).toBe(true);
    for (const url of ['http://127.0.0.1:9/', 'https://127.0.0.1:51234/', 'https://example.com/', 'file:///C:/x.html', 'about:blank', 'javascript:1', 'nonsense']) {
      expect(isAppNavigation(url, origin), url).toBe(false);
    }
  });

  it('names the host of a request for the tally', () => {
    expect(requestHost('http://127.0.0.1:51234/a')).toBe('127.0.0.1:51234');
    expect(requestHost('blob:http://127.0.0.1:51234/id')).toBe('blob:127.0.0.1:51234');
    expect(requestHost('data:text/plain,hi')).toBe('data:');
    expect(requestHost('https://example.com/x')).toBe('example.com');
    expect(requestHost('nope')).toBe('(invalid)');
  });
});

describe('the window', () => {
  it('keeps the page sandboxed', () => {
    const main = read('shared/electron/runDesktopApp.ts');
    for (const setting of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'spellcheck: false', 'webviewTag: false']) expect(main).toContain(setting);
    expect(main).toContain("action: 'deny'");
    expect(main).toContain('setPermissionCheckHandler(() => false)');
  });
});

describe('the local server\'s port', () => {
  const main = read('shared/electron/runDesktopApp.ts');
  const code = main
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('asks for the port serverPortRequest gives, with its fallback flag', () => {
    expect(code).toMatch(/serverPortRequest\(\{[^}]*saved:/);
    expect(code).toMatch(/\.\.\.portRequest,/);
    expect(code).not.toMatch(/port: devUrl \?/);
    // The program's own fields come after, as before.
    expect(code.indexOf('...portRequest,')).toBeLessThan(code.indexOf('...program.startMessage(ctx)'));
  });

  it('keeps it in server-port.json beside window-state.json, written to a temp file and renamed', () => {
    expect(code).toContain("join(layout.profileDir, 'server-port.json')");
    expect(code).toMatch(/parseSavedPort\(JSON\.parse\(readFileSync\(portFile\(\)/);
    expect(code).toMatch(/writeFileSync\(tmp, JSON\.stringify\(\{ port \}\)\)[\s\S]{0,80}renameSync\(tmp, portFile\(\)\)/);
    expect(code).toContain("log('could not save the server port'");
  });

  it('saves the port from ready only outside development and self-tests', () => {
    expect(code).toContain('const rememberPort = !devUrl && !selfTest;');
    expect(code).toMatch(/saved: rememberPort \? readSavedPort\(\) : null/);
    expect(code).toMatch(/serverPort = await startServer\(\);[\s\S]{0,300}if \(rememberPort\) saveServerPort\(serverPort\);/);
    // Exactly one call site, behind that guard.
    expect(code.match(/saveServerPort\(/g)).toHaveLength(2); // the definition and the guarded call
  });

  it('loads the window from the port in ready, never the saved number', () => {
    expect(code).toContain('const base = devUrl ?? `http://127.0.0.1:${serverPort}/`;');
    expect(code).toContain('`http://127.0.0.1:${serverPort}`');
    expect(code).not.toMatch(/127\.0\.0\.1:\$\{(saved|portRequest)/);
  });
});

describe('updates in the shell', () => {
  const code = read('shared/electron/runDesktopApp.ts')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  /** The body of `function name(` (or `async function name(`), up to the next line that closes at its indent. */
  const fn = (name: string) => {
    const m = new RegExp(`\\n( *)(async )?function ${name}\\(`).exec(code);
    if (!m) throw new Error(`no function ${name}`);
    const end = code.indexOf(`\n${m[1]}}`, m.index + 1);
    return code.slice(m.index, end);
  };

  it('uses electron-updater, and has no crash reporter', () => {
    expect(code).toMatch(/import \{ AppImageUpdater, autoUpdater \} from 'electron-updater';/);
    expect(code).not.toMatch(/crashReporter|update-electron-app/);
    for (const f of ['serverHost', 'selfTest', 'dataFolders', 'config', 'netGuard', 'updateRules', 'updates']) expect(read(`shared/electron/${f}.ts`), f).not.toMatch(/crashReporter|from 'electron-updater'|update-electron-app/);
  });

  it('touches the updater only when it is not a self-test', () => {
    const start = fn('startUpdates');
    expect(start).toMatch(/if \(selfTest\) return;/);
    expect(start.indexOf('if (selfTest) return;')).toBeLessThan(start.indexOf('autoUpdater'));
    expect(start.indexOf('if (selfTest) return;')).toBeLessThan(start.indexOf('new AppImageUpdater()'));
    // Everywhere else autoUpdater and AppImageUpdater are only named inside startUpdates.
    const rest = code.replace(start, '').replace("import { AppImageUpdater, autoUpdater } from 'electron-updater';", '');
    expect(rest).not.toContain('autoUpdater');
    expect(rest).not.toContain('AppImageUpdater');
  });

  it("an AppImage updates as an AppImage (APPIMAGE decides, not resources/package-type), without touching autoUpdater", () => {
    // autoUpdater is a getter that picks DebUpdater from package-type; on the AppImage path it is never read.
    expect(fn('startUpdates')).toMatch(/updateKind = updaterKind\(\{ platform: process\.platform, appImage: env\.APPIMAGE, appDir: env\.APPDIR, execPath: process\.execPath \}\);\s*const updater = updateKind === 'appimage' \? new AppImageUpdater\(\) : autoUpdater;/);
    expect(fn('startUpdates').match(/autoUpdater/g)).toHaveLength(1);
  });

  it('a failure setting up the updater (a malformed UPDATE_FEED, say) is logged and never blocks start-up', () => {
    const start = fn('startUpdates');
    expect(start).toMatch(/if \(selfTest\) return;\s*try \{/);
    expect(start).toMatch(/\} catch \(e\) \{\s*updates = null;\s*log\('[^']*', String\(e\)\);\s*\}\s*$/);
    // No updates: About offers no Check button.
    expect(code).toMatch(/canCheckForUpdates: !!updates && app\.isPackaged && !selfTest/);
  });

  it('runs the check at start a few seconds after the page loads, never in a self-test', () => {
    const main = fn('main');
    expect(main).toMatch(/if \(!selfTest && updates\)[\s\S]{0,200}\b(u|updates\??)\.checkAtStart\(\{ selfTest: !!selfTest, disabledByEnv: !!envVar\('NO_UPDATE_CHECK'\) \}\)/);
    expect(main.indexOf('await win.loadURL')).toBeLessThan(main.indexOf('checkAtStart'));
    expect(code.match(/checkAtStart\(/g)).toHaveLength(1);
  });

  it('a test feed (<PREFIX>_UPDATE_FEED) is used only when it is set', () => {
    expect(code.match(/setFeedURL\(/g)).toHaveLength(1);
    expect(fn('startUpdates')).toMatch(/const feed = envVar\('UPDATE_FEED'\);[\s\S]{0,300}if \(feed\) updater\.setFeedURL\(\{ provider: 'generic', url: feed, channel: program\.updateChannel \}\)/);
  });

  it('window-all-closed does not quit while installing; before-quit lets a quit through once quitting', () => {
    expect(code).toMatch(/app\.on\('window-all-closed', \(\) => \{\s*if \(installing\) return;/);
    expect(code).toMatch(/app\.on\('before-quit', \(event\) => \{\s*if \(quitting\) return;/);
  });

  it('prepareInstall: unsaved edits first, then closes the window for up to 10 s, then stops the server', () => {
    const p = fn('prepareInstall');
    const at = (s: string) => {
      const i = p.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('program.confirmQuit()')).toBeLessThan(at('installing = true'));
    expect(at('installing = true')).toBeLessThan(at('win.close()'));
    // Asked once: "Keep editing" returns before anything is closed; after "Close without saving" the
    // window's own unload question is not asked again, and is asked again after this close attempt.
    expect(p).toMatch(/if \(program\.confirmQuit && !program\.confirmQuit\(\)\) return false;/);
    expect(at('program.confirmQuit()')).toBeLessThan(at('program.allowClose?.(true)'));
    expect(at('program.allowClose?.(true)')).toBeLessThan(at('win.close()'));
    expect(p).toMatch(/try \{\s*while \(win[\s\S]*?\} finally \{\s*program\.allowClose\?\.\(false\);\s*\}/);
    expect(code).toMatch(/allowClose\?\(on: boolean\): void;/);
    expect(p).toMatch(/Date\.now\(\) \+ 10_000/);
    expect(p).toMatch(/while \(win && !win\.isDestroyed\(\) && Date\.now\(\) < until\)/);
    // Still open (the editor's pending save cancelled the close): nothing was stopped, and the user is told.
    expect(p).toMatch(/installing = false;[\s\S]{0,120}updateText\.stillSaving[\s\S]{0,80}return false;/);
    // quitting before the server stops, so its exit is not taken for a crash; the server stops before true.
    expect(at('win.close()')).toBeLessThan(at('quitting = true'));
    expect(at('quitting = true')).toBeLessThan(at('await stopServer()'));
    expect(at('await stopServer()')).toBeLessThan(at('return true'));
  });

  it('before anything is closed: what would make the install fail is checked, and the release page offered', () => {
    const p = fn('prepareInstall');
    const before = (s: string) => expect(p.indexOf(s), s).toBeLessThan(p.indexOf('program.confirmQuit()'));
    expect(p).toMatch(/async function prepareInstall\(\{ files \}: \{ files: string\[\] \}\): Promise<boolean>/);
    // The downloaded files, the AppImage's folder, a graphical sudo for a .deb (updateRules.installProblem).
    expect(p).toMatch(/const problem = installProblem\(\{ platform: process\.platform, kind: updateKind, files, appImage: env\.APPIMAGE, sudo, exists: existsSync, writable \}\);\s*if \(problem\) return cannotInstall\(problem\);/);
    before('installProblem(');
    // pkexec is run, so a missing polkit agent (or a closed password box) is found here, not after closing.
    expect(p).toMatch(/sudo === 'pkexec'[\s\S]{0,120}pkexecProbe\(await runForExitCode\('pkexec', \['--disable-internal-agent', 'dpkg', '--version'\]\)\)/);
    expect(p).toMatch(/if \(probe === 'dismissed'\) return false;\s*if \(probe === 'unusable'\) return cannotInstall\(updateText\.problem\.noAgent\);/);
    before('pkexecProbe(');
    expect(fn('cannotInstall')).toMatch(/updateText\.cannotInstall\(NAME, problem\)[\s\S]{0,200}shell\.openExternal\(latestReleasePage\(repo\)\)[\s\S]{0,40}return false;/);
    expect(code).not.toContain('cannotInstallDeb');
  });

  it('an install that fails after closing: says so, offers the release page, and starts the app again', () => {
    const f = fn('installFailed');
    expect(code).toMatch(/installFailed: \(reason\) => void installFailed\(reason\)/);
    // The 30 s backstop must not end the app while the message is open.
    expect(f.indexOf('clearTimeout(backstop)')).toBeLessThan(f.indexOf('await message('));
    expect(f).toMatch(/updateText\.installFailed\(NAME, reason\)[\s\S]{0,200}shell\.openExternal\(latestReleasePage\(repo\)\)/);
    expect(f).toMatch(/app\.relaunch\(relaunchOptions\(\{ kind: updateKind, appImage: env\.APPIMAGE \}\)\);\s*app\.exit\(exitCode\);/);
    expect(fn('prepareInstall')).toMatch(/backstop = setTimeout\(/);
  });

  it('the Help menu carries the update items', () => {
    expect(fn('buildMenu')).toMatch(/updates\?\.menuItems\(\)/);
  });
});

describe('F1: About', () => {
  const code = read('shared/electron/runDesktopApp.ts');

  it('F1 opens About', () => {
    expect(code).toMatch(/const aboutItem: MenuItemConstructorOptions = \{ label: `&About \$\{NAME\}`, accelerator: 'F1', click: about \};/);
  });

  it('offers Check for updates in the installed program only, and shows Electron and the platform', () => {
    expect(code).toMatch(/canCheckForUpdates: !!updates && app\.isPackaged && !selfTest/);
    expect(code).toContain('const runtime = () => `Electron ${process.versions.electron}, ${process.platform} ${process.arch}`;');
    expect(code).toContain('runtime: runtime(),');
  });

  it('F2 opens the feedback page in the browser, only when the program names its GitHub repository', () => {
    expect(code).toMatch(/const repo = githubRepo\(program\.repository\);\s*const feedback: MenuItemConstructorOptions\[\] = repo\s*\? \[\{ label: 'Send &feedback on GitHub…', accelerator: 'F2', click: \(\) => void shell\.openExternal\(feedbackUrl\(repo, \{ productName: NAME, version: app\.getVersion\(\), runtime: runtime\(\) \}\)\) \}\]\s*: \[\];/);
  });

  it("Help: the update items, then feedback (F2), then About (F1), then the program's own items, each group apart", () => {
    // The program's items are kept like the File menu's: the menu is built again when the update items change.
    expect(code).toMatch(/helpItems = program\.helpMenu\?\.\(ctx\) \?\? \[\];\s*buildMenu\(\);/);
    expect(code).toMatch(/const help = \[updateItems, feedback, \[aboutItem\], helpItems\]\.filter\(\(g\) => g\.length > 0\)\.flatMap\(\(g, i\) => \(i === 0 \? g : \[\{ type: 'separator' \}, \.\.\.g\]\)\)/);
    expect(code).toMatch(/\{ label: '&Help', submenu: help \}/);
  });

  it('its Check for updates button runs the same check as the menu item', () => {
    expect(code).toMatch(/buttons\[response\] === CHECK_UPDATES_BUTTON\) \{\s*void updates\?\.checkNow\(\);/);
  });
});

describe('the shell', () => {

  it("names neither program: each program's names come from its own product.json", () => {
    for (const product of ['photo-tool/product.json', 'photobook-editor/product.json'].map((f) => JSON.parse(read(f)))) {
      for (const f of ['shared/electron/runDesktopApp.ts', 'shared/electron/config.ts', 'scripts/desktop/build.mjs', 'package.json']) {
        expect(read(f), f).not.toContain(product.appId);
        expect(read(f), f).not.toContain(`'${product.productName}'`);
      }
    }
  });
});
