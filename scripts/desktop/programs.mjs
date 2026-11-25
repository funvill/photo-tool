// The two desktop programs the build scripts know: the one table of each program's files, read by
// scripts/desktop/build.mjs (what to bundle) and scripts/collect-resources.ts (whose packages its
// notices list), and the `--program <name>` argument that picks one. Types: programs.d.mts.
//
// Native or self-locating modules stay real folders in node_modules (`external`):
//   sharp    a native addon with DLLs beside it (both programs)
//   pdfkit   finds its built-in font metrics and colour profile relative to its own file (the editor)
//   fontkit  pdfkit's font engine; the server imports it too, and both must get the same copy (the editor)
//   @huggingface/transformers  photo tagging (Photo Tool's tagging worker); it loads onnxruntime-node,
//            a native addon with DLLs beside it
//
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

export const PROGRAMS = {
  'photo-tool': {
    product: 'photo-tool/product.json',
    main: 'photo-tool/electron/main.ts',
    serverHost: 'photo-tool/electron/server-host.ts',
    preload: 'photo-tool/electron/preload.ts',
    taggingWorker: 'photo-tool/server/tagging/worker.ts',
    page: 'photo-tool/web/index.html',
    external: ['sharp', '@huggingface/transformers'],
  },
  'photobook-editor': {
    product: 'photobook-editor/product.json',
    main: 'photobook-editor/electron/main.ts',
    serverHost: 'photobook-editor/electron/server-host.ts',
    preload: 'photobook-editor/electron/preload.ts',
    taggingWorker: null,
    page: 'photobook-editor/web/index.html',
    external: ['sharp', 'pdfkit', 'fontkit'],
  },
};

export const PROGRAM_NAMES = Object.keys(PROGRAMS);

/** Every file a program's installer is built from: its desktop entries, the tagging worker and its page. */
export function programEntries(name) {
  const p = PROGRAMS[name];
  if (!p) throw new Error(`Unknown program "${name}".`);
  return [p.main, p.serverHost, p.preload, ...(p.taggingWorker ? [p.taggingWorker] : []), p.page];
}

/**
 * The program named by `--program <name>` in `argv`. Throws when it is missing or unknown, so a build
 * never quietly builds the wrong program.
 */
export function programArg(argv) {
  const i = argv.indexOf('--program');
  const name = i >= 0 ? argv[i + 1] : undefined;
  if (!name || name.startsWith('--')) throw new Error(`--program is required: ${PROGRAM_NAMES.join(' or ')}.`);
  if (!PROGRAM_NAMES.includes(name)) throw new Error(`Unknown program "${name}": --program takes ${PROGRAM_NAMES.join(' or ')}.`);
  return name;
}

/** `argv` without `--program <name>`: what is left is for the program itself. */
export function withoutProgramArg(argv) {
  const i = argv.indexOf('--program');
  return i < 0 ? [...argv] : [...argv.slice(0, i), ...argv.slice(i + 2)];
}

// Never loaded in Node: Transformers.js carries its own copy of the web runtime inside its Node build,
// so the onnxruntime-web package (140 MB) is left out.
const NOT_NEEDED = new Set(['onnxruntime-web']);

/** A package's folder, found the way Node would from `from`. */
export function findPackage(name, from, root = ROOT) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir || dir === root) return null;
  }
}

/**
 * A program's external modules and everything they need at run time, as folders under node_modules
 * (folder -> its package.json): what build.mjs copies into the app folder, and so all the installer
 * carries of node_modules. `skip(name)` leaves a package out (sharp's native Linux build when the
 * WebAssembly one goes instead); `extra` are more packages to start from.
 */
export function runtimeModules(name, { root = ROOT, skip = () => false, extra = [] } = {}) {
  const p = PROGRAMS[name];
  if (!p) throw new Error(`Unknown program "${name}".`);
  const found = new Map();
  const visit = (pkg, from, optional) => {
    if (NOT_NEEDED.has(pkg) || skip(pkg)) return;
    const dir = findPackage(pkg, from, root);
    if (!dir) {
      // Optional packages for other platforms (sharp's Linux binaries on Windows) are not installed.
      if (optional) return;
      throw new Error(`${pkg} (needed from ${from}) is not installed. Run npm install.`);
    }
    if (found.has(dir)) return;
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    found.set(dir, json);
    for (const dep of Object.keys(json.dependencies ?? {})) visit(dep, dir, false);
    for (const dep of Object.keys(json.optionalDependencies ?? {})) visit(dep, dir, true);
  };
  for (const pkg of [...p.external, ...extra]) visit(pkg, root, false);
  return found;
}

/** The names of the packages runtimeModules(name) finds, sorted, each once. */
export function runtimeModuleNames(name) {
  return [...new Set([...runtimeModules(name).values()].map((p) => p.name))].sort();
}
