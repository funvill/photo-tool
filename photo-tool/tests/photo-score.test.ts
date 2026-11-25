// The photo score: what each line counts, and how the person's own say (star, hide, nudges) adds in.
import { describe, expect, it } from 'vitest';
import type { GalleryFacts, GalleryItemLike } from '../core/gallerySort';
import { colourVariety, photoScores, SCORE_POINTS, scoreAdjustOf, type PhotoScore } from '../core/photoScore';

let n = 0;
type Over = Partial<GalleryItemLike> & { sharpness?: number; luma?: number; highlights?: number; shadows?: number; sx?: number; sy?: number; grid?: number[]; raw?: boolean };
function item(over: Over = {}): GalleryItemLike {
  n++;
  const { sharpness, luma, highlights, shadows, sx, sy, grid, raw, ...rest } = over;
  return {
    path: `D:\\T\\p${n}.jpg`,
    fileName: `p${n}.jpg`,
    relDir: '',
    size: 3_000_000,
    width: 4000,
    height: 2000,
    effectiveDate: null,
    effectiveLat: null,
    info: {},
    analysis: raw
      ? null
      : {
          sharpness: sharpness ?? 100,
          meanLuma: luma ?? 0.48,
          clippedShadows: shadows ?? 0,
          clippedHighlights: highlights ?? 0,
          dHash: '0000000000000000',
          saliencyX: sx ?? 0.5,
          saliencyY: sy ?? 0.5,
          colorGrid: grid ?? Array(27).fill(120),
        },
    ...rest,
  };
}

const line = (s: PhotoScore | undefined, label: string) => s?.lines.find((l) => l.label === label);
const NO_FACTS = new Map<string, GalleryFacts>();
const fact = (over: Partial<GalleryFacts>): GalleryFacts => ({ interesting: 0, colour: { bucket: 'neutral', lightness: 0 }, flags: { blurry: false, dark: false, bright: false, lowRes: false }, groupId: null, isKeeper: true, ...over });

describe('photoScores', () => {
  it('ranks focus within the folder: the sharpest gets all 35, the softest none', () => {
    const a = item({ sharpness: 10 });
    const b = item({ sharpness: 50 });
    const c = item({ sharpness: 900 });
    const s = photoScores([a, b, c], NO_FACTS);
    expect(line(s.get(c.path), 'Focus')?.points).toBe(SCORE_POINTS.focus);
    expect(line(s.get(c.path), 'Focus')?.why).toBe('sharper than 100 % of this folder');
    expect(line(s.get(b.path), 'Focus')?.points).toBe(18);
    expect(line(s.get(a.path), 'Focus')).toBeUndefined();
  });

  it('a lone photo is middling for focus', () => {
    const a = item();
    expect(line(photoScores([a], NO_FACTS).get(a.path), 'Focus')?.points).toBe(18);
  });

  it('gives full exposure points near the middle, fewer when dark or bright', () => {
    const mid = item({ luma: 0.48 });
    const dark = item({ luma: 0.15 });
    const s = photoScores([mid, dark], NO_FACTS);
    expect(line(s.get(mid.path), 'Exposure')?.points).toBe(SCORE_POINTS.exposure);
    expect(line(s.get(dark.path), 'Exposure')?.points).toBeLessThan(10);
    expect(line(s.get(dark.path), 'Exposure')?.why).toBe('on the dark side');
  });

  it('costs nothing for clipping up to 2 %, then up to 15 points, and says what was clipped', () => {
    const fine = item({ highlights: 0.01, shadows: 0.009 });
    const some = item({ highlights: 0.06, shadows: 0.02 });
    const lots = item({ highlights: 0.3 });
    const s = photoScores([fine, some, lots], NO_FACTS);
    expect(line(s.get(fine.path), 'Clipping')).toBeUndefined();
    expect(line(s.get(some.path), 'Clipping')?.points).toBe(-9);
    expect(line(s.get(some.path), 'Clipping')?.why).toBe('6 % blown to white, 2 % crushed to black');
    expect(line(s.get(lots.path), 'Clipping')?.points).toBe(-SCORE_POINTS.clipping);
  });

  it('counts colour variety, a subject on a third, and people (5 each, at most 10)', () => {
    const flat = item();
    const lively = item({ grid: Array.from({ length: 27 }, (_, i) => (i % 2 ? 255 : 0)), sx: 1 / 3, sy: 1 / 3, info: { people: ['Ann', 'Bo', 'Cy', 'Ann'] } });
    const one = item({ info: { people: ['Ann'] } });
    const s = photoScores([flat, lively, one], NO_FACTS);
    expect(line(s.get(flat.path), 'Colour variety')).toBeUndefined();
    expect(line(s.get(flat.path), 'Composition')).toBeUndefined();
    expect(line(s.get(lively.path), 'Colour variety')?.points).toBe(SCORE_POINTS.colour);
    expect(line(s.get(lively.path), 'Composition')?.points).toBe(SCORE_POINTS.thirds);
    expect(line(s.get(lively.path), 'People')).toEqual({ label: 'People', points: 10, why: '3 people tagged' });
    expect(line(s.get(one.path), 'People')?.points).toBe(5);
  });

  it('gives size points up to 8 megapixels', () => {
    const big = item({ width: 4000, height: 3000 });
    const small = item({ width: 2000, height: 1000 });
    const s = photoScores([big, small], NO_FACTS);
    expect(line(s.get(big.path), 'Size')).toEqual({ label: 'Size', points: 10, why: '12 megapixels' });
    expect(line(s.get(small.path), 'Size')).toEqual({ label: 'Size', points: 3, why: '2.0 megapixels' });
  });

  it('takes 10 from a burst shot that is not its burst\'s keeper', () => {
    const keep = item();
    const weak = item();
    const facts = new Map([
      [keep.path, fact({ groupId: keep.path, isKeeper: true })],
      [weak.path, fact({ groupId: keep.path, isKeeper: false })],
    ]);
    const s = photoScores([keep, weak], facts);
    expect(line(s.get(keep.path), 'Burst')).toBeUndefined();
    expect(line(s.get(weak.path), 'Burst')?.points).toBe(-SCORE_POINTS.burst);
  });

  it('adds +50 for a favourite, −50 when hidden, and the nudges one for one; the total is the sum of the lines', () => {
    const plain = item();
    const fav = item({ info: { star: true, scoreAdjust: 3 } });
    const hid = item({ info: { hidden: true, scoreAdjust: -2 } });
    const s = photoScores([plain, fav, hid], NO_FACTS);
    const base = s.get(plain.path)!.total;
    expect(s.get(fav.path)!.total).toBe(base + 50 + 3);
    expect(s.get(hid.path)!.total).toBe(base - 50 - 2);
    expect(line(s.get(fav.path), 'Your nudges')).toEqual({ label: 'Your nudges', points: 3, why: 'Up pressed 3 times more' });
    expect(line(s.get(hid.path), 'Your nudges')?.why).toBe('Down pressed 2 times more');
    for (const sc of s.values()) expect(sc.total).toBe(sc.lines.reduce((t, l) => t + l.points, 0));
  });

  it('scores a photo not analysed yet from what is known, and marks it', () => {
    const raw = item({ raw: true, info: { star: true } });
    const s = photoScores([raw, item()], NO_FACTS).get(raw.path)!;
    expect(s.analysed).toBe(false);
    expect(s.lines.map((l) => l.label)).toEqual(['Size', 'Favourite']);
    expect(s.total).toBe(10 + 50);
  });

  it('a plain, good photo lands in the expected range', () => {
    const photos = [item({ sharpness: 50 }), item({ sharpness: 300, sx: 0.36, sy: 0.4, grid: Array.from({ length: 27 }, (_, i) => (i * 29) % 256) }), item({ sharpness: 150 })];
    for (const s of photoScores(photos, NO_FACTS).values()) {
      expect(s.total).toBeGreaterThanOrEqual(25);
      expect(s.total).toBeLessThanOrEqual(90);
    }
  });
});

describe('scoreAdjustOf and colourVariety', () => {
  it('reads only whole-number nudges', () => {
    expect(scoreAdjustOf({ scoreAdjust: 4 })).toBe(4);
    expect(scoreAdjustOf({ scoreAdjust: -1 })).toBe(-1);
    expect(scoreAdjustOf({ scoreAdjust: 1.5 })).toBe(0);
    expect(scoreAdjustOf({ scoreAdjust: '3' })).toBe(0);
    expect(scoreAdjustOf({})).toBe(0);
  });

  it('is 0 for one flat colour or a missing grid', () => {
    expect(colourVariety(Array(27).fill(90))).toBe(0);
    expect(colourVariety(undefined)).toBe(0);
    expect(colourVariety(Array.from({ length: 27 }, (_, i) => (i % 2 ? 255 : 0)))).toBeGreaterThan(0.3);
  });
});
