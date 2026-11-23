// Build the Linux packages (.deb and AppImage) in Docker, from any host that has Docker:
//
//   node scripts/desktop/linux/docker-build.mjs [work folder]
//
// 1. copies the source (no node_modules, data, photos or build output) to <work>/src
// 2. builds it in a node:24-bookworm container with `npm ci` and `npm run dist`
// 3. copies the two packages to dist/installer/
//
// The work folder defaults to <temp>/photobook-linux and must be outside the project.
// Downloads (npm, Electron, electron-builder's tools) are kept in the Docker volume
// "photobook-linux-cache" so a second build is quick.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const work = resolve(process.argv[2] ?? join(tmpdir(), 'photobook-linux'));
if (!relative(root, work).startsWith('..')) throw new Error(`The work folder must be outside the project: ${work}`);
const src = join(work, 'src');
const out = join(work, 'out');
const IMAGE = 'photobook-linux-build';

// Top-level folders that are not source, and fixtures/generated (made by `npm run fixtures`).
const SKIP = new Set(['node_modules', 'data', 'photos', 'dist', 'spike', 'trial-output', '.git', '.claude', 'test-results', 'playwright-report', `fixtures${sep}generated`]);
rmSync(src, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(root, src, { recursive: true, filter: (from) => !SKIP.has(relative(root, from)) });
console.log(`Source copied to ${src}`);

const docker = (...args) => execFileSync('docker', args, { stdio: 'inherit' });
docker('build', '-t', IMAGE, '-f', join(import.meta.dirname, 'Dockerfile.build'), import.meta.dirname);
docker('run', '--rm', '-v', `${src}:/src:ro`, '-v', `${out}:/out`, '-v', 'photobook-linux-cache:/cache', '-e', 'PHOTOBOOK_APPIMAGE_TOOLSET', '-e', 'PHOTOBOOK_LINUX_SHARP', IMAGE, 'sh', '-c', "tr -d '\\r' < /src/scripts/desktop/linux/build-in-container.sh | sh"); // a Windows checkout may have CRLF

const installer = join(root, 'dist/installer');
mkdirSync(installer, { recursive: true });
for (const f of readdirSync(out).filter((f) => /\.(deb|AppImage)$/.test(f))) {
  cpSync(join(out, f), join(installer, f));
  console.log(`dist/installer/${f}`);
}
