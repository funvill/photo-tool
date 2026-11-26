// scripts/release/collect-assets.mjs: what CI uploads to the draft release. Each update file
// (<channel>.yml, <channel>-linux.yml) names its installers by the name they get on GitHub; the files
// on disk are found by their sha512 and copied under that name, beside the update file.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Loaded by a computed path: a plain .mjs module with no type declarations.
const load = () => import(/* @vite-ignore */ pathToFileURL(resolve('scripts/release/collect-assets.mjs')).href) as Promise<{ collectAssets(inDir: string, outDir: string): { name: string; from: string }[] }>;

const sha512 = (data: string) => createHash('sha512').update(data).digest('base64');

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'release-'));
  const inDir = join(root, 'in');
  mkdirSync(inDir);
  return { inDir, outDir: join(root, 'out') };
}

/** An update file the way electron-builder writes one. */
const updateFile = (version: string, files: { url: string; data: string }[]) =>
  [`version: ${version}`, 'files:', ...files.flatMap((f) => [`  - url: ${f.url}`, `    sha512: ${sha512(f.data)}`, `    size: ${f.data.length}`]), `path: ${files[0]!.url}`, `sha512: ${sha512(files[0]!.data)}`, "releaseDate: '2026-11-25T00:00:00.000Z'", ''].join('\n');

describe('collectAssets', () => {
  it('copies the Windows installer under the name its update file gives it (spaces become dashes on GitHub)', async () => {
    const { collectAssets } = await load();
    const { inDir, outDir } = folders();
    mkdirSync(join(inDir, 'photo-tool-windows-x64'));
    writeFileSync(join(inDir, 'photo-tool-windows-x64', 'Photo Tool Setup 0.1.40.exe'), 'the installer');
    writeFileSync(join(inDir, 'photo-tool-windows-x64', 'photo-tool.yml'), updateFile('0.1.40', [{ url: 'Photo-Tool-Setup-0.1.40.exe', data: 'the installer' }]));
    const copied = collectAssets(inDir, outDir);
    expect(readdirSync(outDir).sort()).toEqual(['Photo-Tool-Setup-0.1.40.exe', 'photo-tool.yml']);
    expect(readFileSync(join(outDir, 'Photo-Tool-Setup-0.1.40.exe'), 'utf8')).toBe('the installer');
    expect(readFileSync(join(outDir, 'photo-tool.yml'), 'utf8')).toBe(readFileSync(join(inDir, 'photo-tool-windows-x64', 'photo-tool.yml'), 'utf8'));
    expect(copied.map((c) => c.name).sort()).toEqual(['Photo-Tool-Setup-0.1.40.exe', 'photo-tool.yml']);
  });

  it('copies both Linux packages a -linux.yml names, and every program\'s files side by side', async () => {
    const { collectAssets } = await load();
    const { inDir, outDir } = folders();
    mkdirSync(join(inDir, 'photobook-editor-linux-x64'));
    mkdirSync(join(inDir, 'photo-tool-windows-x64'));
    writeFileSync(join(inDir, 'photobook-editor-linux-x64', 'photobook-editor-0.1.40-amd64.deb'), 'deb');
    writeFileSync(join(inDir, 'photobook-editor-linux-x64', 'photobook-editor-0.1.40-x86_64.AppImage'), 'appimage');
    writeFileSync(
      join(inDir, 'photobook-editor-linux-x64', 'photobook-editor-linux.yml'),
      updateFile('0.1.40', [
        { url: 'photobook-editor-0.1.40-x86_64.AppImage', data: 'appimage' },
        { url: 'photobook-editor-0.1.40-amd64.deb', data: 'deb' },
      ]),
    );
    writeFileSync(join(inDir, 'photo-tool-windows-x64', 'Photo Tool Setup 0.1.40.exe'), 'exe');
    writeFileSync(join(inDir, 'photo-tool-windows-x64', 'photo-tool.yml'), updateFile('0.1.40', [{ url: 'Photo-Tool-Setup-0.1.40.exe', data: 'exe' }]));
    collectAssets(inDir, outDir);
    expect(readdirSync(outDir).sort()).toEqual(['Photo-Tool-Setup-0.1.40.exe', 'photo-tool.yml', 'photobook-editor-0.1.40-amd64.deb', 'photobook-editor-0.1.40-x86_64.AppImage', 'photobook-editor-linux.yml'].sort());
    expect(readFileSync(join(outDir, 'photobook-editor-0.1.40-amd64.deb'), 'utf8')).toBe('deb');
  });

  it('throws, naming the url, when no file has its hash', async () => {
    const { collectAssets } = await load();
    const { inDir, outDir } = folders();
    writeFileSync(join(inDir, 'Photo Tool Setup 0.1.40.exe'), 'something else');
    writeFileSync(join(inDir, 'photo-tool.yml'), updateFile('0.1.40', [{ url: 'Photo-Tool-Setup-0.1.40.exe', data: 'the installer' }]));
    expect(() => collectAssets(inDir, outDir)).toThrow(/Photo-Tool-Setup-0\.1\.40\.exe/);
  });

  it("skips yml files that are not update files (electron-builder's builder-debug.yml)", async () => {
    const { collectAssets } = await load();
    const { inDir, outDir } = folders();
    writeFileSync(join(inDir, 'builder-debug.yml'), 'x64:\n  firstOrDefaultFilePatterns:\n    - "**/*"\n');
    writeFileSync(join(inDir, 'a.exe'), 'exe');
    writeFileSync(join(inDir, 'photo-tool.yml'), updateFile('0.1.40', [{ url: 'Photo-Tool-Setup-0.1.40.exe', data: 'exe' }]));
    collectAssets(inDir, outDir);
    expect(readdirSync(outDir).sort()).toEqual(['Photo-Tool-Setup-0.1.40.exe', 'photo-tool.yml']);
    expect(existsSync(join(outDir, 'builder-debug.yml'))).toBe(false);
  });

  it('reads quoted urls and hashes, and refuses a url that is a path', async () => {
    const { collectAssets } = await load();
    const { inDir, outDir } = folders();
    writeFileSync(join(inDir, 'x.exe'), 'exe');
    writeFileSync(join(inDir, 'photo-tool.yml'), `version: 0.1.40\nfiles:\n  - url: 'Photo-Tool-Setup-0.1.40.exe'\n    sha512: "${sha512('exe')}"\n    size: 3\n`);
    collectAssets(inDir, outDir);
    expect(readdirSync(outDir).sort()).toEqual(['Photo-Tool-Setup-0.1.40.exe', 'photo-tool.yml']);
    const bad = folders();
    writeFileSync(join(bad.inDir, 'x.exe'), 'exe');
    writeFileSync(join(bad.inDir, 'photo-tool.yml'), `version: 0.1.40\nfiles:\n  - url: ../evil.exe\n    sha512: ${sha512('exe')}\n`);
    expect(() => collectAssets(bad.inDir, bad.outDir)).toThrow(/\.\.\/evil\.exe/);
  });

  it('fails when there is no update file at all', async () => {
    const { collectAssets } = await load();
    const { inDir, outDir } = folders();
    writeFileSync(join(inDir, 'a.exe'), 'exe');
    expect(() => collectAssets(inDir, outDir)).toThrow(/no update file/i);
  });
});
