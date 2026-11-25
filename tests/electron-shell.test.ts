// The desktop shell's decisions that need no Electron and are not shared/electron/config.ts's (those
// are in shared/tests/desktop-config.test.ts): which addresses the window may reach, the temporary
// `--gallery` switch, Photo Tool's self-test photos, and the packaging.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { GALLERY_APP_ID, GALLERY_PRODUCT_NAME, galleryLaunchCommand, parseMode } from '../electron/config';
import product from '../electron/product.json';
import { parseSelfTest, taggingWorkerPath } from '../shared/electron/config';
import { isAllowedRequest, isAppNavigation, requestHost } from '../shared/electron/netGuard';

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

describe("Photo Tool's self-test photos", () => {
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

describe('starting the gallery from the editor', () => {
  it('runs the installed exe with --gallery on packaged Windows', () => {
    expect(galleryLaunchCommand({ execPath: 'C:\\Program Files\\Photobook Studio\\Photobook Studio.exe', packaged: true, appPath: 'C:\\Program Files\\Photobook Studio\\resources\\app.asar', env: {} })).toEqual({
      command: 'C:\\Program Files\\Photobook Studio\\Photobook Studio.exe',
      args: ['--gallery'],
    });
  });

  it('runs electron with the app folder from source', () => {
    expect(galleryLaunchCommand({ execPath: 'D:\\src\\node_modules\\electron\\dist\\electron.exe', packaged: false, appPath: 'D:\\src', env: {} })).toEqual({
      command: 'D:\\src\\node_modules\\electron\\dist\\electron.exe',
      args: ['D:\\src', '--gallery'],
    });
  });

  it('runs the AppImage itself, not the binary inside the editor\'s mount', () => {
    expect(galleryLaunchCommand({ execPath: '/tmp/.mount_PhotobXYZ/photobook-studio', packaged: true, appPath: '/tmp/.mount_PhotobXYZ/resources/app.asar', env: { APPIMAGE: '/home/a/Apps/Photobook-Studio.AppImage' } })).toEqual({
      command: '/home/a/Apps/Photobook-Studio.AppImage',
      args: ['--gallery'],
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
    expect(parseSelfTest(argv)).toEqual({ photos: resolve('photos'), out: resolve('out') });
    expect(parseMode(['app.exe', '--gallery', 'D:\\Pics', ...argv.slice(1)])).toEqual({ mode: 'gallery', folder: 'D:\\Pics' });
    expect(parseSelfTest(['app.exe', '--gallery', 'D:\\Pics', ...argv.slice(1)])).toEqual({ photos: resolve('photos'), out: resolve('out') });
  });

  it('gives the gallery its own taskbar identity, apart from the editor\'s', () => {
    expect(GALLERY_APP_ID).toBe('app.phototool.desktop');
    expect(GALLERY_APP_ID).not.toBe(product.appId);
    expect(readFileSync('electron/main.ts', 'utf8')).toMatch(/appUserModelId: GALLERY_APP_ID/);
    expect(readFileSync('shared/electron/runDesktopApp.ts', 'utf8')).toMatch(/setAppUserModelId\(program\.appUserModelId\)/);
  });

  it('runs Photo Tool under its new name and environment prefix, moving its data from the old name', () => {
    const main = readFileSync('electron/main.ts', 'utf8');
    expect(GALLERY_PRODUCT_NAME).toBe('Photo Tool');
    expect(GALLERY_PRODUCT_NAME).not.toBe(product.productName);
    expect(main).toContain("names: { productName: GALLERY_PRODUCT_NAME, envPrefix: 'PHOTO_TOOL', oldProductName: 'Photobook Gallery' }");
    expect(main).toContain("names: { productName: 'Photobook Editor', envPrefix: 'PHOTOBOOK', oldProductName: product.productName }");
    expect(main).not.toContain('PHOTOBOOK_GALLERY_');
  });

  it('builds the gallery page beside the editor\'s, with the same content security policy except map tiles as images', () => {
    const csp = (f: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(f, 'utf8'))?.[1];
    const gallery = csp('photo-tool/web/index.html');
    expect(gallery).toBeTruthy();
    expect(gallery).toContain("img-src 'self' blob: data: https://tile.openstreetmap.org;");
    expect(gallery!.replace(' https://tile.openstreetmap.org', '')).toBe(csp('photobook-editor/web/index.html'));
    // The gallery server's header says the same: the tile server for images, nothing else from outside.
    const header = /'Content-Security-Policy',\s*"([^"]+)"/.exec(readFileSync('photo-tool/server/app.ts', 'utf8'))?.[1];
    expect(header).toContain("img-src 'self' blob: data: https://tile.openstreetmap.org;");
    expect(header!.replace(' https://tile.openstreetmap.org', '')).not.toMatch(/https?:/);
    expect(readFileSync('photo-tool/vite.config.ts', 'utf8')).toContain('dist/photo-tool/web');
  });

  it('only the gallery may reach the tile server, and only through the map guard', () => {
    const main = readFileSync('electron/main.ts', 'utf8');
    const shell = readFileSync('shared/electron/runDesktopApp.ts', 'utf8');
    expect(main).toMatch(/requestAllowed: \(url, method, guard\) => galleryRequestAllowed\(/);
    expect(main).toMatch(/requestAllowed: \(url, _method, guard\) => isAllowedRequest\(url, guard\)/);
    expect(main).toContain('hostResolverRules: hostResolverRules(true)');
    expect(main).toContain('hostResolverRules: hostResolverRules(false)');
    expect(shell).toContain('program.requestAllowed(');
    expect(shell).toContain("appendSwitch('host-resolver-rules', program.hostResolverRules)");
    for (const code of [main, shell]) expect(code).not.toContain('MAP * ~NOTFOUND');
  });

  // The built page (dist/photo-tool/web, made by `vite build --config photo-tool/vite.config.ts`; the e2e run and desktop:build make it): Leaflet and
  // its styles are bundled, so no script, style sheet or font comes from the internet.
  it.skipIf(!existsSync('dist/photo-tool/web/index.html'))('the built gallery page loads no script or style from the internet', () => {
    const html = readFileSync('dist/photo-tool/web/index.html', 'utf8');
    expect(html).not.toMatch(/\b(src|href)=["']?(https?:)?\/\//);
    const assets = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    expect(assets.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    const visit = (asset: string) => {
      if (seen.has(asset)) return;
      seen.add(asset);
      const text = readFileSync(join('dist/photo-tool/web', asset), 'utf8');
      // Style sheets: no @import or url() of a remote file.
      expect(text, asset).not.toMatch(/@import\s+(url\()?["']?(https?:)?\/\//);
      expect(text, asset).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
      // Scripts: no import of a remote module, and no script or style element pointed at one.
      expect(text, asset).not.toMatch(/\bimport\s*\(?\s*["'`]https?:/);
      expect(text, asset).not.toMatch(/\bfrom\s*["'`]https?:/);
      expect(text, asset).not.toMatch(/\.(src|href)\s*=\s*["'`]https?:/);
      // The only remote address in a template the page fills in is the map tile server's.
      for (const m of text.matchAll(/["'`](https?:\/\/[^"'`\s]*\{[^"'`\s]*)["'`]/g)) expect(m[1], asset).toMatch(/^https:\/\/tile\.openstreetmap\.org\//);
      for (const m of text.matchAll(/["'(]\.{0,2}\/?(assets\/[^"')]+\.(?:js|css))["')]/g)) if (existsSync(join('dist/photo-tool/web', m[1]))) visit(m[1]);
    };
    assets.forEach(visit);
  });
});

describe('desktop packaging', () => {
  const read = (f: string) => readFileSync(f, 'utf8');

  it('names the app in exactly one place', () => {
    const product = JSON.parse(read('electron/product.json'));
    expect(product.productName).toBeTruthy();
    expect(product.appId).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
    for (const f of ['electron-builder.config.cjs', 'electron/main.ts', 'electron/config.ts', 'shared/electron/runDesktopApp.ts', 'shared/electron/config.ts', 'scripts/desktop/build.mjs', 'package.json']) {
      expect(read(f), f).not.toContain(product.appId);
      expect(read(f), f).not.toContain(`'${product.productName}'`);
    }
  });

  it('ships a self-contained installer: no web installer, no updater, no crash reporter', () => {
    const code = (...files: string[]) => files.map(read).join('\n').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const config = code('electron-builder.config.cjs');
    expect(config).not.toMatch(/nsis-web|squirrel/i);
    expect(config).toMatch(/publish: null/);
    // sharp and @img (native, with DLLs) are unpacked, with the rest of node_modules.
    expect(config).toMatch(/asarUnpack: \[[^\]]*'node_modules\/\*\*'/);
    expect(code('electron/main.ts', 'electron/preload.ts', 'electron/server-host.ts', 'electron/gallery-server-host.ts', 'electron/selfTest.ts', 'shared/electron/runDesktopApp.ts', 'shared/electron/serverHost.ts', 'shared/electron/selfTest.ts', 'shared/electron/dataFolders.ts')).not.toMatch(/crashReporter|autoUpdater|electron-updater|update-electron-app/);
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

  it('photo tagging runs from plain files in the installed app: the worker, Transformers.js and onnxruntime are unpacked from app.asar', () => {
    const path = require.resolve('../electron-builder.config.cjs');
    delete require.cache[path];
    const config = require(path);
    delete require.cache[path];
    // The worker's requires resolve on the real disk only: Transformers.js, onnxruntime and sharp's own
    // dependencies (detect-libc, semver) must all be unpacked, so all of node_modules is.
    for (const p of ['tagging-worker.cjs', 'node_modules/**']) {
      expect(config.asarUnpack, p).toContain(p);
    }
    // The worker thread is started from the unpacked copy; in development there is no app.asar.
    expect(taggingWorkerPath('C:\\Program Files\\Photobook Studio\\resources\\app.asar')).toBe('C:\\Program Files\\Photobook Studio\\resources\\app.asar.unpacked\\tagging-worker.cjs');
    expect(taggingWorkerPath('/opt/photobook-studio/resources/app.asar')).toBe('/opt/photobook-studio/resources/app.asar.unpacked/tagging-worker.cjs');
    expect(taggingWorkerPath('D:\\git\\photobook\\dist\\desktop\\app')).toBe('D:\\git\\photobook\\dist\\desktop\\app\\tagging-worker.cjs');
    expect(read('electron/gallery-server-host.ts')).toMatch(/workerFile: taggingWorkerPath\(__dirname\)/);
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

  it('exposes the gallery edit functions through the preload, each on its own channel', () => {
    const preload = read('electron/preload.ts');
    for (const channel of ['get-edit-target', 'set-edit-target', 'save-edit-file', 'save-edit-as', 'unsaved-edits']) expect(preload).toContain(`'gallery:${channel}'`);
  });

  it('keeps the page sandboxed', () => {
    const main = read('shared/electron/runDesktopApp.ts');
    for (const setting of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'spellcheck: false', 'webviewTag: false']) expect(main).toContain(setting);
    expect(main).toContain("action: 'deny'");
    expect(main).toContain('setPermissionCheckHandler(() => false)');
  });
});
