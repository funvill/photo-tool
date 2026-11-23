// Built with PHOTOBOOK_LINUX_SHARP=wasm, the Linux packages carry sharp's WebAssembly build
// instead of its native Linux binary (see build.mjs for why and when). npm does not install
// that build on an x64 machine, so fetch it here, once, at build time: the exact files
// package-lock.json names, checked against its checksums.
// Like ensure-electron.mjs this is a download on the build machine, never on a user's.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
// @emnapi/runtime is the one thing the WebAssembly build needs that is not installed anyway.
const WANTED = ['node_modules/@img/sharp-wasm32', 'node_modules/@emnapi/runtime'];

export function ensureSharpWasm() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  for (const path of WANTED) {
    const entry = lock[path];
    if (!entry) throw new Error(`${path} is not in package-lock.json.`);
    const dir = join(root, path);
    const installed = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version : null;
    if (installed === entry.version) continue;
    console.log(`Fetching ${path.replace('node_modules/', '')}@${entry.version} (first time only)…`);
    const temp = mkdtempSync(join(tmpdir(), 'sharp-wasm-'));
    try {
      execFileSync('npm', ['pack', entry.resolved, '--pack-destination', temp, '--silent'], { cwd: temp, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
      const tarball = join(temp, readdirSync(temp).find((f) => f.endsWith('.tgz')));
      const [algorithm, expected] = entry.integrity.split('-');
      if (createHash(algorithm).update(readFileSync(tarball)).digest('base64') !== expected) throw new Error(`${path}: the download does not match the checksum in package-lock.json.`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      execFileSync('tar', ['-xzf', tarball, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) ensureSharpWasm();
