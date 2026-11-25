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
// The editor's entry files stay in electron/ until it is packaged apart (Task 7).
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
    product: 'electron/product.json',
    main: 'electron/main.ts',
    serverHost: 'electron/server-host.ts',
    preload: 'electron/preload.ts',
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
