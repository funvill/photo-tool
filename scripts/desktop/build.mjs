// Build the desktop app's folder, ready to run or to package:
//
//   dist/desktop/app/        main.cjs, preload.cjs, server-host.cjs, package.json and only the
//                            node_modules that cannot be bundled (sharp, pdfkit, fontkit and
//                            what they need)
//   dist/desktop/resources/  fonts, world-atlas, the built editor and the icon (the server's
//                            resource root, see src/server/resources.ts)
//   dist/desktop/icon.png    the installer's icon
//   dist/desktop/icons/      the same icon in the sizes a Linux desktop looks for
//
//   node scripts/desktop/build.mjs            everything (run `npm run build` first)
//   node scripts/desktop/build.mjs --dev      only the three bundles, into dist/desktop/dev, for `npm run dev:desktop`
//
// Nothing is downloaded: every input is already in node_modules. (One exception, on Linux only
// and only when PHOTOBOOK_LINUX_SHARP=wasm: sharp's WebAssembly build, see ensure-sharp-wasm.mjs.)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const out = join(root, 'dist/desktop');
const dev = process.argv.includes('--dev');
// The development bundles get their own folder, so they can never be packaged by mistake.
const appDir = join(out, dev ? 'dev' : 'app');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const pkg = readJson(join(root, 'package.json'));
const product = readJson(join(root, 'electron/product.json'));

// Native or self-locating modules stay real folders in node_modules:
//   sharp    a native addon with DLLs beside it
//   pdfkit   finds its built-in font metrics and colour profile relative to its own file
//   fontkit  pdfkit's font engine; the server imports it too, and both must get the same copy
const EXTERNAL = ['sharp', 'pdfkit', 'fontkit'];

// Linux only: sharp's native binary cannot go into the package as it is. Inside Electron its
// glib calls reach the wrong copy of glib, and the memory of every image handled is never given
// back (the details and the measurements are in linux/patch-sharp.mjs). PHOTOBOOK_LINUX_SHARP
// picks what the package carries instead:
//   shim    (default) the native binary, patched to use its own glib. Full speed.
//   wasm    sharp's WebAssembly build: nothing to patch and no compiler needed, the same
//           pixels, but slow (measured: import 7 times slower, PDF export 2 times).
//   native  the native binary untouched, to check whether a newer Electron or sharp has
//           fixed the problem. Not for release.
const linuxSharp = process.platform === 'linux' ? (process.env.PHOTOBOOK_LINUX_SHARP ?? 'shim') : null;
if (linuxSharp && !['shim', 'wasm', 'native'].includes(linuxSharp)) throw new Error(`PHOTOBOOK_LINUX_SHARP must be shim, wasm or native, not "${linuxSharp}".`);
const linuxWasm = linuxSharp === 'wasm';
const SHARP_WASM = '@img/sharp-wasm32';

rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: join(appDir, 'main.cjs'), external: ['electron'] });
await build({ ...common, entryPoints: ['electron/server-host.ts'], outfile: join(appDir, 'server-host.cjs'), external: ['electron', ...EXTERNAL] });
// The preload runs in the sandboxed page process: it may only require 'electron'.
await build({ ...common, platform: 'browser', entryPoints: ['electron/preload.ts'], outfile: join(appDir, 'preload.cjs'), external: ['electron'] });

/** A package's folder, found the way Node would from `from`. */
function findPackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir || dir === root) return null;
  }
}

/** The external modules and everything they need at run time, as folders under node_modules. */
function runtimeModules() {
  const found = new Map();
  const visit = (name, from, optional) => {
    // sharp loads the WebAssembly build only when it finds no native one, so leave that out.
    if (linuxWasm && /^@img\/sharp-(libvips-)?linux/.test(name)) return;
    const dir = findPackage(name, from);
    if (!dir) {
      // Optional packages for other platforms (sharp's Linux binaries on Windows) are not installed.
      if (optional) return;
      throw new Error(`${name} (needed from ${from}) is not installed. Run npm install.`);
    }
    if (found.has(dir)) return;
    const p = readJson(join(dir, 'package.json'));
    found.set(dir, p);
    for (const dep of Object.keys(p.dependencies ?? {})) visit(dep, dir, false);
    for (const dep of Object.keys(p.optionalDependencies ?? {})) visit(dep, dir, true);
  };
  for (const name of EXTERNAL) visit(name, root, false);
  if (linuxWasm) visit(SHARP_WASM, root, false);
  return found;
}

if (linuxWasm && !dev) (await import('./ensure-sharp-wasm.mjs')).ensureSharpWasm();
// electron-builder packs only what this list leads to, so the WebAssembly build has to be on it:
// sharp itself does not name it as a dependency.
const dependencies = Object.fromEntries([...EXTERNAL, ...(linuxWasm && !dev ? [SHARP_WASM] : [])].map((name) => [name, readJson(join(findPackage(name, root), 'package.json')).version]));

// The packaged app's own package.json. No "type": the bundles are CommonJS.
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: product.productName,
      version: pkg.version,
      description: product.description,
      author: product.maintainer,
      // The .deb cannot be built without a homepage; electron-builder works one out from the
      // repository. desktopName is what Electron gives the window as its class on Linux, so the
      // desktop can tie the window to the launcher entry.
      repository: product.repository,
      desktopName: `${pkg.name}.desktop`,
      license: pkg.license,
      private: true,
      main: 'main.cjs',
      dependencies,
    },
    null,
    2,
  ) + '\n',
);

if (dev) {
  // Run from the project: Node finds sharp and the rest in the project's own node_modules.
  console.log(`Built the desktop bundles (development) in ${relative(root, appDir)}`);
} else {
  const modules = runtimeModules();
  for (const dir of modules.keys()) {
    // Copy each package without any node_modules nested in it: nested ones that are needed are
    // in the list themselves and are copied to the same nested place.
    cpSync(dir, join(appDir, relative(root, dir)), { recursive: true, filter: (src) => !/[\\/]node_modules$/.test(src) || src === dir });
  }
  if (linuxSharp === 'shim') (await import('./linux/patch-sharp.mjs')).patchSharp(appDir);
  const names = [...modules.values()].map((p) => `${p.name}@${p.version}`).sort();
  console.log(`Copied ${names.length} run-time modules: ${names.join(', ')}`);
  if (!names.some((n) => n.startsWith('@img/sharp-') && !n.startsWith('@img/sharp-libvips'))) throw new Error('No sharp binary for this platform is installed (@img/sharp-<platform>). Run npm install on the platform you are building for.');

  const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
  const run = (...args) => execFileSync(process.execPath, [tsx, ...args], { cwd: root, stdio: 'inherit' });
  const resources = join(out, 'resources');
  rmSync(resources, { recursive: true, force: true });
  run('scripts/collect-resources.ts', resources, '--web');
  run('scripts/launcher/make-icon.ts', join(out, 'icon.png'));
  cpSync(join(out, 'icon.png'), join(resources, 'icon.png'));
  // Linux launchers look an icon up by size in the "hicolor" theme, which has no 1024 px folder:
  // a .deb carrying only the big icon shows a blank launcher. Make the sizes the theme does have.
  const { default: sharp } = await import('sharp');
  const icons = join(out, 'icons');
  rmSync(icons, { recursive: true, force: true });
  mkdirSync(icons);
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) await sharp(join(out, 'icon.png')).resize(size, size).png().toFile(join(icons, `${size}x${size}.png`));
  console.log(`Built the desktop app in ${relative(root, out)}`);
}
