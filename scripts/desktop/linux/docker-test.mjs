// Test the Linux packages on clean desktops with the network off:
//
//   node scripts/desktop/linux/docker-test.mjs [--work <folder>] [--photos <folder>] [--only <distro>]
//        [--mode deb|appimage] [--userns | --suid] [--fuse] [--tag <name>] [-- <extra app flags, e.g. --no-sandbox>]
//
// For each distribution it builds (once, with the network on) the image described in
// Dockerfile.test, then runs test-in-container.sh in it with `--network none`: install the .deb
// or run the AppImage, run the app's own self-test on a virtual display, uninstall.
// Evidence lands in <work>/test/<distro>-<mode>[-userns]/ (test.log, result.json, screenshots).
//
// --userns starts the container with seccomp off, which is what lets an ordinary user create
// user namespaces inside Docker, so Chromium's sandbox can be tested switched on. Without it
// the sandbox cannot start in a container and the app needs --no-sandbox.
// --suid (.deb only) tests Chromium's other sandbox, the setuid helper used where there are no
// user namespaces: the container gets the right to make namespaces as root (SYS_ADMIN).
// --fuse gives the container the FUSE device and the right to mount, so an AppImage can be
// tested mounting itself as it does on a desktop; without it, it has to unpack itself.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;
const root = resolve(here, '../../..');
const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split < 0 ? argv : argv.slice(0, split);
const appFlags = split < 0 ? [] : argv.slice(split + 1);
const opt = (name) => (own.includes(name) ? own[own.indexOf(name) + 1] : undefined);
const work = resolve(opt('--work') ?? join(tmpdir(), 'photobook-linux'));
const userns = own.includes('--userns');
const fuse = own.includes('--fuse');
const suid = own.includes('--suid');

const DISTROS = {
  'ubuntu-24.04': { base: 'ubuntu:24.04', desktop: 'ubuntu-desktop-minimal', modes: ['deb', 'appimage'] },
  'ubuntu-22.04': { base: 'ubuntu:22.04', desktop: 'ubuntu-desktop-minimal', modes: ['deb', 'appimage'] },
  'debian-12': { base: 'debian:12', desktop: 'task-gnome-desktop', modes: ['deb', 'appimage'] },
  fedora: { dockerfile: 'Dockerfile.test-fedora', modes: ['appimage'] },
};

// The packages under test, and a dozen photos, copied where Docker can mount them read-only.
const pkg = join(work, 'pkg');
rmSync(pkg, { recursive: true, force: true });
mkdirSync(pkg, { recursive: true });
for (const f of readdirSync(join(root, 'dist/installer')).filter((f) => /\.(deb|AppImage)$/.test(f))) cpSync(join(root, 'dist/installer', f), join(pkg, f));
// --photos <folder> is mounted as it is; otherwise <work>/photos, filled once from the fixtures
// (`npm run fixtures`) if it does not exist yet.
const photos = opt('--photos') ? resolve(opt('--photos')) : join(work, 'photos');
if (!existsSync(photos)) {
  const from = join(root, 'fixtures/generated/trip');
  mkdirSync(photos, { recursive: true });
  for (const f of readdirSync(from).filter((f) => /\.jpe?g$/i.test(f)).slice(0, 12)) cpSync(join(from, f), join(photos, f));
}
const tag = opt('--tag') ? `-${opt('--tag')}` : ''; // keeps this run's evidence apart from another's

let failed = 0;
for (const [name, d] of Object.entries(DISTROS)) {
  if (opt('--only') && opt('--only') !== name) continue;
  const image = `photobook-test-${name}`;
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
    const args = d.dockerfile ? ['-f', join(here, d.dockerfile)] : ['-f', join(here, 'Dockerfile.test'), '--build-arg', `BASE=${d.base}`, '--build-arg', `DESKTOP=${d.desktop}`];
    execFileSync('docker', ['build', '-t', image, ...args, here], { stdio: 'inherit' });
  }
  for (const mode of d.modes) {
    if (opt('--mode') && opt('--mode') !== mode) continue;
    const out = join(work, 'test', `${name}-${mode}${userns ? '-userns' : ''}${suid ? '-suid' : ''}${fuse ? '-fuse' : ''}${appFlags.length ? '-flags' : ''}${tag}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const r = spawnSync(
      'docker',
      // prettier-ignore
      ['run', '--rm', '--network', 'none', '--shm-size', '1g', ...(userns ? ['--security-opt', 'seccomp=unconfined'] : []),
        ...(fuse ? ['--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined'] : []),
        ...(suid ? ['--cap-add', 'SYS_ADMIN', '-e', 'FORCE_SUID_SANDBOX=1'] : []),
        '-v', `${pkg}:/pkg:ro`, '-v', `${photos}:/photos:ro`, '-v', `${here}:/scripts:ro`, '-v', `${out}:/out`,
        image, 'bash', '-c', `tr -d '\\r' < /scripts/test-in-container.sh > /tmp/t.sh; bash /tmp/t.sh ${mode} ${appFlags.join(' ')}`],
      { stdio: 'inherit' },
    );
    console.log(`\n#### ${name} ${mode}: ${r.status === 0 ? 'PASS' : `FAIL (exit ${r.status})`}  evidence: ${out}\n`);
    if (r.status !== 0) failed++;
  }
}
process.exit(failed ? 1 : 0);
