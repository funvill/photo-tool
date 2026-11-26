// Photobook Editor as its own desktop program: its packaging, its installer script, its entry points
// (no Photo Tool code in them), its preload and the parts of the desktop shell only the editor has
// (opening exports). The shared shell is tested in shared/tests; Photo Tool's in photo-tool/tests.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hostResolverRules } from '../../shared/electron/netGuard';

const require = createRequire(import.meta.url);
const root = resolve(__dirname, '../..');
const read = (f: string) => readFileSync(resolve(root, f), 'utf8');
// Loaded by a computed path: photobook-editor may import only shared, and the boundary rule would flag a static import.
const loadScript = <T>(f: string) => import(/* @vite-ignore */ pathToFileURL(resolve(root, f)).href) as Promise<T>;
const loadPrograms = () => loadScript<{ runtimeModuleNames(name: string): string[]; programEntries(name: string): string[] }>('scripts/desktop/programs.mjs');

/** photobook-editor/electron-builder.config.cjs as electron-builder sees it on `platform`. */
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

/** Every file under `dir`, skipping node_modules. */
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

/** Source text without its comment lines. */
const code = (...files: string[]) => files.map(read).join('\n').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|;)/.test(l)).join('\n');

describe('builder config', () => {
  it('packages the editor under its own name, id and folders', () => {
    const config = builderConfig();
    expect(config.productName).toBe(process.platform === 'linux' ? 'photobook-editor' : 'Photobook Editor');
    expect(config.appId).toBe('app.photobookeditor.desktop');
    expect(config.nsis.include).toBe('photobook-editor/electron/installer.nsh');
    expect(config.directories.app).toBe('dist/photobook-editor/desktop/app');
    expect(config.directories.output).toBe('dist/installer/photobook-editor');
    expect(builderConfig('linux').productName).toBe('photobook-editor');
    expect(builderConfig('win32').productName).toBe('Photobook Editor');
    expect(builderConfig('linux').linux.desktop.entry.Name).toBe('Photobook Editor');
  });

  it('unpacks node_modules only: no tagging worker, no onnxruntime trimming, no second launcher', () => {
    const config = builderConfig('linux');
    expect(config.asarUnpack).toEqual(['node_modules/**']);
    expect(config.deb?.fpm).toBeUndefined();
    const text = read('photobook-editor/electron-builder.config.cjs');
    expect(text).not.toMatch(/tagging|onnxruntime|fpm/i);
  });

  it('publishes to its own update channel on GitHub, whole installers only, and has no crash reporter', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const config = builderConfig(platform);
      expect(config.publish, platform).toEqual({ provider: 'github', owner: 'funvill', repo: 'photo-tool', channel: 'photobook-editor', releaseType: 'draft' });
      expect(config.nsis, platform).toMatchObject({ oneClick: true, perMachine: false, allowElevation: false, differentialPackage: false });
    }
    // Owner and repo come from product.json, never written out a second time.
    expect(code('photobook-editor/electron-builder.config.cjs')).not.toMatch(/funvill|nsis-web|squirrel/i);
    expect(code('photobook-editor/electron/main.ts', 'photobook-editor/electron/preload.ts', 'photobook-editor/electron/server-host.ts', 'photobook-editor/electron/selfTest.ts')).not.toMatch(/crashReporter|update-electron-app/);
    // electron-updater runs in the installed program: a run-time dependency, at one exact version.
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies['electron-updater']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.stringify(pkg.devDependencies)).not.toMatch(/updater/);
  });

  it('names the program in product.json, which the config and main read', () => {
    const product = JSON.parse(read('photobook-editor/product.json'));
    expect(product).toEqual({
      productName: 'Photobook Editor',
      appId: 'app.photobookeditor.desktop',
      description: 'Make a photobook from a folder of photos and export print-ready PDFs. Works offline.',
      maintainer: 'Photobook Editor <photobook-editor@localhost>',
      repository: 'github:funvill/photo-tool',
    });
    for (const f of ['photobook-editor/electron-builder.config.cjs', 'photobook-editor/electron/main.ts']) {
      expect(read(f), f).not.toContain(product.appId);
      expect(read(f).replace(/oldProductName: '[^']*'/g, ''), f).not.toContain(`'${product.productName}'`);
    }
  });

  it('the root has no installer config of its own any more', () => {
    expect(existsSync(resolve(root, 'electron-builder.config.cjs'))).toBe(false);
  });
});

describe('installer.nsh', () => {
  const nsh = () => read('photobook-editor/electron/installer.nsh');

  it('has no gallery shortcuts', () => {
    expect(nsh()).not.toContain('Gallery');
    expect(nsh()).not.toContain(['--', 'gallery'].join(''));
  });

  it("only removes electron-builder's leftover installer copy: no shortcuts, no taskbar ids (not Photo Tool's), no data", () => {
    const text = nsh();
    const macro = (name: string) => new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(text)?.[1] ?? '';
    expect(macro('removeInstallerCopy')).toContain('Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"');
    expect(macro('customInstall').trim()).toBe('!insertmacro removeInstallerCopy');
    expect(macro('customUnInstall').trim()).toBe('!insertmacro removeInstallerCopy');
    const body = text.split('\n').filter((l) => !/^\s*;/.test(l)).join('\n');
    expect(body).not.toMatch(/CreateShortCut|WinShell|app\.phototool|\$APPDATA|RMDir \/r/i);
    expect([...body.matchAll(/!macro (\w+)/g)].map((m) => m[1]).sort()).toEqual(['customInstall', 'customUnInstall', 'removeInstallerCopy']);
  });
});

describe('no Open Gallery', () => {
  it('nothing in photobook-editor/, shared/ or photo-tool/ opens the gallery from the editor', () => {
    const needles = [['open', 'Gallery'], ['open-', 'gallery'], ['Open &', 'Gallery']].map((p) => p.join(''));
    const hits = ['photobook-editor', 'shared', 'photo-tool']
      .flatMap(filesUnder)
      .filter((f) => /\.(ts|tsx|cjs|mjs|js|json|html|css|nsh|desktop)$/.test(f))
      .flatMap((f) => needles.filter((n) => readFileSync(f, 'utf8').includes(n)).map((n) => `${f.slice(root.length + 1)}: ${n}`));
    expect(hits).toEqual([]);
  });
});

describe('the editor carries no onnxruntime', () => {
  it("the editor's run-time modules have no onnxruntime-* or @huggingface/*, Photo Tool's do", async () => {
    const { runtimeModuleNames } = await loadPrograms();
    const editor = runtimeModuleNames('photobook-editor');
    expect(editor).toContain('sharp');
    expect(editor).toContain('pdfkit');
    expect(editor.filter((n) => /^onnxruntime-|^@huggingface\//.test(n))).toEqual([]);
    expect(runtimeModuleNames('photo-tool')).toContain('onnxruntime-node');
  });
});

describe('entry points', () => {
  it('the program table names the editor\'s own files', async () => {
    const { programEntries } = await loadPrograms();
    expect(programEntries('photobook-editor')).toEqual(['photobook-editor/electron/main.ts', 'photobook-editor/electron/server-host.ts', 'photobook-editor/electron/preload.ts', 'photobook-editor/web/index.html']);
    expect(read('scripts/desktop/programs.mjs')).toContain("product: 'photobook-editor/product.json'");
  });

  it('main has no Photo Tool: the entries reach no photo-tool/ file', async () => {
    const { importClosure } = await loadScript<{ importClosure(entries: string[], root: string): Set<string> }>('scripts/import-graph.ts');
    const closure = [...importClosure(['photobook-editor/electron/main.ts', 'photobook-editor/electron/server-host.ts', 'photobook-editor/electron/preload.ts'], root)];
    expect(closure).toContain('photobook-editor/server/app.ts');
    expect(closure.filter((f) => f.startsWith('photo-tool/'))).toEqual([]);
  });

  it("the preload exposes only the editor's functions, as a Pick of DesktopApi", () => {
    const preload = read('photobook-editor/electron/preload.ts');
    expect(preload).toMatch(/Pick<DesktopApi, 'version' \| 'pickFolder' \| 'pathForFile' \| 'openFile' \| 'showInFolder'> & Partial<DesktopApi>/);
    for (const channel of ["'desktop:pick-folder'", "'desktop:open-file'", "'desktop:show-in-folder'"]) expect(preload).toContain(channel);
    expect(preload).toContain('webUtils.getPathForFile');
    expect(preload).not.toContain("'gallery:");
    expect(preload).not.toMatch(/startDrag|onOpenFolder|trashPhotos/);
  });

  it('the server host passes the shared photo-info folder to createApp, which requires it', () => {
    expect(read('photobook-editor/electron/server-host.ts')).toContain('photoInfoFallbackDir: msg.photoInfoFallbackDir');
    expect(read('photobook-editor/server/app.ts')).toMatch(/^\s*photoInfoFallbackDir: string;/m);
    expect(read('photobook-editor/server/app.ts')).not.toContain("join(dataDir, 'photoinfo')");
  });
});

describe('the editor program', () => {
  const main = () => read('photobook-editor/electron/main.ts');

  it('runs under its new name and taskbar identity, moving its data from the old name', () => {
    expect(main()).toMatch(/runDesktopApp\(/);
    expect(main()).toContain("names: { productName: product.productName, envPrefix: 'PHOTOBOOK', oldProductName: 'Photobook Studio' }");
    expect(main()).toContain('appUserModelId: product.appId');
    expect(read('shared/electron/runDesktopApp.ts')).toMatch(/setAppUserModelId\(program\.appUserModelId\)/);
  });

  it('may reach only its own server and looks up no name', () => {
    const shell = read('shared/electron/runDesktopApp.ts');
    expect(main()).toMatch(/requestAllowed: \(url, _method, guard\) => isAllowedRequest\(url, guard\)/);
    expect(main()).toContain('hostResolverRules: hostResolverRules()');
    expect(hostResolverRules()).toBe('MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
    for (const c of [main(), shell]) expect(c).not.toContain('MAP * ~NOTFOUND');
  });

  it('opens and shows exports itself: the shared shell no longer has those handlers', () => {
    expect(main()).toContain("'desktop:open-file'");
    expect(main()).toContain("'desktop:show-in-folder'");
    const shell = read('shared/electron/runDesktopApp.ts');
    expect(shell).not.toContain("'desktop:open-file'");
    expect(shell).not.toContain("'desktop:show-in-folder'");
  });

  it('says "Photobook Editor" in the window title, on the home page and when asking to reopen it', () => {
    expect(/<title>([^<]*)<\/title>/.exec(read('photobook-editor/web/index.html'))?.[1]).toBe('Photobook Editor');
    expect(read('photobook-editor/web/components/Home.tsx')).toContain('<h1>Photobook Editor</h1>');
    expect(read('photobook-editor/web/main.tsx')).toContain('Quit and reopen Photobook Editor.');
    // Only the old name to move data from is left in the desktop program.
    for (const f of ['photobook-editor/web/index.html', 'photobook-editor/web/components/Home.tsx', 'photobook-editor/web/main.tsx', ...filesUnder('photobook-editor/electron').map((f) => f.slice(root.length + 1))]) {
      expect(read(f).replace("oldProductName: 'Photobook Studio'", ''), f).not.toContain('Photobook Studio');
    }
  });

  it('says "Photobook Editor" in everything else a person reads: PDFs, flipbooks, page designs, messages, the Mac launcher', () => {
    // Kept: the name to move data from, and the header stored in backup files (old backups must still open).
    const kept = /oldProductName: 'Photobook Studio'|app: 'Photobook Studio'/g;
    const files = [...['core', 'server', 'shared', 'web', 'electron'].flatMap((d) => filesUnder(`photobook-editor/${d}`)), ...filesUnder('scripts/launcher'), resolve(root, 'scripts/make-launcher.sh')];
    const hits = files.filter((f) => readFileSync(f, 'utf8').replace(kept, '').includes('Photobook Studio'));
    expect(hits.map((f) => f.slice(root.length + 1))).toEqual([]);
  });

  it('has no gallery switch and no Open Gallery', () => {
    for (const f of ['photobook-editor/electron/main.ts', 'photobook-editor/electron/preload.ts']) {
      const c = read(f);
      for (const gone of [['--', 'gallery'], ['open', 'Gallery'], ['open-', 'gallery'], ['GALLERY_', 'APP_ID']]) expect(c, f).not.toContain(gone.join(''));
    }
  });
});

describe('npm scripts', () => {
  it('every editor desktop script names the editor; the unnamed ones are gone and dist:all builds both', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['desktop:build:editor']).toBe('npm run build:editor && node scripts/desktop/ensure-electron.mjs && node scripts/desktop/build.mjs --program photobook-editor');
    expect(scripts['start:editor']).toBe('electron dist/photobook-editor/desktop/app');
    expect(scripts['dev:desktop:editor']).toBe('node scripts/desktop/dev.mjs --program photobook-editor');
    expect(scripts['dist:editor']).toBe('npm run desktop:build:editor && electron-builder --config photobook-editor/electron-builder.config.cjs --publish never');
    expect(scripts['dist:dir:editor']).toBe('npm run desktop:build:editor && electron-builder --config photobook-editor/electron-builder.config.cjs --publish never --dir');
    expect(scripts['dist:all']).toBe('npm run dist:photo-tool && npm run dist:editor');
    for (const gone of ['desktop:build', 'start:desktop', 'dev:desktop', 'dist', 'dist:dir']) expect(scripts[gone], gone).toBeUndefined();
  });
});
