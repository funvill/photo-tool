// Linux only: make the packaged copy of sharp's native binary safe to use inside Electron.
//
// The problem (https://sharp.pixelplumbing.com/install#electron-and-linux, electron/electron#46323):
// sharp's libvips carries its own copy of glib. Electron's program has already loaded the
// system's glib, so the glib calls made by sharp's binding (sharp-linux-x64.node) land in the
// system's copy, which knows nothing of objects made by the other one. Every image handled logs
// "GLib-GObject-CRITICAL ... g_object_unref: assertion 'G_IS_OBJECT (object)' failed" and its
// memory is never given back. Measured with this app on Ubuntu 24.04: importing and exporting
// 100 photos took the local server to 5.6 GB. Plain Node does not have the problem.
//
// The fix, applied to the copy in dist/desktop/app and never to node_modules:
//   1. build libsharp-glib-shim.so (sharp-glib-shim.c) next to libvips
//   2. rename the binding's glib imports g_<name> to q_<name> (same length, so a plain overwrite)
//   3. make the binding load the shim, which passes q_<name> on to the g_<name> inside libvips
// Needs gcc, nm and patchelf on the build machine. If sharp ever calls another glib function,
// step 4 stops the build until it is added to NAMES here and to the .c file.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAMES = ['free', 'malloc', 'object_ref', 'object_unref', 'log_set_handler', 'signal_connect_data', 'utf8_validate'];
const SHIM = 'libsharp-glib-shim.so';

export function patchSharp(appDir) {
  const img = join(appDir, 'node_modules/@img');
  const libDir = join(img, `sharp-libvips-linux-${process.arch}/lib`);
  const bindingDir = join(img, `sharp-linux-${process.arch}/lib`);
  const vips = readdirSync(libDir).find((f) => /^libvips-cpp\.so\./.test(f));
  const binding = join(bindingDir, readdirSync(bindingDir).find((f) => f.endsWith('.node')));
  const run = (tool, args) => {
    try {
      return execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (e) {
      throw new Error(`${tool} failed or is not installed (gcc, binutils and patchelf are needed to package for Linux; PHOTOBOOK_LINUX_SHARP=wasm avoids them): ${e.message}`);
    }
  };

  run('gcc', ['-shared', '-fPIC', '-O2', '-Wall', `-DVIPS_SONAME="${vips}"`, '-o', join(libDir, SHIM), join(import.meta.dirname, 'sharp-glib-shim.c'), '-ldl']);

  const bytes = readFileSync(binding);
  for (const name of NAMES) {
    const at = bytes.indexOf(`\0g_${name}\0`);
    if (at < 0 || bytes.indexOf(`\0g_${name}\0`, at + 1) >= 0) throw new Error(`${binding}: expected exactly one import named g_${name}. sharp has changed; see scripts/desktop/linux/patch-sharp.mjs.`);
    bytes.write('q', at + 1);
  }
  writeFileSync(binding, bytes);
  // The binding finds libvips through its run-path, and the shim is in the same folder.
  run('patchelf', ['--add-needed', SHIM, binding]);

  // 4. Nothing glib may be left for the system's copy to answer.
  const left = run('nm', ['-D', '--undefined-only', binding]).split('\n').filter((l) => /\sg_/.test(l));
  if (left.length) throw new Error(`${binding} still imports glib functions the shim does not cover:\n${left.join('\n')}\nAdd them to NAMES in patch-sharp.mjs and to sharp-glib-shim.c.`);
  const glibc = [...run('objdump', ['-T', join(libDir, SHIM)]).matchAll(/GLIBC_([0-9.]+)/g)].map((m) => m[1]).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  console.log(`Patched sharp for Electron on Linux: ${SHIM} forwards ${NAMES.length} glib calls to ${vips} (needs glibc ${glibc})`);
}
