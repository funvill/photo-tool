// The desktop build scripts (scripts/desktop): the one table of each program's files, and the
// `--program` argument every desktop script takes. Each program's packaging is tested with the program
// (photo-tool/tests/photo-tool-shell.test.ts, photobook-editor/tests/editor-shell.test.ts).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Loaded by a computed path: a plain .mjs module with no type declarations.
const loadPrograms = () => import(/* @vite-ignore */ pathToFileURL(resolve('scripts/desktop/programs.mjs')).href) as Promise<{ PROGRAM_NAMES: string[]; programArg(argv: string[]): string; withoutProgramArg(argv: string[]): string[] }>;

describe('desktop build scripts', () => {
  it('--program is required and must name one of the two programs', async () => {
    const { PROGRAM_NAMES, programArg, withoutProgramArg } = await loadPrograms();
    expect(PROGRAM_NAMES).toEqual(['photo-tool', 'photobook-editor']);
    expect(programArg(['node', 'build.mjs', '--program', 'photo-tool'])).toBe('photo-tool');
    expect(programArg(['node', 'build.mjs', '--dev', '--program', 'photobook-editor'])).toBe('photobook-editor');
    expect(() => programArg(['node', 'build.mjs'])).toThrow(/--program is required/);
    expect(() => programArg(['node', 'build.mjs', '--program'])).toThrow(/--program is required/);
    expect(() => programArg(['node', 'build.mjs', '--program', '--dev'])).toThrow(/--program is required/);
    expect(() => programArg(['node', 'build.mjs', '--program', 'gallery'])).toThrow(/Unknown program "gallery"/);
    // dev.mjs hands the rest to the app: Photo Tool would otherwise open a folder named after the program.
    expect(withoutProgramArg(['--program', 'photo-tool', 'D:\\Pics'])).toEqual(['D:\\Pics']);
  });

  it("every Photo Tool desktop script names its program (the editor's: photobook-editor/tests/editor-shell.test.ts)", () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    expect(scripts['desktop:build:photo-tool']).toBe('npm run build:photo-tool && node scripts/desktop/ensure-electron.mjs && node scripts/desktop/build.mjs --program photo-tool');
    expect(scripts['start:photo-tool']).toBe('electron dist/photo-tool/desktop/app');
    expect(scripts['dev:desktop:photo-tool']).toBe('node scripts/desktop/dev.mjs --program photo-tool');
    expect(scripts['dist:photo-tool']).toBe('npm run desktop:build:photo-tool && electron-builder --config photo-tool/electron-builder.config.cjs --publish never');
    expect(scripts['dist:dir:photo-tool']).toBe('npm run desktop:build:photo-tool && electron-builder --config photo-tool/electron-builder.config.cjs --publish never --dir');
  });

  it('the program table is the one list of entry files: build.mjs and collect-resources both read it', async () => {
    const { PROGRAMS, programEntries } = (await loadPrograms()) as unknown as { PROGRAMS: Record<string, unknown>; programEntries(name: string): string[] };
    expect(Object.keys(PROGRAMS).sort()).toEqual(['photo-tool', 'photobook-editor']);
    expect(programEntries('photo-tool')).toEqual(['photo-tool/electron/main.ts', 'photo-tool/electron/server-host.ts', 'photo-tool/electron/preload.ts', 'photo-tool/server/tagging/worker.ts', 'photo-tool/web/index.html']);
    expect(programEntries('photobook-editor')).toEqual(['photobook-editor/electron/main.ts', 'photobook-editor/electron/server-host.ts', 'photobook-editor/electron/preload.ts', 'photobook-editor/web/index.html']);
    for (const name of Object.keys(PROGRAMS)) for (const f of programEntries(name)) expect(existsSync(f), f).toBe(true);
    for (const script of ['scripts/desktop/build.mjs', 'scripts/collect-resources.ts']) {
      const text = readFileSync(script, 'utf8');
      expect(text, script).toContain('programs.mjs');
      expect(text, script).not.toMatch(/'(photo-tool|photobook-editor)\/electron\/main\.ts'/);
    }
  });

  it("the program table's variable prefix is the one each program's main.ts gives", async () => {
    const { PROGRAMS } = (await loadPrograms()) as unknown as { PROGRAMS: Record<string, { main: string; envPrefix: string }> };
    for (const p of Object.values(PROGRAMS)) expect(readFileSync(p.main, 'utf8'), p.main).toContain(`envPrefix: '${p.envPrefix}'`);
  });

  it('the Linux container scripts test each program under its own name, from its own installer folder', () => {
    const old = ['photobook', 'studio'].join('-');
    for (const f of ['scripts/desktop/linux/test-in-container.sh', 'scripts/desktop/linux/docker-test.mjs', 'scripts/desktop/linux/docker-build.mjs']) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toContain(old);
      // The .mjs scripts take the programs from the one table; the shell script is told which one.
      if (f.endsWith('.mjs')) expect(text, f).toContain('programs.mjs');
    }
    const sh = readFileSync('scripts/desktop/linux/test-in-container.sh', 'utf8');
    for (const v of ['_DATA_DIR', '_PROFILE_DIR', 'PHOTOINFO_FALLBACK_DIR']) expect(sh, v).toContain(v);
    for (const f of ['scripts/desktop/linux/docker-test.mjs', 'scripts/desktop/linux/docker-build.mjs']) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/join\(root, 'dist\/installer', program\)/);
    }
  });

  it('the run-time module list refuses an entry file that does not exist, rather than leaving its packages out', async () => {
    const { packageImports } = await import('../scripts/import-graph');
    expect(() => packageImports(['electron/no-such-main.ts'], '.')).toThrow(/electron\/no-such-main\.ts/);
    expect(packageImports(['photo-tool/electron/server-host.ts'], '.').has('express')).toBe(true);
  });

  it('the program table maps each program to its entry files, externals and tagging worker', () => {
    const build = readFileSync('scripts/desktop/programs.mjs', 'utf8');
    expect(build).toContain("main: 'photo-tool/electron/main.ts'");
    expect(build).toContain("main: 'photobook-editor/electron/main.ts'");
    expect(build).toContain("external: ['sharp', '@huggingface/transformers']");
    expect(build).toContain("external: ['sharp', 'pdfkit', 'fontkit']");
    expect(build).toContain("taggingWorker: 'photo-tool/server/tagging/worker.ts'");
    expect(build).toContain('taggingWorker: null');
    expect(build).not.toContain('gallery.html');
    expect(readFileSync('scripts/desktop/build.mjs', 'utf8')).not.toContain('gallery.html');
    expect(readFileSync('scripts/collect-resources.ts', 'utf8')).not.toContain('gallery.html');
  });
});
