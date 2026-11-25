// The desktop shell's decisions that need no Electron and are not shared/electron/config.ts's (those
// are in shared/tests/desktop-config.test.ts): which addresses the window may reach, the editor's
// program, the build scripts and the editor's packaging. Photo Tool's are in
// photo-tool/tests/photo-tool-shell.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { hostResolverRules, isAllowedRequest, isAppNavigation, requestHost } from '../shared/electron/netGuard';

const require = createRequire(import.meta.url);
// Loaded by a computed path: a plain .mjs module with no type declarations.
const loadPrograms = () => import(/* @vite-ignore */ pathToFileURL(resolve('scripts/desktop/programs.mjs')).href) as Promise<{ PROGRAM_NAMES: string[]; programArg(argv: string[]): string; withoutProgramArg(argv: string[]): string[] }>;

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

describe('the editor program', () => {
  it('may reach only its own server and looks up no name', () => {
    const main = readFileSync('electron/main.ts', 'utf8');
    const shell = readFileSync('shared/electron/runDesktopApp.ts', 'utf8');
    expect(main).toMatch(/requestAllowed: \(url, _method, guard\) => isAllowedRequest\(url, guard\)/);
    expect(main).toContain('hostResolverRules: hostResolverRules()');
    expect(hostResolverRules()).toBe('MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
    expect(shell).toContain('program.requestAllowed(');
    expect(shell).toContain("appendSwitch('host-resolver-rules', program.hostResolverRules)");
    for (const code of [main, shell]) expect(code).not.toContain('MAP * ~NOTFOUND');
  });

  it('runs under its new name, moving its data from the old name, and no longer starts Photo Tool', () => {
    const main = readFileSync('electron/main.ts', 'utf8');
    expect(main).toContain("names: { productName: 'Photobook Editor', envPrefix: 'PHOTOBOOK', oldProductName: 'Photobook Studio' }");
    expect(main).toContain("appUserModelId: 'app.photobookeditor.desktop'");
    expect(readFileSync('shared/electron/runDesktopApp.ts', 'utf8')).toMatch(/setAppUserModelId\(program\.appUserModelId\)/);
    for (const f of ['electron/main.ts', 'electron/preload.ts']) {
      const code = readFileSync(f, 'utf8');
      for (const gone of [['--', 'gallery'], ['open', 'Gallery'], ['open-', 'gallery'], ['GALLERY_', 'APP_ID']]) expect(code, f).not.toContain(gone.join(''));
    }
    expect(existsSync('electron/config.ts')).toBe(false);
  });
});

describe('desktop build scripts', () => {
  it('--program is required and must name one of the two programs', async () => {
    const { PROGRAM_NAMES, programArg, withoutProgramArg } = await loadPrograms();
    expect(PROGRAM_NAMES).toEqual(['photo-tool', 'photobook-editor']);
    expect(programArg(['node', 'build.mjs', '--program', 'photo-tool'])).toBe('photo-tool');
    expect(programArg(['node', 'build.mjs', '--dev', '--program', 'photobook-editor'])).toBe('photobook-editor');
    expect(() => programArg(['node', 'build.mjs'])).toThrow(/--program is required/);
    expect(() => programArg(['node', 'build.mjs', '--program'])).toThrow(/--program is required/);
    expect(() => programArg(['node', 'build.mjs', '--program', '--dev'])).toThrow(/--program is required/);
    expect(() => programArg(['node', 'build.mjs', '--program', 'gallery'])).toThrow(/Unknown program "gallery"/);
    // dev.mjs hands the rest to the app: Photo Tool would otherwise open a folder named after the program.
    expect(withoutProgramArg(['--program', 'photo-tool', 'D:\\Pics'])).toEqual(['D:\\Pics']);
  });

  it('every desktop script names its program; the editor keeps its commands until it is packaged apart', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    expect(scripts['desktop:build:photo-tool']).toBe('npm run build:photo-tool && node scripts/desktop/ensure-electron.mjs && node scripts/desktop/build.mjs --program photo-tool');
    expect(scripts['start:photo-tool']).toBe('electron dist/photo-tool/desktop/app');
    expect(scripts['dev:desktop:photo-tool']).toBe('node scripts/desktop/dev.mjs --program photo-tool');
    expect(scripts['dist:photo-tool']).toBe('npm run desktop:build:photo-tool && electron-builder --config photo-tool/electron-builder.config.cjs --publish never');
    expect(scripts['dist:dir:photo-tool']).toBe('npm run desktop:build:photo-tool && electron-builder --config photo-tool/electron-builder.config.cjs --publish never --dir');
    expect(scripts['desktop:build']).toContain('build.mjs --program photobook-editor');
    expect(scripts['dev:desktop']).toContain('dev.mjs --program photobook-editor');
    expect(scripts['start:desktop']).toBe('electron dist/photobook-editor/desktop/app');
    // The editor's installer packs what build.mjs makes for it.
    const path = require.resolve('../electron-builder.config.cjs');
    delete require.cache[path];
    const config = require(path);
    delete require.cache[path];
    expect(config.directories.app).toBe('dist/photobook-editor/desktop/app');
  });

  it('build.mjs maps each program to its entry files, externals and tagging worker', () => {
    const build = readFileSync('scripts/desktop/build.mjs', 'utf8');
    expect(build).toContain("main: 'photo-tool/electron/main.ts'");
    expect(build).toContain("main: 'electron/main.ts'");
    expect(build).toContain("external: ['sharp', '@huggingface/transformers']");
    expect(build).toContain("external: ['sharp', 'pdfkit', 'fontkit']");
    expect(build).toContain("taggingWorker: 'photo-tool/server/tagging/worker.ts'");
    expect(build).toContain('taggingWorker: null');
    expect(build).not.toContain('gallery.html');
    expect(readFileSync('scripts/collect-resources.ts', 'utf8')).not.toContain('gallery.html');
  });
});

describe('desktop packaging', () => {
  const read = (f: string) => readFileSync(f, 'utf8');

  it('names the app in exactly one place', () => {
    const product = JSON.parse(read('electron/product.json'));
    expect(product.productName).toBeTruthy();
    expect(product.appId).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
    for (const f of ['electron-builder.config.cjs', 'electron/main.ts', 'shared/electron/runDesktopApp.ts', 'shared/electron/config.ts', 'scripts/desktop/build.mjs', 'package.json']) {
      expect(read(f), f).not.toContain(product.appId);
      // An old name to move data from is not the app's name (product.json may still carry it until T7).
      expect(read(f).replace(/oldProductName: '[^']*'/g, ''), f).not.toContain(`'${product.productName}'`);
    }
  });

  it('ships a self-contained installer: no web installer, no updater, no crash reporter', () => {
    const code = (...files: string[]) => files.map(read).join('\n').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const config = code('electron-builder.config.cjs');
    expect(config).not.toMatch(/nsis-web|squirrel/i);
    expect(config).toMatch(/publish: null/);
    // sharp and @img (native, with DLLs) are unpacked, with the rest of node_modules.
    expect(config).toMatch(/asarUnpack: \[[^\]]*'node_modules\/\*\*'/);
    expect(code('electron/main.ts', 'electron/preload.ts', 'electron/server-host.ts', 'electron/selfTest.ts', 'shared/electron/runDesktopApp.ts', 'shared/electron/serverHost.ts', 'shared/electron/selfTest.ts', 'shared/electron/dataFolders.ts')).not.toMatch(/crashReporter|autoUpdater|electron-updater|update-electron-app/);
    expect(JSON.stringify(JSON.parse(read('package.json')).devDependencies)).not.toMatch(/updater/);
  });

  // Until the editor is packaged apart (Task 7), which drops these shortcuts: they now start the editor.
  it('the Windows installer adds a Photobook Gallery shortcut beside the editor\'s, and removes it on uninstall', () => {
    const PHOTO_TOOL_APP_ID = 'app.phototool.desktop';
    const nsh = read('electron/installer.nsh');
    const macro = (name: string) => new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(nsh)?.[1] ?? '';
    const install = macro('customInstall') + macro('addGalleryShortcuts');
    const uninstall = macro('customUnInstall') + macro('removeGalleryShortcuts');
    for (const place of ['$SMPROGRAMS', '$DESKTOP']) {
      const link = `"${place}\\Photobook Gallery.lnk"`;
      // Same program, started as the gallery, with the app's icon (index 0).
      expect(install).toContain(`CreateShortCut ${link} "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "--gallery" "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" 0`);
      expect(install).toContain(`WinShell::SetLnkAUMI ${link} "${PHOTO_TOOL_APP_ID}"`);
      expect(uninstall).toContain(`Delete ${link}`);
    }
    expect(macro('customInstall')).toContain('!insertmacro addGalleryShortcuts');
    expect(macro('customUnInstall')).toContain('!insertmacro removeGalleryShortcuts');
    expect(uninstall).toContain(`WinShell::UninstAppUserModelId "${PHOTO_TOOL_APP_ID}"`);
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
    const main = read('shared/electron/runDesktopApp.ts');
    for (const setting of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'spellcheck: false', 'webviewTag: false']) expect(main).toContain(setting);
    expect(main).toContain("action: 'deny'");
    expect(main).toContain('setPermissionCheckHandler(() => false)');
  });
});
