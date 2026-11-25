// Gather the files a packaged app needs at run time into one folder, in the layout
// shared/server/resources.ts reads when it is given a resource root:
//
//   <out>/fonts/<name>.woff               every font file the PDF export can embed
//   <out>/world-atlas/countries-10m.json  the place outlines
//   <out>/libheif/libheif-bundle.js       the HEIC decoder (WebAssembly inside), with its licences and a package.json marking it CommonJS
//   <out>/pdfium/{index.cjs,pdfium.wasm}  the PDF renderer for image and flipbook export, with its licence
//   <out>/LICENSE.txt                     the app's own licence
//   <out>/THIRD-PARTY-NOTICES.txt         everyone else's (scripts/make-notices.ts), opened from Help > About
//   <out>/web                             the built editor, only with --web (run `npm run build` first)
//
//   npx tsx scripts/collect-resources.ts <output folder> [--web]
//
// Then start the server with PHOTOBOOK_RESOURCE_ROOT=<output folder>, or createApp(dataDir, { resourceRoot }).

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { FONT_FAMILIES, fontFilePath } from '../src/core';
import { fontFile, libheifFile, pdfiumDir, projectRoot, setResourceRoot, webDir, worldAtlasFile } from '../shared/server/resources';
import { makeNotices, reportNotices } from './make-notices';

const args = process.argv.slice(2);
const outArg = args.find((a) => !a.startsWith('--'));
if (!outArg) {
  console.error('Usage: npx tsx scripts/collect-resources.ts <output folder> [--web]');
  process.exit(1);
}
const out = resolve(outArg);
const withWeb = args.includes('--web');

// Where the files are now (the source layout), whatever the environment says.
delete process.env.PHOTOBOOK_RESOURCE_ROOT;
setResourceRoot(null);
const fonts = [...new Set(FONT_FAMILIES.flatMap((f) => f.weights.flatMap((w) => [fontFilePath(f.family, w, false), fontFilePath(f.family, w, true)])))].map(fontFile);
const atlas = worldAtlasFile();
const web = webDir();
const libheif = libheifFile();
// The licence texts travel with the engines: libheif-js and libheif itself (LGPL), PDFium's wrapper (MIT).
const libheifFiles = [libheif, join(dirname(libheif), 'LICENSE'), [join(dirname(dirname(libheif)), 'LICENSE'), 'LICENSE.libheif-js'] as const];
const pdfiumFiles = [join(pdfiumDir(), 'index.cjs'), join(pdfiumDir(), 'pdfium.wasm'), join(dirname(pdfiumDir()), 'LICENSE.md')];
const engines = [...libheifFiles, ...pdfiumFiles].map((f) => (typeof f === 'string' ? f : f[0]));
const licence = join(projectRoot() ?? process.cwd(), 'LICENSE');
const missing = [...fonts, atlas, ...engines, licence, ...(withWeb ? [join(web, 'index.html')] : [])].filter((f) => !existsSync(f));
if (missing.length) {
  console.error(`Missing (run \`npm install\`${withWeb ? ' and `npm run build`' : ''} first):\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

// Only the folders this script owns are replaced; anything else in <out> is left alone.
for (const dir of ['fonts', 'world-atlas', 'libheif', 'pdfium', ...(withWeb ? ['web'] : [])]) rmSync(join(out, dir), { recursive: true, force: true });
mkdirSync(join(out, 'fonts'), { recursive: true });
mkdirSync(join(out, 'world-atlas'), { recursive: true });
for (const f of fonts) copyFileSync(f, join(out, 'fonts', basename(f)));
copyFileSync(atlas, join(out, 'world-atlas', basename(atlas)));
for (const [dir, files] of [['libheif', libheifFiles], ['pdfium', pdfiumFiles]] as const) {
  mkdirSync(join(out, dir), { recursive: true });
  for (const f of files) typeof f === 'string' ? copyFileSync(f, join(out, dir, basename(f))) : copyFileSync(f[0], join(out, dir, f[1]));
}
// libheif-bundle.js is CommonJS. Say so beside it: when <out> is inside a project whose
// package.json says "type": "module" (dist/desktop/resources here), Node would otherwise load it
// as an ES module and the decoder would not start.
writeFileSync(join(out, 'libheif', 'package.json'), '{ "type": "commonjs" }\n');
if (withWeb) cpSync(web, join(out, 'web'), { recursive: true });
// With .txt, so that a double-click (or Help > About) opens them in the system's text viewer.
copyFileSync(licence, join(out, 'LICENSE.txt'));
const notices = makeNotices();
writeFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), notices.text);
console.log(reportNotices(notices, join(out, 'THIRD-PARTY-NOTICES.txt')));

console.log(`Collected ${fonts.length} fonts, world-atlas, libheif, PDFium${withWeb ? ' and the editor' : ''} into ${out}`);
