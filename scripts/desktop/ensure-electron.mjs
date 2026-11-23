// Electron 45's npm package no longer downloads its program during `npm install`: it fetches it
// the first time it is used. Do that here, once, at build time, so that running and packaging
// never depend on it. (This is the only download, and it happens on the developer's or CI's
// machine, never on a user's.)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const dir = join(root, 'node_modules/electron');

/** The Electron program for this platform, downloading it first if it is not there yet. */
export function ensureElectron() {
  const pathFile = join(dir, 'path.txt');
  const program = () => (existsSync(pathFile) ? join(dir, 'dist', readFileSync(pathFile, 'utf8').trim()) : null);
  if (!program() || !existsSync(program())) {
    console.log('Fetching the Electron program (first time only)…');
    execFileSync(process.execPath, [join(dir, 'install.js')], { cwd: root, stdio: 'inherit' });
  }
  const exe = program();
  if (!exe || !existsSync(exe)) throw new Error('The Electron program is missing after install. Delete node_modules/electron and run npm install again.');
  return exe;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) console.log(ensureElectron());
