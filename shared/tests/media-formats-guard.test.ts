// Every image format rule lives in the registry (shared/core/mediaFormats.ts and
// shared/server/mediaHandlers/). This fails when an image-extension list, regex or comparison appears
// anywhere else in the programs' code, so adding a format never means hunting for scattered lists.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

/** Where the programs' code lives. Tests, fixtures and build scripts are not scanned. */
const SCANNED = ['shared', 'photo-tool', 'photobook-editor'];
const SKIPPED_DIRS = new Set(['tests', 'node_modules', 'public']);
/** The registry itself. */
const REGISTRY = ['shared/core/mediaFormats.ts', 'shared/server/mediaHandlers/'];
/** Lines that name an image extension for some other reason than "which files are photos", with why. */
const ALLOWED: { file: string; line: RegExp; why: string }[] = [
  { file: 'photo-tool/electron/mapTiles.ts', line: /TILE_PATH = /, why: 'OpenStreetMap tile URLs end in .png; they are not photos' },
  { file: 'shared/server/media.ts', line: /for \(const ext of \['webp', 'jpg'\]/, why: "the thumbnail files' own types (WebP for cutouts, else JPEG), not photo formats" },
  { file: 'photobook-editor/web/components/ExportDialog.tsx', line: /\(\['jpeg', 'png'\] as const\)/, why: "the editor's export choices (what it writes), not photo formats it reads" },
  { file: 'photobook-editor/electron/selfTest.ts', line: /for \(const format of \['png', 'jpeg'\] as const\)/, why: 'the self-test exports a poster in each export format' },
];

// Extensions of image formats, read today or likely soon (so a list of new ones is caught too).
const EXT = String.raw`(?:jpe?g|jpe|jfif|png|webp|hei[cf]|avif|tiff?|gif|bmp|svg|ico|dng|cr[23w]|nef|arw|raf|orf|rw2)`;
// The same, as they are spelled inside a regex literal's source (`jpe?g`, `hei[cf]`).
const REGEX_EXT = String.raw`(?:${EXT}|jpe\?g|hei\[cf\]|tiff\?)`;
const PATTERNS: { name: string; re: RegExp }[] = [
  // /\.(jpe?g|png)$/i, /\.hei[cf]$/i: an extension test written as a regex literal.
  { name: 'image-extension regex', re: new RegExp(String.raw`\\\.\(?(?:\?:)?${REGEX_EXT}(?:\||\)|\$|\b)`, 'i') },
  // '.heic', ".png", `.webp`: an extension on its own as a string (a list entry or a comparison).
  { name: 'image-extension string', re: new RegExp(String.raw`(['"\`])\.${EXT}\1`, 'i') },
  // ['jpg', 'jpeg'], 'heic': a bare extension in quotes inside a list.
  { name: 'image-extension list', re: new RegExp(String.raw`\[\s*(['"\`])${EXT}\1\s*,`, 'i') },
];

const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return SKIPPED_DIRS.has(d.name) ? [] : files(p);
    return CODE.test(d.name) ? [p] : [];
  });
}

/** `file:line: text` for every line outside the registry that names image extensions. */
export function findViolations(): string[] {
  const out: string[] = [];
  for (const top of SCANNED) {
    for (const f of files(resolve(root, top))) {
      const rel = relative(root, f).split('\\').join('/');
      if (REGISTRY.some((r) => (r.endsWith('/') ? rel.startsWith(r) : rel === r))) continue;
      readFileSync(f, 'utf8').split(/\r?\n/).forEach((text, i) => {
        if (ALLOWED.some((a) => a.file === rel && a.line.test(text))) return;
        const hit = PATTERNS.find((p) => p.re.test(text));
        if (hit) out.push(`${rel}:${i + 1}: ${hit.name}: ${text.trim()}`);
      });
    }
  }
  return out;
}

describe('image formats are only listed in the registry', () => {
  it('finds no image-extension list, regex or comparison outside it', () => {
    expect(findViolations()).toEqual([]);
  });

  it('catches each way an extension list has been written', () => {
    const caught = (line: string) => PATTERNS.some((p) => p.re.test(line));
    for (const line of [
      String.raw`const PREVIEWABLE = /\.(jpe?g|png|webp|heic|heif)$/i;`,
      String.raw`const HEIC = /\.hei[cf]$/i;`,
      String.raw`const isHeic = (path: string) => /\.(heic|heif)$/i.test(path);`,
      `const isHeic = ['.heic', '.heif'].includes(extname(path).toLowerCase());`,
      `export const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);`,
      `if (ext === '.png') return 'png';`,
      `{ name: 'JPEG photo', extensions: ['jpg', 'jpeg'] }`,
      String.raw`const RAW = /\.(cr3|nef|arw)$/i;`,
    ]) expect(caught(line), line).toBe(true);
  });

  it('leaves file names that merely end in an image extension alone', () => {
    const caught = (line: string) => PATTERNS.some((p) => p.re.test(line));
    for (const line of [
      'return join(this.dataDir, \'thumbs\', `${key}_${size}.jpg`);',
      "for (const f of ['s.jpg', 'm.jpg', 's.webp', 'm.webp']) rmSync(f);",
      "const icon = join(resourceRoot() ?? '', 'icon.png');",
      "await screenshot('gallery.png');",
      'derived = join(dataDir, \'derived\', `${contentHash}-edit-${key}.jpg`);',
      "res.type('image/jpeg').sendFile(file);",
    ]) expect(caught(line), line).toBe(false);
  });
});
