// Write THIRD-PARTY-NOTICES.txt: the licences of everything the app ships that is not its own code.
//
//   npx tsx scripts/make-notices.ts [output file] [--strict]
//
// The default output is dist/THIRD-PARTY-NOTICES.txt; scripts/collect-resources.ts calls
// makeNotices() itself and puts the file in the packaged resources. --strict exits with 1 when a
// licence text is missing (the default only lists what is missing, so a build never fails on it).
//
// Offline: every text is read from node_modules as installed. Nothing is fetched and nothing is
// made up. Where a package ships no licence text, the notices say so and the package is listed as
// "missing, needs adding by hand": put the text, copied from the project's own source, in
//   scripts/notices/<name>.txt        (for a package: its name with "/" written as "+")
// and it is used from then on. The names this script asks for are printed in its output.
//
// What counts as shipped: the production dependencies in package.json, everything they depend
// on, and the optional packages npm installed for this platform (sharp's binaries) or that
// happen to be installed (optional peers), which is a little more than the build really packs. Plus two things that are not npm dependencies of the
// app: the Electron runtime, and the libraries compiled into the three binary engines (libvips
// inside sharp, libheif with libde265, and PDFium).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from '../src/server/resources';

export interface Notices {
  text: string;
  /** npm packages listed. */
  packages: number;
  /** Licence texts that are not in node_modules: each needs adding by hand. */
  missing: string[];
  /** Installed, but left out because the app does not ship them. */
  leftOut: string[];
}

interface Pkg {
  name: string;
  version: string;
  license?: unknown;
  licenses?: unknown;
  author?: unknown;
  repository?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

// In the production tree but not in the app: pdfjs-dist's optional canvas for Node. The app uses
// pdfjs only in the browser build of the editor (src/web/backend/browser/raster.ts).
const NOT_SHIPPED = /^@napi-rs\/canvas(-|$)/;

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);
const readJson = <T>(f: string) => JSON.parse(readFileSync(f, 'utf8')) as T;
const readText = (f: string) => readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
const licenceOf = (p: Pkg) => (typeof p.license === 'string' ? p.license : p.license || p.licenses ? JSON.stringify(p.license ?? p.licenses) : 'not stated in package.json');
const person = (a: unknown) => (typeof a === 'string' ? a : a && typeof a === 'object' && 'name' in a ? String((a as { name: unknown }).name) : '');
const repository = (p: Pkg) => {
  const r = typeof p.repository === 'string' ? p.repository : p.repository && typeof p.repository === 'object' && 'url' in p.repository ? String((p.repository as { url: unknown }).url) : '';
  return r.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^git\+ssh:\/\/git@|^ssh:\/\/git@/, 'https://').replace(/\.git$/, '');
};

/**
 * A package's licence, notice and copyright files (top level only): LICENSE or LICENCE in either
 * spelling, also with a prefix naming the licence (MIT-LICENCE.txt, as leaflet.markercluster has it).
 */
export function licenceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^([a-z0-9]+[-_])?(licen[cs]es?(?=$|[-_.])|copying|notice|copyrightnotice|third[-_ ]?party)/i.test(f) && !/\.(js|cjs|mjs|ts|json|html)$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
}

export function makeNotices(root = projectRoot() ?? process.cwd()): Notices {
  const pkg = readJson<Pkg>(join(root, 'package.json'));
  const product = readJson<{ productName: string }>(join(root, 'electron', 'product.json'));
  const modules = join(root, 'node_modules');
  const extras = join(root, 'scripts', 'notices');
  const missing: string[] = [];
  const leftOut: string[] = [];
  /** A licence text added by hand (see the top of this file), or null. */
  const extra = (name: string) => (existsSync(join(extras, `${name}.txt`)) ? readText(join(extras, `${name}.txt`)) : null);
  const need = (name: string, what: string) => {
    missing.push(`${what}  ->  scripts/notices/${name}.txt`);
    return `[MISSING, NEEDS ADDING BY HAND: ${what}. It is not in the installed package.]`;
  };

  // ---- the production dependency tree, found the way Node finds packages

  const findPackage = (name: string, from: string) => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      if (dirname(dir) === dir || dir === root) return null;
    }
  };
  const found = new Map<string, Pkg>();
  const visit = (name: string, from: string, optional: boolean) => {
    const dir = findPackage(name, from);
    if (!dir) {
      // Optional packages for other platforms are not installed, and so not shipped.
      if (optional) return;
      throw new Error(`${name} (needed from ${relative(root, from) || '.'}) is not installed. Run npm install.`);
    }
    if (found.has(dir)) return;
    const p = readJson<Pkg>(join(dir, 'package.json'));
    if (NOT_SHIPPED.test(p.name)) return void leftOut.push(`${p.name}@${p.version}`);
    found.set(dir, p);
    for (const dep of Object.keys(p.dependencies ?? {})) visit(dep, dir, false);
    for (const dep of Object.keys(p.optionalDependencies ?? {})) visit(dep, dir, true);
    // An optional peer that happens to be installed is bundled too, when the package tries to
    // load it (debug and supports-color).
    for (const [dep, meta] of Object.entries(p.peerDependenciesMeta ?? {})) if (meta?.optional) visit(dep, dir, true);
  };
  for (const name of Object.keys(pkg.dependencies ?? {})) visit(name, root, false);
  // Any sharp binary that is installed may be packed (the Linux build can swap in the WebAssembly one).
  if (existsSync(join(modules, '@img'))) for (const name of readdirSync(join(modules, '@img'))) visit(`@img/${name}`, root, true);

  const all = [...found].map(([dir, p]) => ({ dir, p })).sort((a, b) => a.p.name.localeCompare(b.p.name) || a.p.version.localeCompare(b.p.version));
  const unique = all.filter((x, i) => i === 0 || x.p.name !== all[i - 1]!.p.name || x.p.version !== all[i - 1]!.p.version);
  const one = (name: string) => unique.find((x) => x.p.name === name);

  /** One package: what it is, and its licence texts as installed. */
  const entry = ({ dir, p }: { dir: string; p: Pkg }) => {
    const files = licenceFiles(dir);
    const key = p.name.replace(/\//g, '+');
    const texts = files.length ? files.map(readText) : [extra(key) ?? need(key, `the licence text of ${p.name}@${p.version} (package.json says: ${licenceOf(p)})`)];
    const head = [`${p.name} ${p.version}`, `Licence: ${licenceOf(p)}`, person(p.author) && `Author: ${person(p.author)}`, repository(p) && `Source: ${repository(p)}`].filter(Boolean);
    return [THIN, ...head, THIN, '', texts.join('\n\n')].join('\n');
  };

  // ---- the binary engines: what is compiled into them, and where their source is

  const out: string[] = [];
  const section = (title: string, ...body: string[]) => out.push([RULE, title, RULE, '', ...body].join('\n'));

  const ownLicence = join(root, 'LICENSE');
  section(
    `${product.productName} ${pkg.version}: licence and third-party notices`,
    `${product.productName} is free software under the MIT licence, which follows. It is built from and`,
    'ships with the software, fonts and data listed after it, each under its own licence.',
    '',
    'Generated by scripts/make-notices.ts from the licence files of the installed packages.',
    '',
    existsSync(ownLicence) ? readText(ownLicence) : need('app', `${product.productName}'s own LICENSE file`),
  );

  const lgpl: string[] = [];

  const sharpBinaries = unique.filter((x) => x.p.name.startsWith('@img/sharp-') && existsSync(join(x.dir, 'versions.json')));
  for (const { dir, p } of sharpBinaries) {
    const readme = existsSync(join(dir, 'README.md')) ? readText(join(dir, 'README.md')) : '';
    const licensing = readme.includes('## Licensing') ? readme.slice(readme.indexOf('## Licensing')) : null;
    const versions = Object.entries(readJson<Record<string, string>>(join(dir, 'versions.json'))).map(([k, v]) => `  ${k} ${v}`);
    const libs = existsSync(join(dir, 'lib')) ? readdirSync(join(dir, 'lib')).filter((f) => /\.(dll|so(\.\d+)*|dylib)$/.test(f)) : [];
    lgpl.push(
      [
        `sharp's prebuilt image library: ${p.name} ${p.version}`,
        `Licence of the package: ${licenceOf(p)}`,
        '',
        'This package holds libvips and the libraries it is built from, compiled. Several of them',
        'are under the GNU Lesser General Public License (LGPL), and cairo is under the Mozilla',
        'Public License 1.1; the package\'s own list is below. They are used unmodified.',
        // Linux packages (scripts/desktop/linux/patch-sharp.mjs, the default there): libvips is left as it is, sharp's own binding is not.
        ...(process.platform === 'linux' && (process.env.PHOTOBOOK_LINUX_SHARP ?? 'shim') === 'shim'
          ? ['Changed in this app: sharp\'s own binding (the .node file, Apache 2.0) has its glib calls renamed', 'so that they reach the glib inside libvips, through a small added library, libsharp-glib-shim.so.']
          : []),
        ...(libs.length ? [`They are shipped as separate library files (${libs.join(', ')}), in the app's`, `resources under app.asar.unpacked/node_modules/${p.name}/lib, and can be replaced with your own build.`] : []),
        '',
        'Source code: https://github.com/lovell/sharp-libvips holds the build scripts, which name and',
        'fetch the source of every library at the versions listed here. libvips itself:',
        'https://github.com/libvips/libvips',
        '',
        'Versions:',
        ...versions,
        '',
        'What the package says about itself and the libraries inside it:',
        '',
        licensing ?? need(`${p.name.replace(/\//g, '+')}-licensing`, `the list of libraries and licences inside ${p.name} (no "Licensing" section in its README.md)`),
        '',
        'The text of the LGPL version 3 and of the GPL version 3 it builds on is printed once, under',
        'libheif below. The texts of the other licences named in the list:',
        '',
        extra('sharp-libvips') ?? need('sharp-libvips', `the full licence texts of the libraries inside ${p.name} other than the LGPL and GPL (MPL 1.1 for cairo, FreeType, libpng, libtiff, IJG and the rest): the package and its upstream give only the list of names`),
      ].join('\n'),
    );
  }

  const heif = one('libheif-js');
  if (heif) {
    const text = ['libheif-wasm', 'libheif'].map((d) => join(heif.dir, d, 'LICENSE')).find(existsSync);
    lgpl.push(
      [
        `libheif and libde265, the HEIC photo decoder: libheif-js ${heif.p.version}`,
        `Licence: ${licenceOf(heif.p)}`,
        '',
        'libheif-js is libheif compiled to WebAssembly together with the libde265 HEVC decoder. Both',
        'libraries are under the GNU Lesser General Public License version 3 and are used unmodified.',
        'The decoder is shipped as one separate file, libheif/libheif-bundle.js in the app\'s resource',
        'folder, and can be replaced with your own build.',
        '',
        'Source code:',
        '  libheif    https://github.com/strukturag/libheif (the release matching the version above)',
        '  libde265   https://github.com/strukturag/libde265',
        '  the build  https://github.com/catdad-experiments/libheif-emscripten and',
        `             ${repository(heif.p) || 'https://github.com/catdad-experiments/libheif-js'}`,
        '',
        'The licence of libheif, as shipped in the package (the LGPL version 3, then the GPL version 3',
        'it builds on, then the MIT licence of libheif\'s sample programs):',
        '',
        text ? readText(text) : need('libheif', 'the licence text of libheif (LGPL 3 and GPL 3)'),
      ].join('\n'),
    );
  }

  const pdfium = one('@hyzyla/pdfium');
  const engines: string[] = [];
  if (pdfium) {
    engines.push(
      [
        `PDFium, the PDF renderer: inside @hyzyla/pdfium ${pdfium.p.version}`,
        '',
        '@hyzyla/pdfium (MIT, listed among the packages below) carries PDFium compiled to WebAssembly',
        '(pdfium.wasm). PDFium is under a BSD 3-clause licence and the Apache License 2.0, and has',
        'other libraries compiled into it, among them FreeType, ICU, OpenJPEG, libjpeg-turbo, Little',
        'CMS, zlib, Anti-Grain Geometry and Abseil, each under its own licence.',
        '',
        'Source code: https://pdfium.googlesource.com/pdfium/ , built for WebAssembly by',
        'https://github.com/paulocoutinhox/pdfium-lib',
        '',
        extra('pdfium') ?? need('pdfium', `the licence texts of PDFium and of the libraries compiled into pdfium.wasm (@hyzyla/pdfium ${pdfium.p.version} ships only its own MIT licence; its repository has a THIRD_PARTY_NOTICES.md)`),
      ].join('\n'),
    );
  }

  const electronDir = join(modules, 'electron');
  if (existsSync(join(electronDir, 'package.json'))) {
    const electron = readJson<Pkg>(join(electronDir, 'package.json'));
    const text = [join(electronDir, 'dist', 'LICENSE'), join(electronDir, 'LICENSE')].find(existsSync);
    engines.push(
      [
        `Electron ${electron.version}, with Chromium and Node.js: the program the desktop app runs in`,
        '',
        'Electron\'s licence follows. The notices for Chromium and for every library inside it are in',
        'the file LICENSES.chromium.html, in the folder the app is installed in (next to',
        'LICENSE.electron.txt). Among them is FFmpeg, under the LGPL version 2.1, shipped as a',
        'separate library file (ffmpeg.dll on Windows, libffmpeg.so on Linux).',
        '',
        'Source code: https://github.com/electron/electron',
        '',
        text ? readText(text) : need('electron', 'the licence text of Electron'),
      ].join('\n'),
    );
  }

  if (lgpl.length) {
    section(
      'Libraries under the LGPL and other licences that ask for their source to be available',
      'The libraries in this part are used as separate files that this app loads when it runs. You',
      'may replace them with versions you have changed and built yourself, and you may take the app',
      'apart to find out why a changed version does not work. Where to get their source code is',
      'given with each.',
      '',
      lgpl.join(`\n\n${THIN}\n\n`),
    );
  }
  if (engines.length) section('Electron and PDFium', engines.join(`\n\n${THIN}\n\n`));

  const isFont = (x: { p: Pkg }) => x.p.name.startsWith('@fontsource/');
  const fonts = unique.filter(isFont);
  if (fonts.length) {
    section(
      'Fonts',
      'The fonts offered in the editor and embedded in exported PDFs, as packaged by Fontsource',
      '(https://github.com/fontsource/font-files). Each is under the licence printed with it.',
      '',
      fonts.map(entry).join('\n\n'),
    );
  }
  const rest = unique.filter((x) => !isFont(x));
  section('Software packages', 'Listed by name. Each is under the licence printed with it.', '', rest.map(entry).join('\n\n'));

  const text = out.join('\n\n\n') + '\n';
  return { text: process.platform === 'win32' ? text.replace(/\n/g, '\r\n') : text, packages: unique.length, missing, leftOut };
}

/** What the script (and collect-resources) prints after writing the file. */
export function reportNotices(n: Notices, file: string): string {
  return [
    `Wrote ${file}: ${n.packages} packages, ${(Buffer.byteLength(n.text) / 1024).toFixed(0)} KB`,
    ...(n.leftOut.length ? [`Left out (installed, not shipped): ${n.leftOut.join(', ')}`] : []),
    ...(n.missing.length ? [`${n.missing.length} licence text(s) missing, needs adding by hand:`, ...n.missing.map((m) => `  - ${m}`)] : ['No licence text is missing.']),
  ].join('\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const file = resolve(args.find((a) => !a.startsWith('--')) ?? 'dist/THIRD-PARTY-NOTICES.txt');
  const notices = makeNotices();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, notices.text);
  console.log(reportNotices(notices, file));
  if (notices.missing.length && args.includes('--strict')) process.exit(1);
}
