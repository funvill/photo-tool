// The desktop shell's decisions that need no Electron: which addresses the window may reach,
// where data lives, the remembered window place, the self-test flags, and failure wording.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { DEFAULT_WINDOW, GALLERY_APP_ID, GALLERY_PRODUCT_NAME, MIN_WINDOW, NOTICES_BUTTON, dataLayout, describeAbout, describeFailure, galleryEnv, parseMode, parseSelfTest, photoInfoFallbackDir, restoreWindow, selfTestOverlap } from '../electron/config';
import product from '../electron/product.json';
import { isAllowedRequest, isAppNavigation, requestHost } from '../electron/netGuard';

const require = createRequire(import.meta.url);

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

describe('desktop folders', () => {
  const base = { appData: resolve('/appdata'), productName: 'Photobook Studio', packaged: true, env: {} };

  it('keeps the app\'s data and Chromium\'s profile in separate folders', () => {
    const l = dataLayout(base);
    expect(l.dataDir).toBe(join(resolve('/appdata'), 'Photobook Studio', 'data'));
    expect(l.profileDir).toBe(join(resolve('/appdata'), 'Photobook Studio', 'browser'));
  });

  it('PHOTOBOOK_DATA_DIR moves the data only', () => {
    const l = dataLayout({ ...base, env: { PHOTOBOOK_DATA_DIR: resolve('/somewhere/data') } });
    expect(l.dataDir).toBe(resolve('/somewhere/data'));
    expect(l.profileDir).toBe(join(resolve('/appdata'), 'Photobook Studio', 'browser'));
  });

  it('a self-test keeps its data inside its output folder, never in a real user\'s', () => {
    for (const packaged of [true, false]) {
      const l = dataLayout({ ...base, packaged, selfTestOut: resolve('/out') });
      expect(l.dataDir).toBe(join(resolve('/out'), 'data'));
      expect(l.dataDir.startsWith(resolve('/appdata'))).toBe(false);
    }
    // Only an explicit PHOTOBOOK_DATA_DIR points a self-test anywhere else.
    expect(dataLayout({ ...base, env: { PHOTOBOOK_DATA_DIR: resolve('/somewhere/data') }, selfTestOut: resolve('/out') }).dataDir).toBe(resolve('/somewhere/data'));
  });

  it('a self-test uses its own profile, and a copy run from source its own name', () => {
    expect(dataLayout({ ...base, selfTestOut: resolve('/out') }).profileDir).toBe(join(resolve('/out'), 'profile'));
    expect(dataLayout({ ...base, env: { PHOTOBOOK_PROFILE_DIR: resolve('/p') }, selfTestOut: resolve('/out') }).profileDir).toBe(resolve('/p'));
    expect(dataLayout({ ...base, packaged: false }).dataDir).toBe(join(resolve('/appdata'), 'Photobook Studio Dev', 'data'));
  });
});

describe('self-test flags', () => {
  it('needs both folders, given explicitly', () => {
    expect(parseSelfTest(['app.exe'])).toBeNull();
    expect(parseSelfTest(['app.exe', '--self-test', 'photos'])).toBeNull();
    expect(parseSelfTest(['app.exe', '--self-test-out', 'out'])).toBeNull();
    expect(parseSelfTest(['app.exe', '--self-test', '--self-test-out', 'out'])).toBeNull();
    expect(parseSelfTest(['app.exe', '--self-test', 'photos', '--self-test-out', 'out'])).toEqual({ photos: resolve('photos'), out: resolve('out'), mode: 'editor' });
  });

  it('--gallery runs the gallery\'s self-test instead of the editor\'s', () => {
    expect(parseSelfTest(['app.exe', '--self-test', 'photos', '--self-test-out', 'out', '--gallery'])).toEqual({ photos: resolve('photos'), out: resolve('out'), mode: 'gallery' });
    expect(parseSelfTest(['app.exe', '--gallery', '--self-test', 'photos', '--self-test-out', 'out'])).toEqual({ photos: resolve('photos'), out: resolve('out'), mode: 'gallery' });
    expect(parseSelfTest(['app.exe', '--gallery'])).toBeNull();
  });

  describe("the gallery's photos and output folder must not overlap", () => {
    it('refuses the same folder', () => {
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x\\photos', 'win32')).toMatch(/same folder/);
      expect(selfTestOverlap('/home/a/photos', '/home/a/photos/', 'linux')).toMatch(/same folder/);
    });

    it('refuses an output folder inside the photos', () => {
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x\\photos\\out', 'win32')).toMatch(/inside/);
      expect(selfTestOverlap('/home/a/photos', '/home/a/photos/out', 'linux')).toMatch(/inside/);
    });

    it('refuses photos inside the output folder (its photos copy would replace them)', () => {
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x', 'win32')).toMatch(/inside/);
      expect(selfTestOverlap('D:\\', 'D:\\', 'win32')).toMatch(/same folder/);
      expect(selfTestOverlap('D:\\pics', 'D:\\', 'win32')).toMatch(/inside/);
      expect(selfTestOverlap('/home/a/photos', '/home/a', 'linux')).toMatch(/inside/);
    });

    it('allows sibling folders, even with a shared name prefix', () => {
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x\\out', 'win32')).toBeNull();
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x\\photos-out', 'win32')).toBeNull();
      expect(selfTestOverlap('/home/a/photos', '/home/a/photos-out', 'linux')).toBeNull();
    });

    it('ignores case on Windows only', () => {
      expect(selfTestOverlap('D:\\X\\Photos', 'd:\\x\\photos', 'win32')).toMatch(/same folder/);
      expect(selfTestOverlap('D:\\X\\Photos', 'd:\\x\\photos\\out', 'win32')).toMatch(/inside/);
      expect(selfTestOverlap('/home/a/Photos', '/home/a/photos', 'linux')).toBeNull();
    });

    it('prepareGalleryPhotos refuses before deleting or copying anything', async () => {
      const { prepareGalleryPhotos } = await import('../electron/selfTest');
      const root = mkdtempSync(join(tmpdir(), 'gallery-selftest-'));
      try {
        const photos = join(root, 'photos');
        mkdirSync(photos);
        writeFileSync(join(photos, 'a.jpg'), 'not really a photo');
        expect(() => prepareGalleryPhotos(photos, root)).toThrow(/inside --self-test-out/);
        expect(() => prepareGalleryPhotos(photos, photos)).toThrow(/same folder/);
        expect(() => prepareGalleryPhotos(photos, join(photos, 'out'))).toThrow(/inside the photos folder/);
        expect(readdirSync(photos)).toEqual(['a.jpg']);
        expect(readFileSync(join(photos, 'a.jpg'), 'utf8')).toBe('not really a photo');
        // Apart, it copies as before.
        const out = join(root, 'out');
        const { folder } = prepareGalleryPhotos(photos, out);
        expect(readdirSync(folder)).toEqual(['a.jpg']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe('gallery mode', () => {
  it('starts the editor unless --gallery is given', () => {
    expect(parseMode([])).toEqual({ mode: 'editor', folder: null });
    expect(parseMode(['app.exe', 'dist/desktop/app'])).toEqual({ mode: 'editor', folder: null });
  });

  it('--gallery starts the gallery, with the folder after it when there is one', () => {
    expect(parseMode(['--gallery'])).toEqual({ mode: 'gallery', folder: null });
    expect(parseMode(['app.exe', '--gallery'])).toEqual({ mode: 'gallery', folder: null });
    expect(parseMode(['--gallery', 'D:\\Pics'])).toEqual({ mode: 'gallery', folder: 'D:\\Pics' });
    expect(parseMode(['app.exe', '--gallery', '--no-sandbox'])).toEqual({ mode: 'gallery', folder: null });
  });

  it('leaves the self-test flags as they were', () => {
    const argv = ['app.exe', '--self-test', 'photos', '--self-test-out', 'out'];
    expect(parseMode(argv)).toEqual({ mode: 'editor', folder: null });
    expect(parseSelfTest(argv)).toEqual({ photos: resolve('photos'), out: resolve('out'), mode: 'editor' });
    expect(parseSelfTest(['app.exe', '--gallery', 'D:\\Pics', ...argv.slice(1)])).toEqual({ photos: resolve('photos'), out: resolve('out'), mode: 'gallery' });
  });

  it('gives the gallery its own taskbar identity, apart from the editor\'s', () => {
    expect(GALLERY_APP_ID).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
    expect(GALLERY_APP_ID).not.toBe(product.appId);
    expect(readFileSync('electron/main.ts', 'utf8')).toMatch(/setAppUserModelId\(GALLERY_APP_ID\)/);
  });

  it('keeps the gallery\'s data and profile under its own name, apart from the editor\'s', () => {
    const appData = resolve('/appdata');
    const editorEnv = { PHOTOBOOK_DATA_DIR: resolve('/editor/data'), PHOTOBOOK_PROFILE_DIR: resolve('/editor/profile') };
    expect(GALLERY_PRODUCT_NAME).toBe('Photobook Gallery');
    expect(GALLERY_PRODUCT_NAME).not.toBe(product.productName);
    const packaged = dataLayout({ appData, productName: GALLERY_PRODUCT_NAME, packaged: true, env: galleryEnv({}) });
    expect(packaged).toEqual({ dataDir: join(appData, 'Photobook Gallery', 'data'), profileDir: join(appData, 'Photobook Gallery', 'browser') });
    const source = dataLayout({ appData, productName: GALLERY_PRODUCT_NAME, packaged: false, env: galleryEnv(editorEnv) });
    // The editor's own overrides never move the gallery into the editor's folders.
    expect(source).toEqual({ dataDir: join(appData, 'Photobook Gallery Dev', 'data'), profileDir: join(appData, 'Photobook Gallery Dev', 'browser') });
    expect(dataLayout({ appData, productName: GALLERY_PRODUCT_NAME, packaged: true, env: galleryEnv({ PHOTOBOOK_GALLERY_DATA_DIR: resolve('/g/data'), PHOTOBOOK_GALLERY_PROFILE_DIR: resolve('/g/profile') }) })).toEqual({ dataDir: resolve('/g/data'), profileDir: resolve('/g/profile') });
  });

  it('keeps photo info for read-only folders with the editor\'s, so a star reaches the editor', () => {
    const appData = resolve('/appdata');
    for (const packaged of [true, false]) {
      for (const env of [{}, { PHOTOBOOK_DATA_DIR: resolve('/somewhere/data') }]) {
        const editor = dataLayout({ appData, productName: product.productName, packaged, env });
        expect(photoInfoFallbackDir(editor.dataDir)).toBe(join(editor.dataDir, 'photoinfo'));
      }
    }
    expect(photoInfoFallbackDir(dataLayout({ appData, productName: product.productName, packaged: true, env: {} }).dataDir)).toBe(join(appData, 'Photobook Studio', 'data', 'photoinfo'));
  });

  it('builds the gallery page beside the editor\'s, with the same content security policy', () => {
    const csp = (f: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(f, 'utf8'))?.[1];
    expect(csp('src/gallery/web/index.html')).toBeTruthy();
    expect(csp('src/gallery/web/index.html')).toBe(csp('src/web/index.html'));
    expect(readFileSync('vite.config.ts', 'utf8')).toContain('gallery.html');
  });
});

describe('remembered window place', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  it('starts at the default size when nothing (or nonsense) was saved', () => {
    for (const saved of [null, undefined, 'x', {}, { bounds: { x: 'a', y: 0, width: 800, height: 600 } }]) {
      expect(restoreWindow(saved, screens)).toEqual({ bounds: DEFAULT_WINDOW, maximized: false });
    }
  });

  it('reopens where it was', () => {
    expect(restoreWindow({ bounds: { x: 100, y: 50, width: 1200, height: 800 }, maximized: true }, screens)).toEqual({ bounds: { x: 100, y: 50, width: 1200, height: 800 }, maximized: true });
  });

  it('keeps the size but not the place when that screen is gone', () => {
    expect(restoreWindow({ bounds: { x: 2500, y: 50, width: 1200, height: 800 } }, screens)).toEqual({ bounds: { width: 1200, height: 800 }, maximized: false });
    expect(restoreWindow({ bounds: { x: 2500, y: 50, width: 1200, height: 800 } }, [...screens, { x: 1920, y: 0, width: 1920, height: 1040 }]).bounds.x).toBe(2500);
  });

  it('never opens smaller than the minimum', () => {
    expect(restoreWindow({ bounds: { x: 0, y: 0, width: 10, height: 10 } }, screens).bounds).toMatchObject(MIN_WINDOW);
  });
});

describe('failure wording', () => {
  const ctx = { productName: 'Photobook Studio', dataDir: 'C:\\Users\\me\\AppData\\Roaming\\Photobook Studio\\data' };

  it('says what went wrong without the stack trace', () => {
    const cases: [string, 'start' | 'run' | 'page', RegExp][] = [
      ['Error: EACCES: permission denied, mkdir \'X:\\data\'', 'start', /could not save to its data folder/],
      ['Error: unable to open database file', 'start', /could not save to its data folder/],
      ['Error: Could not load the "sharp" module using the win32-x64 runtime\nERR_DLOPEN_FAILED', 'start', /reads photos could not be loaded/],
      ['Error: App files are missing:\n  C:\\x\\web\\index.html', 'start', /files are missing or damaged/],
      ['Error: something else', 'start', /ran into a problem while starting/],
      ['The local server stopped unexpectedly (exit code 1).', 'run', /stopped unexpectedly/],
      ['ERR_CONNECTION_REFUSED', 'page', /window could not load/],
    ];
    for (const [detail, phase, expected] of cases) {
      const f = describeFailure(detail, { ...ctx, phase });
      expect(f.message, detail).toMatch(expected);
      expect(f.message + f.advice + f.title).not.toMatch(/Error:|ERR_|EACCES|\bat \w+ \(/);
      expect(f.advice.length).toBeGreaterThan(10);
    }
    expect(describeFailure('EPERM', { ...ctx, phase: 'start' }).message).toContain(ctx.dataDir);
  });

  it('talks about the gallery, not the editor or a book, in the gallery', () => {
    const gallery = { productName: GALLERY_PRODUCT_NAME, dataDir: ctx.dataDir, mode: 'gallery' as const };
    for (const phase of ['start', 'run', 'page'] as const) {
      for (const detail of ['Error: something else', 'EACCES', 'database is locked', 'ERR_DLOPEN_FAILED sharp']) {
        const f = describeFailure(detail, { ...gallery, phase });
        expect(`${f.title} ${f.message} ${f.advice}`, `${phase}: ${detail}`).not.toMatch(/\beditor\b|\bbooks?\b/i);
      }
    }
    expect(describeFailure('ERR_CONNECTION_REFUSED', { ...gallery, phase: 'page' }).title).toBe('Photobook Gallery could not show the gallery');
    expect(describeFailure('x', { ...ctx, phase: 'page' }).title).toBe('Photobook Studio could not show the editor');
  });
});

describe('desktop packaging', () => {
  const read = (f: string) => readFileSync(f, 'utf8');

  it('names the app in exactly one place', () => {
    const product = JSON.parse(read('electron/product.json'));
    expect(product.productName).toBeTruthy();
    expect(product.appId).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
    for (const f of ['electron-builder.config.cjs', 'electron/main.ts', 'electron/config.ts', 'scripts/desktop/build.mjs', 'package.json']) {
      expect(read(f), f).not.toContain(product.appId);
      expect(read(f), f).not.toContain(`'${product.productName}'`);
    }
  });

  it('ships a self-contained installer: no web installer, no updater, no crash reporter', () => {
    const code = (...files: string[]) => files.map(read).join('\n').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const config = code('electron-builder.config.cjs');
    expect(config).not.toMatch(/nsis-web|squirrel/i);
    expect(config).toMatch(/publish: null/);
    expect(config).toMatch(/asarUnpack: \[[^\]]*sharp[^\]]*@img/);
    expect(code('electron/main.ts', 'electron/preload.ts', 'electron/server-host.ts', 'electron/selfTest.ts')).not.toMatch(/crashReporter|autoUpdater|electron-updater|update-electron-app/);
    expect(JSON.stringify(JSON.parse(read('package.json')).devDependencies)).not.toMatch(/updater/);
  });

  it('the Windows installer adds a Photobook Gallery shortcut beside the editor\'s, and removes it on uninstall', () => {
    const nsh = read('electron/installer.nsh');
    const macro = (name: string) => new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(nsh)?.[1] ?? '';
    const install = macro('customInstall') + macro('addGalleryShortcuts');
    const uninstall = macro('customUnInstall') + macro('removeGalleryShortcuts');
    for (const place of ['$SMPROGRAMS', '$DESKTOP']) {
      const link = `"${place}\\Photobook Gallery.lnk"`;
      // Same program, started as the gallery, with the app's icon (index 0).
      expect(install).toContain(`CreateShortCut ${link} "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "--gallery" "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" 0`);
      expect(install).toContain(`WinShell::SetLnkAUMI ${link} "${GALLERY_APP_ID}"`);
      expect(uninstall).toContain(`Delete ${link}`);
    }
    expect(macro('customInstall')).toContain('!insertmacro addGalleryShortcuts');
    expect(macro('customUnInstall')).toContain('!insertmacro removeGalleryShortcuts');
    expect(uninstall).toContain(`WinShell::UninstAppUserModelId "${GALLERY_APP_ID}"`);
    // Uninstalling never deletes either program's data.
    expect(nsh).not.toMatch(/\$APPDATA|RMDir \/r/i);
  });

  it('the .deb adds a Photobook Gallery launcher to the applications menu', () => {
    const desktop = read('electron/linux/photobook-gallery.desktop');
    expect(desktop).toMatch(/^\[Desktop Entry\]$/m);
    expect(desktop).toMatch(/^Name=Photobook Gallery$/m);
    expect(desktop).toMatch(/^Exec=photobook-studio --gallery %F$/m);
    expect(desktop).toMatch(/^Icon=photobook-studio$/m);
    expect(desktop).toMatch(/^Type=Application$/m);
    // Only the .deb carries it (an AppImage installs no launchers), mapped by fpm into the system's menu.
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const path = require.resolve('../electron-builder.config.cjs');
      delete require.cache[path];
      const config = require(path);
      expect(config.deb.fpm).toEqual([`${resolve('electron/linux/photobook-gallery.desktop')}=/usr/share/applications/photobook-gallery.desktop`]);
      expect(config.productName).toBe('photobook-studio');
      delete require.cache[path];
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('exposes the path of a dropped file through the preload', () => {
    const preload = read('electron/preload.ts');
    expect(preload).toMatch(/pathForFile/);
    expect(preload).toContain('webUtils.getPathForFile');
  });

  it('keeps the page sandboxed', () => {
    const main = read('electron/main.ts');
    for (const setting of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'spellcheck: false', 'webviewTag: false']) expect(main).toContain(setting);
    expect(main).toContain("action: 'deny'");
    expect(main).toContain('setPermissionCheckHandler(() => false)');
  });
});

describe('Help > About', () => {
  const base = { productName: product.productName, version: '0.1.0', description: product.description, dataDir: resolve('/appdata/data'), licence: readFileSync('LICENSE', 'utf8'), repository: 'github:someone/some_project', hasNotices: true };

  it('names the app from product.json, says it stays offline, and credits the project and its licence', () => {
    const a = describeAbout(base);
    expect(a.title).toBe(`About ${product.productName}`);
    expect(a.message).toBe(`${product.productName} 0.1.0`);
    expect(a.detail).toContain(`Everything stays on this computer. ${product.productName} never uses the network.`);
    expect(a.detail).toContain(base.dataDir);
    expect(a.detail).toContain('Built from the open-source project someone/some_project on GitHub, under the MIT licence.');
    // The copyright line is the licence file's own.
    expect(a.detail).toContain(readFileSync('LICENSE', 'utf8').split(/\r?\n/).find((l) => l.startsWith('Copyright'))!);
    expect(a.buttons).toEqual(['OK', NOTICES_BUTTON]);
  });

  it('in the gallery, does not talk about books', () => {
    const a = describeAbout({ ...base, productName: GALLERY_PRODUCT_NAME, mode: 'gallery' });
    expect(a.detail).toContain(`Its thumbnails and recent folders are kept in:\n${base.dataDir}`);
    expect(a.detail).not.toMatch(/\bbooks?\b/i);
  });

  it('has no addresses in it: the app opens no links', () => {
    for (const repository of ['github:someone/some_project', 'https://example.com/someone/some_project', undefined]) {
      const a = describeAbout({ ...base, repository });
      expect(`${a.title}\n${a.message}\n${a.detail}`).not.toMatch(/https?:|www\./);
    }
  });

  it('offers the notices only when the file is there, and copes without a licence file', () => {
    const a = describeAbout({ ...base, licence: null, hasNotices: false });
    expect(a.buttons).toEqual(['OK']);
    expect(a.detail).not.toContain(NOTICES_BUTTON);
    expect(a.detail).toContain('Built from the open-source project someone/some_project on GitHub.');
    expect(a.detail).not.toMatch(/undefined|null/);
    expect(describeAbout({ ...base, repository: undefined }).detail).toContain('Free software under the MIT licence.');
  });
});
