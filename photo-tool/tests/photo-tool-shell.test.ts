// Photo Tool as its own desktop program: its packaging, the resource files its server needs, the
// entry points (no editor code in them), and the parts of the desktop shell only Photo Tool has
// (map tiles, its self-test photos, its page). The shared shell is tested in shared/tests.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { launchFolder, parseSelfTest, taggingWorkerPath } from '../../shared/electron/config';

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const read = (f: string) => readFileSync(resolve(root, f), 'utf8');
// Loaded by a computed path: photo-tool may import only shared, and the boundary rule would flag a static import.
const loadGraph = () => import(/* @vite-ignore */ pathToFileURL(resolve(root, 'scripts/import-graph.ts')).href) as Promise<{ importClosure(entries: string[], root: string): Set<string> }>;

/** photo-tool/electron-builder.config.cjs as electron-builder sees it on `platform`. */
function builderConfig(platform: NodeJS.Platform = process.platform) {
  const original = process.platform;
  const path = require.resolve('../electron-builder.config.cjs');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    delete require.cache[path];
    return require(path);
  } finally {
    delete require.cache[path];
    Object.defineProperty(process, 'platform', { value: original });
  }
}

/** Every file under `dir`, repo-relative, skipping node_modules. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules') continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(resolve(root, dir));
  return out;
}

describe('builder config', () => {
  it('packages Photo Tool under its own name, id and folders', () => {
    const config = builderConfig();
    expect(config.productName).toBe(process.platform === 'linux' ? 'photo-tool' : 'Photo Tool');
    expect(config.appId).toBe('app.phototool.desktop');
    expect(config.directories.app).toBe('dist/photo-tool/desktop/app');
    expect(config.directories.output).toBe('dist/installer/photo-tool');
    expect(builderConfig('linux').productName).toBe('photo-tool');
    expect(builderConfig('win32').productName).toBe('Photo Tool');
  });

  it("unpacks node_modules and the tagging worker, and adds neither the editor's installer script nor a second launcher", () => {
    const text = read('photo-tool/electron-builder.config.cjs');
    expect(text).toMatch(/asarUnpack: \[[^\]]*'node_modules\/\*\*'/);
    expect(text).not.toContain("include: 'electron/installer.nsh'");
    expect(text).not.toContain('fpm');
    const config = builderConfig('linux');
    for (const p of ['tagging-worker.cjs', 'node_modules/**']) expect(config.asarUnpack, p).toContain(p);
    expect(config.nsis.include).toBe('photo-tool/electron/installer.nsh');
    expect(config.deb?.fpm).toBeUndefined();
    expect(config.linux.desktop.entry.Name).toBe('Photo Tool');
  });

  it("its installer script only removes electron-builder's leftover installer copy: no shortcuts, no taskbar ids, no data", () => {
    const nsh = read('photo-tool/electron/installer.nsh');
    const macro = (name: string) => new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(nsh)?.[1] ?? '';
    expect(macro('removeInstallerCopy')).toContain('Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"');
    expect(macro('customInstall').trim()).toBe('!insertmacro removeInstallerCopy');
    expect(macro('customUnInstall').trim()).toBe('!insertmacro removeInstallerCopy');
    const code = nsh.split('\n').filter((l) => !/^\s*;/.test(l)).join('\n');
    expect(code).not.toMatch(/Gallery|CreateShortCut|WinShell|\$APPDATA|RMDir \/r/i);
    expect([...code.matchAll(/!macro (\w+)/g)].map((m) => m[1]).sort()).toEqual(['customInstall', 'customUnInstall', 'removeInstallerCopy']);
  });

  it('publishes to its own update channel on GitHub, whole installers only, and has no crash reporter', () => {
    const code = (...files: string[]) => files.map(read).join('\n').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const platform of ['win32', 'linux'] as const) {
      const config = builderConfig(platform);
      expect(config.publish, platform).toEqual({ provider: 'github', owner: 'funvill', repo: 'photo-tool', channel: 'photo-tool', releaseType: 'draft' });
      expect(config.nsis, platform).toMatchObject({ oneClick: true, perMachine: false, allowElevation: false, differentialPackage: false });
    }
    // Owner and repo come from product.json, never written out a second time.
    expect(code('photo-tool/electron-builder.config.cjs')).not.toMatch(/funvill|nsis-web|squirrel/i);
    expect(code('photo-tool/electron/main.ts', 'photo-tool/electron/preload.ts', 'photo-tool/electron/server-host.ts', 'photo-tool/electron/selfTest.ts')).not.toMatch(/crashReporter|update-electron-app/);
  });

  it("names the program in product.json, which the config and main read", () => {
    const product = JSON.parse(read('photo-tool/product.json'));
    expect(product).toMatchObject({ productName: 'Photo Tool', appId: 'app.phototool.desktop', maintainer: 'Photo Tool <photo-tool@localhost>', repository: 'github:funvill/photo-tool' });
    expect(product.description).toMatch(/folder of photos/);
    for (const f of ['photo-tool/electron-builder.config.cjs', 'photo-tool/electron/main.ts']) {
      expect(read(f), f).not.toContain(product.appId);
      expect(read(f).replace(/oldProductName: '[^']*'/g, ''), f).not.toContain(`'${product.productName}'`);
    }
  });

  it('photo tagging runs from plain files in the installed app (the worker beside the server bundle)', () => {
    expect(taggingWorkerPath('C:\\Program Files\\Photo Tool\\resources\\app.asar')).toBe('C:\\Program Files\\Photo Tool\\resources\\app.asar.unpacked\\tagging-worker.cjs');
    expect(taggingWorkerPath('/opt/photo-tool/resources/app.asar')).toBe('/opt/photo-tool/resources/app.asar.unpacked/tagging-worker.cjs');
    expect(taggingWorkerPath('D:\\git\\photobook\\dist\\photo-tool\\desktop\\app')).toBe('D:\\git\\photobook\\dist\\photo-tool\\desktop\\app\\tagging-worker.cjs');
    expect(read('photo-tool/electron/server-host.ts')).toMatch(/workerFile: taggingWorkerPath\(__dirname\)/);
  });
});

describe('checkPhotoToolResources', () => {
  // Exactly what Photo Tool's server reads from the resource root: its page, the place outlines
  // (shared/server/places.ts) and the HEIC decoder (shared/server/heic.ts). No fonts, no PDFium.
  const NEEDED = ['web/index.html', 'world-atlas/countries-10m.json', 'libheif/libheif-bundle.js'];
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-resources-'));
    for (const f of NEEDED) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'x');
    }
    return dir;
  };

  it('passes with exactly those files, without fonts or PDFium', async () => {
    const { checkPhotoToolResources } = await import('../electron/server-host');
    const dir = make();
    try {
      expect(() => checkPhotoToolResources(dir)).not.toThrow();
      expect(existsSync(join(dir, 'pdfium'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(NEEDED)('names %s when it is missing', async (missing) => {
    const { checkPhotoToolResources } = await import('../electron/server-host');
    const dir = make();
    try {
      rmSync(join(dir, missing));
      expect(() => checkPhotoToolResources(dir)).toThrow('App files are missing');
      expect(() => checkPhotoToolResources(dir)).toThrow(join(dir, missing));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('entry points', () => {
  it('main has no editor: the entries reach no photobook-editor/ file', async () => {
    const { importClosure } = await loadGraph();
    const closure = [...importClosure(['photo-tool/electron/main.ts', 'photo-tool/electron/server-host.ts', 'photo-tool/electron/preload.ts'], root)];
    expect(closure).toContain('photo-tool/electron/gallery.ts');
    expect(closure).toContain('photo-tool/server/app.ts');
    expect(closure.filter((f) => f.startsWith('photobook-editor/') || f.startsWith('electron/'))).toEqual([]);
  });

  it("the notices list what Photo Tool's installer carries, and none of the editor's PDF engines", async () => {
    const { packageImports } = (await import(/* @vite-ignore */ pathToFileURL(resolve(root, 'scripts/import-graph.ts')).href)) as { packageImports(entries: string[], root: string): Set<string> };
    // The same entries scripts/collect-resources.ts --program photo-tool starts from.
    const shipped = packageImports(['photo-tool/electron/main.ts', 'photo-tool/electron/server-host.ts', 'photo-tool/electron/preload.ts', 'photo-tool/server/tagging/worker.ts', 'photo-tool/web/index.html'], root);
    for (const name of ['sharp', '@huggingface/transformers', 'express', 'exifr', 'react', 'leaflet', '@fontsource/inter']) expect(shipped, name).toContain(name);
    for (const name of ['pdfkit', 'fontkit', 'pdf-lib', '@hyzyla/pdfium']) expect(shipped, name).not.toContain(name);
    expect(read('scripts/desktop/programs.mjs')).toContain("page: 'photo-tool/web/index.html'");
    expect(read('scripts/collect-resources.ts')).toContain('programEntries(name)');
  });

  it('no gallery switch: neither photo-tool/ nor shared/ mentions the old one', () => {
    const needle = ['--', 'gallery'].join('');
    const hits = [...filesUnder('photo-tool'), ...filesUnder('shared')].filter((f) => /\.(ts|tsx|cjs|mjs|js|json|html|css|md)$/.test(f) && readFileSync(f, 'utf8').includes(needle));
    expect(hits).toEqual([]);
  });

  it("Photo Tool's preload opens no other program, and has none of the editor's export functions", () => {
    const preload = read('photo-tool/electron/preload.ts');
    expect(preload).not.toContain(['open', 'Gallery'].join(''));
    expect(preload).not.toContain('desktop:open-file');
    expect(preload).not.toContain('desktop:show-in-folder');
  });

  it('exposes the gallery functions through the preload, each on its own channel', () => {
    const preload = read('photo-tool/electron/preload.ts');
    expect(preload).toContain("'desktop:pick-folder'");
    for (const channel of ['start-drag', 'prepare-drag', 'drag-failed', 'copy-text', 'copy-image', 'show-in-folder', 'trash', 'get-map-consent', 'set-map-consent', 'get-edit-target', 'set-edit-target', 'save-edit-file', 'save-edit-as', 'unsaved-edits', 'open-folder', 'ready-for-folders', 'not-ready-for-folders']) {
      expect(preload, channel).toContain(`'gallery:${channel}'`);
    }
  });
});

describe('the Photo Tool program', () => {
  const main = () => read('photo-tool/electron/main.ts');

  it('runs under its own name, taskbar identity and environment prefix, moving its data from the old name', () => {
    const m = main();
    expect(m).toMatch(/runDesktopApp\(/);
    expect(m).toContain("productName: product.productName, envPrefix: 'PHOTO_TOOL', oldProductName: 'Photobook Gallery'");
    expect(m).toContain('appUserModelId: product.appId');
    expect(m).not.toContain('PHOTOBOOK_GALLERY_');
    expect(read('shared/electron/runDesktopApp.ts')).toMatch(/setAppUserModelId\(program\.appUserModelId\)/);
  });

  it('shows its own page at the server root', () => {
    expect(main()).toContain('page: (base) => base');
    expect(main()).not.toContain('gallery.html');
    expect(read('photo-tool/electron/server-host.ts')).not.toContain('staticPage');
  });

  it('only Photo Tool may reach the tile server, and only through the map guard', () => {
    const m = main();
    expect(m).toMatch(/requestAllowed: \(url, method, guard\) => galleryRequestAllowed\(/);
    expect(m).toContain('hostResolverRules: mapHostResolverRules()');
    expect(m).not.toContain('MAP * ~NOTFOUND');
  });

  it('checks for updates on its own channel, and says so in its description', () => {
    expect(main()).toContain("updateChannel: 'photo-tool'");
    expect(JSON.parse(read('photo-tool/product.json')).description).toBe(
      'Look through a folder of photos, star the best ones and drag them into other programs. Uses the network only for map tiles (if you choose Load maps), to download photo-tagging models you ask for, and to check GitHub for a new version.',
    );
  });

  it('Restart now asks about unsaved edits once: after confirmQuit, closing the window does not ask again', () => {
    expect(main()).toContain('allowClose: (on) => edits?.allowClose(on),');
    const gallery = read('photo-tool/electron/gallery.ts');
    expect(gallery).toMatch(/w\.webContents\.on\('will-prevent-unload', \(event\) => \{\s*if \(letPageClose\(\{ count: unsaved\.get\(id\) \?\? 0, confirmed: closeConfirmed \}, \(n\) => dialog\.showMessageBoxSync\(w, unsavedClosePrompt\(n\)\) === 0\)\) event\.preventDefault\(\);/);
    expect(gallery).toMatch(/allowClose\(on: boolean\) \{\s*closeConfirmed = on;\s*\}/);
  });

  it('takes the folder to open as its first argument that is not a flag', () => {
    expect(main()).toContain('launchFolder(process.argv, !!process.defaultApp)');
    expect(launchFolder(['Photo Tool.exe', 'D:\\Pics'], false)).toBe('D:\\Pics');
    expect(launchFolder(['electron.exe', 'dist/photo-tool/desktop/dev', 'D:\\Pics'], true)).toBe('D:\\Pics');
    const argv = ['Photo Tool.exe', '--self-test', 'photos', '--self-test-out', 'out'];
    expect(launchFolder(argv, false)).toBeNull();
    expect(parseSelfTest(argv)).toEqual({ photos: resolve('photos'), out: resolve('out') });
  });

  it('says "Photo Tool" wherever a person reads its name', () => {
    expect(/<title>([^<]*)<\/title>/.exec(read('photo-tool/web/index.html'))?.[1]).toBe('Photo Tool');
    const old = ['Photobook', 'Gallery'].join(' ');
    const hits = [...filesUnder('photo-tool/web'), ...filesUnder('photo-tool/electron'), ...filesUnder('photo-tool/server')].filter((f) => readFileSync(f, 'utf8').replace(`oldProductName: '${old}'`, '').includes(old));
    expect(hits.map((f) => f.slice(root.length + 1))).toEqual([]);
    // No other old name on the page either: "Photobook" only as part of "Photobook Editor".
    const stray = filesUnder('photo-tool/web').flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ at: `${f.slice(root.length + 1)}:${i + 1}`, line }))
        .filter(({ line }) => /Photobook(?! Editor)/.test(line)),
    );
    expect(stray.map((s) => `${s.at}: ${s.line.trim()}`)).toEqual([]);
    // Only the old name to move data from is left.
    expect(main().replace("oldProductName: 'Photobook Gallery'", '')).not.toContain(old);
  });

  it('its messages call it Photo Tool, never "the gallery" (code names keep "gallery")', () => {
    const inText = /(['"`])(?:(?!\1).)*\bthe gallery\b(?:(?!\1).)*\1/i;
    const hits = [...filesUnder('photo-tool/web'), ...filesUnder('photo-tool/electron'), ...filesUnder('photo-tool/server')].flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ at: `${f.slice(root.length + 1)}:${i + 1}`, line: line.trim() }))
        .filter(({ line }) => !/^(\/\/|\/?\*)/.test(line) && inText.test(line.replace(/\s\/\/ .*$/, ''))),
    );
    expect(hits.map((h) => `${h.at}: ${h.line}`)).toEqual([]);
  });
});

describe("Photo Tool's self-test photos", () => {
  it('prepareGalleryPhotos refuses before deleting or copying anything', async () => {
    const { prepareGalleryPhotos } = await import('../electron/selfTest');
    const dir = mkdtempSync(join(tmpdir(), 'gallery-selftest-'));
    try {
      const photos = join(dir, 'photos');
      mkdirSync(photos);
      writeFileSync(join(photos, 'a.jpg'), 'not really a photo');
      expect(() => prepareGalleryPhotos(photos, dir)).toThrow(/inside --self-test-out/);
      expect(() => prepareGalleryPhotos(photos, photos)).toThrow(/same folder/);
      expect(() => prepareGalleryPhotos(photos, join(photos, 'out'))).toThrow(/inside the photos folder/);
      expect(readdirSync(photos)).toEqual(['a.jpg']);
      expect(readFileSync(join(photos, 'a.jpg'), 'utf8')).toBe('not really a photo');
      // Apart, it copies as before.
      const { folder } = prepareGalleryPhotos(photos, join(dir, 'out'));
      expect(readdirSync(folder)).toEqual(['a.jpg']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits for the open folder by its path, not by the version label beside it', () => {
    const selfTest = read('photo-tool/electron/selfTest.ts');
    expect(selfTest).toContain('.gallery-bar-title .gallery-root');
    expect(read('photo-tool/web/components/FolderBar.tsx')).toMatch(/className="muted ellipsis gallery-root"/);
  });
});

describe("Photo Tool's page", () => {
  it('has the editor\'s content security policy except map tiles as images', () => {
    const csp = (f: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read(f))?.[1];
    const gallery = csp('photo-tool/web/index.html');
    expect(gallery).toBeTruthy();
    expect(gallery).toContain("img-src 'self' blob: data: https://tile.openstreetmap.org;");
    expect(gallery!.replace(' https://tile.openstreetmap.org', '')).toBe(csp('photobook-editor/web/index.html'));
    // The server's header says the same: the tile server for images, nothing else from outside.
    const header = /'Content-Security-Policy',\s*"([^"]+)"/.exec(read('photo-tool/server/app.ts'))?.[1];
    expect(header).toContain("img-src 'self' blob: data: https://tile.openstreetmap.org;");
    expect(header!.replace(' https://tile.openstreetmap.org', '')).not.toMatch(/https?:/);
    expect(read('photo-tool/vite.config.ts')).toContain('dist/photo-tool/web');
  });

  // The built page (dist/photo-tool/web, made by `npm run build:photo-tool`; the e2e run and the desktop build make it):
  // Leaflet and its styles are bundled, so no script, style sheet or font comes from the internet.
  const web = resolve(root, 'dist/photo-tool/web');
  it.skipIf(!existsSync(join(web, 'index.html')))('the built page loads no script or style from the internet', () => {
    const html = readFileSync(join(web, 'index.html'), 'utf8');
    expect(html).not.toMatch(/\b(src|href)=["']?(https?:)?\/\//);
    const assets = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    expect(assets.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    const visit = (asset: string) => {
      if (seen.has(asset)) return;
      seen.add(asset);
      const text = readFileSync(join(web, asset), 'utf8');
      expect(text, asset).not.toMatch(/@import\s+(url\()?["']?(https?:)?\/\//);
      expect(text, asset).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
      expect(text, asset).not.toMatch(/\bimport\s*\(?\s*["'`]https?:/);
      expect(text, asset).not.toMatch(/\bfrom\s*["'`]https?:/);
      expect(text, asset).not.toMatch(/\.(src|href)\s*=\s*["'`]https?:/);
      // The only remote address in a template the page fills in is the map tile server's.
      for (const m of text.matchAll(/["'`](https?:\/\/[^"'`\s]*\{[^"'`\s]*)["'`]/g)) expect(m[1], asset).toMatch(/^https:\/\/tile\.openstreetmap\.org\//);
      for (const m of text.matchAll(/["'(]\.{0,2}\/?(assets\/[^"')]+\.(?:js|css))["')]/g)) if (existsSync(join(web, m[1]))) visit(m[1]);
    };
    assets.forEach(visit);
  });
});

describe('#9 Ctrl+C with several photos', () => {
  it('the preload exposes copyFiles on its own channel, and the handler checks the page and the open folder', () => {
    expect(read('photo-tool/electron/preload.ts')).toContain("'gallery:copy-files'");
    const gallery = read('photo-tool/electron/gallery.ts');
    const at = gallery.indexOf("ipcMain.handle('gallery:copy-files'");
    expect(at).toBeGreaterThan(0);
    const handler = gallery.slice(at, gallery.indexOf('ipcMain.handle(', at + 10));
    expect(handler).toContain('if (!allowed(e))');
    expect(handler).toContain('inOpenFolder');
    expect(handler).toContain('copyFilesRequest');
    expect(handler).toContain("'text/uri-list'");
  });
});
