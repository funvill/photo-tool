// Gallery sorting, filtering and the per-photo facts (interesting score, main colour, flags, bursts).
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GalleryItem } from '../server/app';
import { colourBucket, filterItems, galleryFacts, isFilterActive, sortItems, type GalleryFilter, type GalleryItemLike } from '../core/gallerySort';

// GalleryItem must keep satisfying the subset the pure sort code needs.
expectTypeOf<GalleryItem>().toExtend<GalleryItemLike>();

let n = 0;
function item(over: Partial<GalleryItemLike> & { avg?: [number, number, number]; sharpness?: number; hash?: string; luma?: number } = {}): GalleryItemLike {
  n++;
  const { avg, sharpness, hash, luma, ...rest } = over;
  const h = hash ?? Array.from({ length: 16 }, (_, i) => ((Math.imul(n, 2654435761) + i * 40503 * (i + 3)) >>> 0).toString(16).slice(-1)).join('');
  return {
    path: `D:\\T\\p${n}.jpg`,
    fileName: `p${String(n).padStart(4, '0')}.jpg`,
    relDir: '',
    size: 3_000_000,
    width: 4000,
    height: 3000,
    effectiveDate: `2026-03-${String(1 + (n % 20)).padStart(2, '0')}T10:00:00`,
    effectiveLat: null,
    info: {},
    analysis: {
      sharpness: sharpness ?? 100 + ((n * 37) % 400),
      meanLuma: luma ?? 0.45,
      clippedShadows: 0.01,
      clippedHighlights: 0.01,
      dHash: h,
      saliencyX: 0.5,
      saliencyY: 0.5,
      avgColor: avg ?? [100 + (n % 50), 100, 90],
      colorGrid: Array.from({ length: 27 }, (_, i) => (i * 37 + n * 11) % 256),
    },
    ...rest,
  };
}

describe('colourBucket', () => {
  it('names the hue and rates the lightness', () => {
    expect(colourBucket([220, 40, 40]).bucket).toBe('red');
    expect(colourBucket([40, 90, 220]).bucket).toBe('blue');
    expect(colourBucket([128, 128, 128]).bucket).toBe('neutral');
  });
  it('uses perceptual hue ranges (lower bound inclusive, red wraps)', () => {
    expect(colourBucket([255, 0, 20]).bucket).toBe('red'); // ~352
    expect(colourBucket([255, 128, 0]).bucket).toBe('orange'); // 30
    expect(colourBucket([255, 255, 0]).bucket).toBe('yellow'); // 60
    expect(colourBucket([0, 255, 0]).bucket).toBe('green'); // 120
    expect(colourBucket([0, 255, 255]).bucket).toBe('cyan'); // 180
    expect(colourBucket([128, 0, 255]).bucket).toBe('purple'); // ~270
    expect(colourBucket([255, 0, 128]).bucket).toBe('pink'); // ~330
    expect(colourBucket([255, 60, 0]).bucket).toBe('red'); // 14.1
    expect(colourBucket([255, 64, 0]).bucket).toBe('orange'); // 15.06
  });
  it('lightness is HSL lightness 0..1', () => {
    expect(colourBucket([255, 255, 255]).lightness).toBe(1);
    expect(colourBucket([0, 0, 0]).lightness).toBe(0);
  });
});

describe('galleryFacts', () => {
  it('finds a burst: one keeper, shared group id, keeper scores higher', () => {
    const burst = [item({ hash: '0f0f0f0f0f0f0f0f', sharpness: 500 }), item({ hash: '0f0f0f0f0f0f0f0e', sharpness: 200 }), item({ hash: '0f0f0f0f0f0f0f0d', sharpness: 120 })];
    for (const b of burst) b.effectiveDate = '2026-03-01T10:00:00';
    const others = Array.from({ length: 4 }, () => item());
    const facts = galleryFacts([...burst, ...others]);
    const f = burst.map((b) => facts.get(b.path)!);
    expect(new Set(f.map((x) => x.groupId)).size).toBe(1);
    expect(f[0].groupId).not.toBeNull();
    expect(f.filter((x) => x.isKeeper)).toHaveLength(1);
    const keeper = f.find((x) => x.isKeeper)!;
    for (const x of f.filter((y) => !y.isKeeper)) expect(keeper.interesting).toBeGreaterThan(x.interesting);
    for (const o of others) expect(facts.get(o.path)!.groupId).toBeNull();
  });
  it('flags a blurry photo in a set of five or more', () => {
    const set = [item({ sharpness: 400 }), item({ sharpness: 420 }), item({ sharpness: 450 }), item({ sharpness: 480 }), item({ sharpness: 5 })];
    const facts = galleryFacts(set);
    expect(facts.get(set[4].path)!.flags.blurry).toBe(true);
    expect(facts.get(set[0].path)!.flags.blurry).toBe(false);
    expect(filterItems(set, { lowQuality: true }, facts).map((i) => i.path)).toEqual([set[4].path]);
  });
  it('scores 0..1 and copes with photos that are not analysed yet', () => {
    const plain = item({ analysis: null });
    const a = item();
    const facts = galleryFacts([plain, a]);
    const v = facts.get(a.path)!.interesting;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(facts.get(plain.path)!.flags).toEqual({ blurry: false, dark: false, bright: false, lowRes: false });
  });
  it('computes 3,000 photos in under a second', () => {
    const many = Array.from({ length: 3000 }, (_, i) => item({ effectiveDate: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00` }));
    const t = performance.now();
    const facts = galleryFacts(many);
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(1000);
    expect(facts.size).toBe(3000);
  });
});

describe('sortItems', () => {
  it('date: oldest first, undated last, ties by file name', () => {
    const undated = item({ effectiveDate: null, fileName: 'a.jpg' });
    const b = item({ effectiveDate: '2026-01-02T00:00:00', fileName: 'b.jpg' });
    const c = item({ effectiveDate: '2026-01-02T00:00:00', fileName: 'a.jpg' });
    const early = item({ effectiveDate: '2025-12-31T00:00:00', fileName: 'z.jpg' });
    const list = [undated, b, c, early];
    const out = sortItems(list, 'date', galleryFacts(list));
    expect(out).toEqual([early, c, b, undated]);
    expect(list[0]).toBe(undated); // the input is left alone
  });
  it('interesting: best first, unanalysed last', () => {
    const none = item({ analysis: null });
    const list = [none, ...Array.from({ length: 5 }, () => item())];
    const facts = galleryFacts(list);
    const out = sortItems(list, 'interesting', facts);
    expect(out[out.length - 1]).toBe(none);
    for (let i = 1; i < out.length - 1; i++) expect(facts.get(out[i - 1].path)!.interesting).toBeGreaterThanOrEqual(facts.get(out[i].path)!.interesting);
  });
  it('colour: red to pink then neutral, by lightness, unanalysed last', () => {
    const blue = item({ avg: [40, 90, 220] });
    const redDark = item({ avg: [120, 10, 10] });
    const redLight = item({ avg: [250, 120, 120] });
    const grey = item({ avg: [128, 128, 128] });
    const none = item({ analysis: null });
    const list = [none, grey, blue, redLight, redDark];
    const out = sortItems(list, 'colour', galleryFacts(list));
    expect(out).toEqual([redDark, redLight, blue, grey, none]);
  });
  it('name: natural order', () => {
    const a = item({ fileName: 'IMG_10.jpg' });
    const b = item({ fileName: 'IMG_9.jpg' });
    expect(sortItems([a, b], 'name', new Map())).toEqual([b, a]);
  });
});

describe('filterItems', () => {
  const run = (list: GalleryItemLike[], f: GalleryFilter) => filterItems(list, f, galleryFacts(list));
  it('combines starred, orientation and text', () => {
    const hit = item({ width: 3000, height: 4000, info: { star: true, description: 'Day at the Beach' } });
    const notStar = item({ width: 3000, height: 4000, info: { description: 'beach' } });
    const landscape = item({ info: { star: true, notes: 'beach' } });
    const other = item({ width: 3000, height: 4000, info: { star: true, description: 'forest' } });
    expect(run([hit, notStar, landscape, other], { starred: 'yes', orientation: 'portrait', text: 'BEACH' })).toEqual([hit]);
  });
  it('filterItems with tags keeps photos having every keyword/object; isFilterActive true', () => {
    const tags = (keywords: string[], objects: string[]) => ({ keywords, objects: objects.map((label) => ({ label, count: 1 })) });
    const both = item({ tags: tags(['lake', 'boat'], ['person']) });
    const lakeOnly = item({ tags: tags(['lake'], []) });
    const untagged = item({});
    const f: GalleryFilter = { tags: [{ kind: 'keyword', value: 'lake' }, { kind: 'object', value: 'person' }] };
    expect(run([both, lakeOnly, untagged], f)).toEqual([both]);
    expect(run([both, lakeOnly, untagged], { tags: [{ kind: 'keyword', value: 'lake' }] })).toEqual([both, lakeOnly]);
    expect(isFilterActive(f)).toBe(true);
    expect(isFilterActive({ tags: [] })).toBe(false);
  });
  it('text search matches machine description, keywords and objects, not only notes', () => {
    const described = item({ tags: { description: 'A boat on a calm LAKE.', keywords: [], objects: [] } });
    const keyworded = item({ tags: { keywords: ['sunset', 'harbour'], objects: [] } });
    const objected = item({ tags: { keywords: [], objects: [{ label: 'bicycle' }] } });
    const noted = item({ info: { notes: 'harbour walk' } });
    const none = item({});
    const all = [described, keyworded, objected, noted, none];
    expect(run(all, { text: 'lake' })).toEqual([described]);
    expect(run(all, { text: 'Harbour' })).toEqual([keyworded, noted]);
    expect(run(all, { text: 'bicyc' })).toEqual([objected]);
  });
  it('starred no, location, people', () => {
    const a = item({ info: { star: true } });
    const b = item({ effectiveLat: 10, info: { people: ['Ann'] } });
    const c = item({ info: { people: [] } });
    expect(run([a, b, c], { starred: 'no' })).toEqual([b, c]);
    expect(run([a, b, c], { hasLocation: true })).toEqual([b]);
    expect(run([a, b, c], { hasPeople: true })).toEqual([b]);
    expect(run([a, b, c], { hasPeople: true, starred: 'yes' })).toEqual([]);
  });
  it('relDir: equality, empty string is the top folder', () => {
    const top = item({ relDir: '' });
    const sub = item({ relDir: 'sub' });
    const deep = item({ relDir: 'sub/deep' });
    expect(run([top, sub, deep], { relDir: 'sub' })).toEqual([sub]);
    expect(run([top, sub, deep], { relDir: '' })).toEqual([top]);
    expect(run([top, sub, deep], {})).toEqual([top, sub, deep]);
  });
  it('date range is by day, inclusive, and drops undated', () => {
    const a = item({ effectiveDate: '2026-03-01T00:00:00' });
    const b = item({ effectiveDate: '2026-03-05T23:59:59' });
    const c = item({ effectiveDate: '2026-03-06T00:00:00' });
    const d = item({ effectiveDate: null });
    expect(run([a, b, c, d], { from: '2026-03-01', to: '2026-03-05' })).toEqual([a, b]);
    expect(run([a, b, c, d], { from: '2026-03-05' })).toEqual([b, c]);
    expect(run([a, b, c, d], { to: '2026-03-01' })).toEqual([a]);
  });
  it('near-duplicates shows every member of a group', () => {
    const burst = [item({ hash: 'ffff0000ffff0000' }), item({ hash: 'ffff0000ffff0001' })];
    for (const b of burst) b.effectiveDate = '2026-03-01T10:00:00';
    const lone = item({ effectiveDate: '2026-03-01T10:01:00' });
    expect(run([...burst, lone], { nearDuplicates: true })).toEqual(burst);
  });
  it('low quality includes dark, bright and low resolution', () => {
    const dark = item({ analysis: { ...item().analysis!, meanLuma: 0.05 } });
    const bright = item({ analysis: { ...item().analysis!, meanLuma: 0.95 } });
    const small = item({ width: 800, height: 600 });
    const fine = item();
    expect(run([dark, bright, small, fine], { lowQuality: true })).toEqual([dark, bright, small]);
  });
});

describe('hidden filter', () => {
  const run = (list: GalleryItemLike[], f: GalleryFilter) => filterItems(list, f, galleryFacts(list));
  const shown = item();
  const hidden = item({ info: { hidden: true } });
  it('filter hides hidden photos by default', () => {
    expect(run([shown, hidden], {})).toEqual([shown]);
  });
  it("hidden 'show' keeps them", () => {
    expect(run([shown, hidden], { hidden: 'show' })).toEqual([shown, hidden]);
  });
  it("hidden 'only' keeps only them", () => {
    expect(run([shown, hidden], { hidden: 'only' })).toEqual([hidden]);
  });
  it('a hidden setting counts as an active filter', () => {
    expect(isFilterActive({ hidden: 'show' })).toBe(true);
    expect(isFilterActive({})).toBe(false);
  });
});

describe('count text', () => {
  it('shows "312 of 2,140" while filtering and "2,140 photos" otherwise', async () => {
    const { countText } = await import('../web/components/FilterBar');
    expect(countText(312, 2140, true)).toBe('312 of 2,140');
    expect(countText(2140, 2140, false)).toBe('2,140 photos');
    expect(countText(1, 1, false)).toBe('1 photo');
  });
});
