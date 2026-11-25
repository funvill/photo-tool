// Gather the files a packaged app needs at run time into one folder, in the layout
// shared/server/resources.ts reads when it is given a resource root:
//
//   <out>/fonts/<name>.woff               every font file the PDF export can embed (the editor)
//   <out>/world-atlas/countries-10m.json  the place outlines
//   <out>/libheif/libheif-bundle.js       the HEIC decoder (WebAssembly inside), with its licences and a package.json marking it CommonJS
//   <out>/pdfium/{index.cjs,pdfium.wasm}  the PDF renderer for image and flipbook export, with its licence (the editor)
//   <out>/LICENSE.txt                     the app's own licence
//   <out>/THIRD-PARTY-NOTICES.txt         everyone else's (scripts/make-notices.ts), opened from Help > About
//   <out>/web                             the program's built page (dist/<program>/web), with --program
//
//   npx tsx scripts/collect-resources.ts <output folder> --program photo-tool|photobook-editor
//   npx tsx scripts/collect-resources.ts <output folder> [--web]     the editor's files, the notices for every dependency
//
// With --program, only the files that program's server reads, and notices for only what its installer
// carries. Build the program's page first (`npm run build:photo-tool` or `npm run build`).
// Then start the server with PHOTOBOOK_RESOURCE_ROOT=<output folder>, or createApp(dataDir, { resourceRoot }).

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { FONT_FAMILIES, fontFilePath } from '../photobook-editor/core';
import { fontFile, libheifFile, pdfiumDir, projectRoot, setResourceRoot, webDir, worldAtlasFile } from '../shared/server/resources';
import { packageImports } from './import-graph';
import { makeNotices, reportNotices } from './make-notices';
import { PROGRAMS, programEntries, type ProgramName } from './desktop/programs.mjs';

/**
 * What each program's installer carries besides its code: the npm packages its resource files come
 * from, and whether its server embeds fonts and renders PDFs. Its code (the desktop entries, the tagging
 * worker, the page) and its product.json come from the one program table, scripts/desktop/programs.mjs.
 */
const RESOURCES: Record<ProgramName, { resourcePackages: (deps: string[]) => string[]; fonts: boolean; pdfium: boolean }> = {
  'photo-tool': { resourcePackages: () => ['world-atlas', 'libheif-js'], fonts: false, pdfium: false },
  'photobook-editor': { resourcePackages: (deps) => ['world-atlas', 'libheif-js', '@hyzyla/pdfium', ...deps.filter((d) => d.startsWith('@fontsource/'))], fonts: true, pdfium: true },
};
const args = process.argv.slice(2);
const flagValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const programName = flagValue('--program');
const outArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--program');
if (!outArg || (args.includes('--program') && !(programName && programName in PROGRAMS))) {
  console.error('Usage: npx tsx scripts/collect-resources.ts <output folder> [--program photo-tool|photobook-editor] [--web]');
  process.exit(1);
}
const program = programName as ProgramName | undefined;
const spec = program ? RESOURCES[program] : null;
const out = resolve(outArg);
const withWeb = !!program || args.includes('--web');
const withFonts = spec?.fonts ?? true;
const withPdfium = spec?.pdfium ?? true;

// Where the files are now (the source layout), whatever the environment says.
delete process.env.PHOTOBOOK_RESOURCE_ROOT;
setResourceRoot(null);
const root = projectRoot() ?? process.cwd();
const fonts = withFonts ? [...new Set(FONT_FAMILIES.flatMap((f) => f.weights.flatMap((w) => [fontFilePath(f.family, w, false), fontFilePath(f.family, w, true)])))].map(fontFile) : [];
const atlas = worldAtlasFile();
const web = webDir(program ?? 'photobook-editor');
const libheif = libheifFile();
// The licence texts travel with the engines: libheif-js and libheif itself (LGPL), PDFium's wrapper (MIT).
const libheifFiles = [libheif, join(dirname(libheif), 'LICENSE'), [join(dirname(dirname(libheif)), 'LICENSE'), 'LICENSE.libheif-js'] as const];
const pdfiumFiles = withPdfium ? [join(pdfiumDir(), 'index.cjs'), join(pdfiumDir(), 'pdfium.wasm'), join(dirname(pdfiumDir()), 'LICENSE.md')] : [];
const engines = [...libheifFiles, ...pdfiumFiles].map((f) => (typeof f === 'string' ? f : f[0]));
const licence = join(root, 'LICENSE');
const missing = [...fonts, atlas, ...engines, licence, ...(withWeb ? [join(web, 'index.html')] : [])].filter((f) => !existsSync(f));
if (missing.length) {
  const build = program === 'photo-tool' ? '`npm run build:photo-tool`' : '`npm run build`';
  console.error(`Missing (run \`npm install\`${withWeb ? ` and ${build}` : ''} first):\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

// Only the folders this script owns are replaced; anything else in <out> is left alone.
for (const dir of ['fonts', 'world-atlas', 'libheif', 'pdfium', ...(withWeb ? ['web'] : [])]) rmSync(join(out, dir), { recursive: true, force: true });
if (withFonts) {
  mkdirSync(join(out, 'fonts'), { recursive: true });
  for (const f of fonts) copyFileSync(f, join(out, 'fonts', basename(f)));
}
mkdirSync(join(out, 'world-atlas'), { recursive: true });
copyFileSync(atlas, join(out, 'world-atlas', basename(atlas)));
for (const [dir, files] of [['libheif', libheifFiles], ['pdfium', pdfiumFiles]] as const) {
  if (!files.length) continue;
  mkdirSync(join(out, dir), { recursive: true });
  for (const f of files) typeof f === 'string' ? copyFileSync(f, join(out, dir, basename(f))) : copyFileSync(f[0], join(out, dir, f[1]));
}
// libheif-bundle.js is CommonJS. Say so beside it: when <out> is inside a project whose
// package.json says "type": "module" (dist/<program>/desktop/resources here), Node would otherwise load it
// as an ES module and the decoder would not start.
writeFileSync(join(out, 'libheif', 'package.json'), '{ "type": "commonjs" }\n');
if (withWeb) cpSync(web, join(out, 'web'), { recursive: true });
// With .txt, so that a double-click (or Help > About) opens them in the system's text viewer.
copyFileSync(licence, join(out, 'LICENSE.txt'));

/** The npm packages the program's installer carries: what its code imports, and where its resource files come from. */
function runtimeModules(name: ProgramName): string[] {
  const deps = Object.keys((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {});
  // packageImports throws on an entry file that is not there: a moved entry must never quietly drop its packages.
  const imported = packageImports(programEntries(name), root);
  return [...new Set([...deps.filter((d) => imported.has(d)), ...RESOURCES[name].resourcePackages(deps)])].sort();
}
const modules = program ? runtimeModules(program) : undefined;
const productName = program ? (JSON.parse(readFileSync(join(root, PROGRAMS[program].product), 'utf8')) as { productName: string }).productName : undefined;
const notices = makeNotices(root, { modules, productName });
writeFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), notices.text);
if (modules) console.log(`${program} ships: ${modules.join(', ')}`);
console.log(reportNotices(notices, join(out, 'THIRD-PARTY-NOTICES.txt')));

const what = [withFonts && `${fonts.length} fonts`, 'world-atlas', 'libheif', withPdfium && 'PDFium', withWeb && `${program ?? 'the editor'}'s page`].filter(Boolean);
console.log(`Collected ${what.join(', ')} into ${out}`);
