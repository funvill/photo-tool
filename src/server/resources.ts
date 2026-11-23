import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Where the files the server reads at run time live: the font .woff files the PDF export embeds,
// the world-atlas outlines, the built editor, and the two WebAssembly engines (libheif for HEIC
// photos, PDFium for turning the print PDF into pictures). Nothing here runs when the module loads, so a
// host (a packaged app, a bundle) can point it somewhere else before the first use.
//
// From source (the default, no configuration): the project's own folders.
//   <project>/node_modules/@fontsource/<pkg>/files/<name>.woff
//   <project>/node_modules/world-atlas/countries-10m.json
//   <project>/dist/web
//   <project>/node_modules/libheif-js/libheif-wasm/libheif-bundle.js
//   <project>/node_modules/@hyzyla/pdfium/dist/{index.cjs,pdfium.wasm}
// With a resource root (createApp's `resourceRoot`, setResourceRoot(), or PHOTOBOOK_RESOURCE_ROOT),
// the flat layout scripts/collect-resources.ts writes:
//   <root>/fonts/<name>.woff
//   <root>/world-atlas/countries-10m.json
//   <root>/web
//   <root>/libheif/libheif-bundle.js
//   <root>/pdfium/{index.cjs,pdfium.wasm}

let configured: string | null = null;
let project: string | null | undefined;

/** Point the server at a packaged resource folder. Call before the first export or place lookup. */
export function setResourceRoot(dir: string | null) {
  configured = dir ? resolve(dir) : null;
}

/** The packaged resource folder, or null when running from source. */
export function resourceRoot(): string | null {
  return configured ?? (process.env.PHOTOBOOK_RESOURCE_ROOT ? resolve(process.env.PHOTOBOOK_RESOURCE_ROOT) : null);
}

/**
 * The project folder when running from source: the nearest folder holding the font packages,
 * looking up from the script that was started and then from the working directory. (Not
 * `import.meta.url`: it is empty or wrong once the server is bundled.) Null when there is none.
 */
export function projectRoot(): string | null {
  if (project !== undefined) return project;
  for (const start of [process.argv[1] && dirname(resolve(process.argv[1])), process.cwd()]) {
    for (let dir = start; dir; dir = dirname(dir) === dir ? '' : dirname(dir)) {
      if (existsSync(join(dir, 'node_modules', '@fontsource'))) return (project = dir);
    }
  }
  return (project = null);
}

function sourcePath(...parts: string[]): string {
  const root = projectRoot();
  if (!root) throw new Error('The app\'s fonts and data files were not found. Set PHOTOBOOK_RESOURCE_ROOT to the folder that holds them.');
  return join(root, ...parts);
}

/** The file on disk for a font path from core's fontFilePath(). */
export function fontFile(file: string): string {
  const root = resourceRoot();
  return root ? join(root, 'fonts', basename(file)) : sourcePath(file);
}

/** The world-atlas topology the place outlines are built from. */
export function worldAtlasFile(): string {
  const root = resourceRoot();
  return root ? join(root, 'world-atlas', 'countries-10m.json') : sourcePath('node_modules', 'world-atlas', 'countries-10m.json');
}

/** The built editor (`npm run build`). */
export function webDir(): string {
  const root = resourceRoot();
  return root ? join(root, 'web') : sourcePath('dist', 'web');
}

/**
 * libheif, the HEIC decoder: one script with its WebAssembly inside, loaded from disk at run time
 * (it is LGPL, so it stays a separate, replaceable file rather than part of the server bundle).
 */
export function libheifFile(): string {
  const root = resourceRoot();
  return root ? join(root, 'libheif', 'libheif-bundle.js') : sourcePath('node_modules', 'libheif-js', 'libheif-wasm', 'libheif-bundle.js');
}

/** The folder holding PDFium: `index.cjs` (the loader) and `pdfium.wasm`. */
export function pdfiumDir(): string {
  const root = resourceRoot();
  return root ? join(root, 'pdfium') : sourcePath('node_modules', '@hyzyla', 'pdfium', 'dist');
}
