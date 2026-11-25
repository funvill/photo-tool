// Posters made in the desktop editor open here as designed: hand cut-outs, inverted photos, and a
// background photo moved into place with its own adjustments, and the demo's tea poster recipe.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backgroundFrame, gradeColor, gradeFromPreset, isNeutralGrade, maskPath } from '../core';
import recipe from '../web/demo/tea-poster.json';

describe('desktop features, drawn on the web', () => {
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

  it('the tea poster recipe names a demo photo for every frame and the background', () => {
    const r = recipe as unknown as { photos: string[]; sheet: { backgroundImage: { assetId: string }; elements: { type: string; assetId?: string | null }[] } };
    const files = new Set(r.photos);
    const refs = [r.sheet.backgroundImage.assetId, ...r.sheet.elements.filter((e) => e.type === 'image').map((e) => e.assetId!)];
    expect(refs.every((ref) => ref.startsWith('file:') && files.has(ref.slice(5)))).toBe(true);
  });
});

describe('README: Photobook Gallery', () => {
  const readme = readFileSync('README.md', 'utf8');
  const section = /^## Photobook Gallery$([\s\S]*?)^## /m.exec(readme)?.[1] ?? '';

  it('has a section of its own', () => {
    expect(section.length).toBeGreaterThan(500);
  });

  it('lists the viewer keys', () => {
    for (const key of ['**Left**', '**Right**', '**S**', '**I**', '**Esc**']) expect(section, key).toContain(key);
  });

  it('says where the info is kept, including for read-only folders', () => {
    expect(section).toContain('photoinfo.json');
    expect(section).toMatch(/read-only/i);
    expect(section).toContain('photoinfo/');
  });

  it('covers opening folders, filters, sorts and dragging into the editor', () => {
    for (const words of [/--gallery/, /Open folder/, /Include subfolders/, /filter/i, /sort/i, /drag/i, /Explorer/, /Open Gallery/]) expect(section).toMatch(words);
  });
});
