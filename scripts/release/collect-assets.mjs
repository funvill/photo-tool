// Gather what one GitHub release carries, from the installers CI built (.github/workflows/desktop.yml):
//
//   node scripts/release/collect-assets.mjs <in folder> <out folder>
//
// Every update file under <in> (<channel>.yml, <channel>-linux.yml, as electron-builder writes them)
// names its installers by the name they will have on GitHub, which has no spaces ("Photo Tool Setup
// 0.1.40.exe" is "Photo-Tool-Setup-0.1.40.exe" there). Each one is found under <in> by its sha512,
// as the update file gives it, and copied to <out> under that name; the update file goes beside them.
// The updater downloads exactly those names, so an installer uploaded under any other name would
// never be found. Throws, naming the url, when no file has the hash. Other yml files (electron-builder's
// builder-debug.yml) have no files list and are skipped.
//
// No dependencies (the release job runs it without npm ci): the update files are read with a small
// parser for the `files:` list's `url:` and `sha512:` lines.
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Every file under `dir`, recursively. */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The sha512 of a file in base64, as update files give it; read in pieces (installers are large). */
function sha512(file) {
  const hash = createHash('sha512');
  const buf = Buffer.alloc(1 << 20);
  const fd = openSync(file, 'r');
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('base64');
}

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/** The `files:` list of an update file: [{ url, sha512 }], or null when the yml has none. */
export function updateFileEntries(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^files:\s*$/.test(l));
  if (start < 0) return null;
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key
    const item = /^\s*-\s+url:\s*(.+)$/.exec(line);
    if (item) {
      entries.push({ url: unquote(item[1]), sha512: null });
      continue;
    }
    const hash = /^\s+sha512:\s*(.+)$/.exec(line);
    if (hash && entries.length) entries.at(-1).sha512 = unquote(hash[1]);
  }
  return entries.length ? entries : null;
}

/** Copy every update file under `inDir` and the installers it names to `outDir`; returns what was copied. */
export function collectAssets(inDir, outDir) {
  const files = walk(resolve(inDir));
  const ymls = files.filter((f) => /\.ya?ml$/i.test(f));
  const others = files.filter((f) => !/\.ya?ml$/i.test(f));
  const hashes = new Map();
  const hashOf = (f) => {
    if (!hashes.has(f)) hashes.set(f, sha512(f));
    return hashes.get(f);
  };
  const copied = [];
  const taken = new Map();
  const put = (name, from) => {
    const before = taken.get(name);
    if (before && before !== from) throw new Error(`Two files would be uploaded as ${name}: ${before} and ${from}`);
    if (before) return;
    taken.set(name, from);
    copied.push({ name, from });
  };
  for (const yml of ymls) {
    const entries = updateFileEntries(readFileSync(yml, 'utf8'));
    if (!entries) continue;
    for (const { url, sha512: want } of entries) {
      // A release asset is a plain file name.
      if (!url || basename(url) !== url || url.startsWith('.')) throw new Error(`${basename(yml)} names "${url}", which is not a plain file name.`);
      if (!want) throw new Error(`${basename(yml)} gives no sha512 for ${url}.`);
      const match = others.find((f) => hashOf(f) === want);
      if (!match) throw new Error(`No file under ${inDir} has the sha512 that ${basename(yml)} gives for ${url}.`);
      put(url, match);
    }
    put(basename(yml), yml);
  }
  if (!copied.length) throw new Error(`No update file (<channel>.yml with a files list) under ${inDir}.`);
  mkdirSync(outDir, { recursive: true });
  for (const { name, from } of copied) copyFileSync(from, join(outDir, name));
  return copied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inDir, outDir] = process.argv.slice(2);
  if (!inDir || !outDir) {
    console.error('Usage: node scripts/release/collect-assets.mjs <in folder> <out folder>');
    process.exit(2);
  }
  for (const { name, from } of collectAssets(inDir, outDir)) console.log(`${name}  <-  ${from}`);
}
