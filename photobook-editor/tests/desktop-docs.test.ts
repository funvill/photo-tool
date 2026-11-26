// Posters made in the desktop editor are drawn as designed: hand cut-outs, inverted photos, and a
// background photo moved into place with its own adjustments.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backgroundFrame, gradeColor, gradeFromPreset, isNeutralGrade, maskPath } from '../core';

describe('desktop poster features', () => {
  it('inverts colours after black & white', () => {
    const neg = { ...gradeFromPreset('none'), preset: 'custom', mono: 'bw' as const, invert: true };
    expect(gradeColor(neg, [255, 255, 255])).toEqual([0, 0, 0]);
    expect(isNeutralGrade(neg)).toBe(false);
  });

  it('cuts a photo to a kept outline minus erased areas', () => {
    const m = maskPath({ kind: 'cut', keep: [{ x: 0, y: 0.5 }, { x: 1, y: 0.4 }, { x: 1, y: 1 }, { x: 0, y: 1 }], erase: [[{ x: 0.4, y: 0.7 }, { x: 0.6, y: 0.7 }, { x: 0.5, y: 0.9 }]] }, 100, 80);
    expect(m.evenOdd).toBe(true);
    expect(m.d.match(/M/g)!.length).toBe(2);
  });

  it('places a fitted background photo in its own box, with its adjustment', () => {
    const adjust = { ...gradeFromPreset('none'), preset: 'custom', brightness: 20 };
    const f = backgroundFrame({ id: 's', backgroundImage: { assetId: 'a', fit: 'contain', opacity: 1, crop: { cx: 0.3, cy: 0.3, zoom: 1 }, box: { x: -5, y: -100, w: 300, h: 500 }, adjust } }, { width: 279, height: 356, bleed: 3 })!;
    expect([f.xMm, f.yMm, f.widthMm, f.heightMm]).toEqual([-5, -100, 300, 500]);
    expect(f.adjust).toBe(adjust);
  });
});

describe('README: Photo Tool', () => {
  const readme = readFileSync('photo-tool/README.md', 'utf8');

  it('is a README of its own, named after the program', () => {
    expect(readme).toMatch(/^# Photo Tool$/m);
    expect(readme.length).toBeGreaterThan(5000);
    expect(readme).not.toContain(['Photobook', 'Gallery'].join(' '));
  });

  it('lists the viewer keys', () => {
    for (const key of ['**Left**', '**Right**', '**S**', '**I**', '**Esc**']) expect(readme, key).toContain(key);
  });

  it('says where the info is kept, including for read-only folders', () => {
    expect(readme).toContain('photoinfo.json');
    expect(readme).toMatch(/read-only/i);
    expect(readme).toContain('Photo Tools Shared');
  });

  it('covers opening folders, filters, sorts, tagging and dragging into the editor', () => {
    for (const words of [/Open folder/, /Include subfolders/, /filter/i, /sort/i, /drag/i, /Explorer/, /Photo tagging/]) expect(readme).toMatch(words);
  });

  it('has no gallery switch and no Open Gallery: Photo Tool is its own program', () => {
    expect(readme).not.toMatch(/--gallery|Open Gallery/);
  });
});

describe('README: the two programs', () => {
  const root = readFileSync('README.md', 'utf8');
  const editor = readFileSync('photobook-editor/README.md', 'utf8');
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;

  it('the root README names both programs and links their READMEs', () => {
    for (const text of ['Photo Tool', 'Photobook Editor', '(photo-tool/README.md)', '(photobook-editor/README.md)']) expect(root, text).toContain(text);
  });

  it('says where each program keeps its data, how it is carried over, and to uninstall the old program by hand', () => {
    for (const text of ['%APPDATA%\\Photo Tool', '%APPDATA%\\Photobook Editor', 'Photo Tools Shared', './data/photo-tool', './data/photobook-editor', './data/photoinfo-shared', 'PHOTOINFO_FALLBACK_DIR'])
      expect(root, text).toContain(text);
    expect(root).toMatch(/Photobook Gallery/);
    expect(root).toMatch(/uninstall[^.]*Photobook Studio/i);
  });

  it('has no web version', () => {
    for (const text of [root, editor, readFileSync('photo-tool/README.md', 'utf8')]) {
      expect(text).not.toMatch(/Use it in your browser|build:pages|preview:pages|WEB_VERSION/);
    }
  });

  it('every npm command the READMEs name exists', () => {
    const named = [root, editor, readFileSync('photo-tool/README.md', 'utf8')].flatMap((t) => [...t.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
    expect(named.length).toBeGreaterThan(10);
    expect([...new Set(named)].filter((n) => !scripts[n])).toEqual([]);
  });

  it('every repository file the READMEs link exists', () => {
    for (const [file, text] of [['README.md', root], ['photobook-editor/README.md', editor], ['photo-tool/README.md', readFileSync('photo-tool/README.md', 'utf8')]] as const) {
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      const links = [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/.test(l));
      for (const l of links) expect(existsSync(dir + l), `${file}: ${l}`).toBe(true);
    }
  });
});
