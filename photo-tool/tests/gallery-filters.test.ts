import { describe, expect, it } from 'vitest';
import { activeFilterCount, FILTER_GROUPS, filterChips, FILTERS } from '../core/galleryFilters';
import { isFilterActive, type GalleryFilter } from '../core/gallerySort';

// Every key of GalleryFilter. A key added to GalleryFilter and not here is a compile error, and a key
// here that no entry of FILTERS owns fails the first test: a new filter can't ship without its chip and panel place.
const ALL_KEYS: Record<keyof GalleryFilter, true> = {
  starred: true,
  from: true,
  to: true,
  lowQuality: true,
  nearDuplicates: true,
  orientation: true,
  hasLocation: true,
  hasPeople: true,
  hidden: true,
  relDir: true,
  text: true,
  tags: true,
};

const chipTexts = (f: GalleryFilter) => filterChips(f).map((c) => c.text);

describe('the list of filters', () => {
  it('every GalleryFilter key belongs to exactly one filter', () => {
    expect(FILTERS.flatMap((d) => d.keys).sort()).toEqual(Object.keys(ALL_KEYS).sort());
  });

  it('every filter but the search text has a panel group, and the groups are in panel order', () => {
    expect(FILTER_GROUPS).toEqual(['Photo', 'When', 'Where', 'Content', 'Quality']);
    for (const d of FILTERS) expect(d.group === null).toBe(d.id === 'text');
  });

  it('every panel filter brings its own panel controls, for its own keys', () => {
    for (const d of FILTERS) {
      if (d.group === null) {
        expect(d.controls, d.id).toBeUndefined();
        continue;
      }
      expect(d.controls.length, d.id).toBeGreaterThan(0);
      for (const c of d.controls) {
        if ('key' in c) expect(d.keys, `${d.id} ${c.kind}`).toContain(c.key);
        if (c.kind === 'folder') expect(d.keys).toEqual(['relDir']);
        if (c.kind === 'tags') expect(d.keys).toEqual(['tags']);
      }
    }
    // Today's labels, in panel order.
    const labels = FILTERS.flatMap((d) => (d.group === null ? [] : d.controls.map((c) => ('label' in c ? c.label : c.kind))));
    expect(labels).toEqual(['Stars', 'Shape', 'Hidden', 'From', 'To', 'Folder', 'Has location', 'Has people', 'tags', 'Low quality', 'Near-duplicates']);
  });

  it('chip text', () => {
    expect(chipTexts({ starred: 'yes' })).toEqual(['Starred']);
    expect(chipTexts({ starred: 'no' })).toEqual(['Not starred']);
    expect(chipTexts({ orientation: 'portrait' })).toEqual(['Portrait']);
    expect(chipTexts({ orientation: 'landscape' })).toEqual(['Landscape']);
    expect(chipTexts({ from: '2024-06-01' })).toEqual(['From 2024-06-01']);
    expect(chipTexts({ to: '2024-06-09' })).toEqual(['Until 2024-06-09']);
    const both = filterChips({ from: '2024-06-01', to: '2024-06-09' });
    expect(both.map((c) => c.text)).toEqual(['2024-06-01 → 2024-06-09']);
    expect(both[0].clear).toEqual({ from: undefined, to: undefined });
    expect(chipTexts({ hidden: 'show' })).toEqual(['Hidden shown']);
    expect(chipTexts({ hidden: 'only' })).toEqual(['Only hidden']);
    expect(chipTexts({ relDir: '' })).toEqual(['Top folder']);
    expect(chipTexts({ relDir: 'Day 2' })).toEqual(['Day 2']);
    expect(chipTexts({ hasLocation: true })).toEqual(['Has location']);
    expect(chipTexts({ hasPeople: true })).toEqual(['Has people']);
    expect(chipTexts({ lowQuality: true })).toEqual(['Low quality']);
    expect(chipTexts({ nearDuplicates: true })).toEqual(['Near-duplicates']);
    const tags = filterChips({ tags: [{ kind: 'keyword', value: 'lake' }, { kind: 'object', value: 'boat' }] });
    expect(tags.map((c) => c.text)).toEqual(['lake', 'boat']);
    expect(tags[0].clear).toEqual({ tags: [{ kind: 'object', value: 'boat' }] });
    expect(filterChips({ tags: [{ kind: 'object', value: 'boat' }] })[0].clear).toEqual({ tags: undefined });
    expect(filterChips({ text: 'x' })).toEqual([]);
  });

  it('a chip clears only its own filter', () => {
    const f: GalleryFilter = { starred: 'yes', orientation: 'portrait', hasPeople: true };
    for (const c of filterChips(f)) {
      const after = { ...f, ...c.clear };
      expect(chipTexts(after)).not.toContain(c.text);
      expect(chipTexts(after)).toHaveLength(2);
    }
  });

  it('chips come in list order, with unique ids', () => {
    const chips = filterChips({ nearDuplicates: true, starred: 'yes', tags: [{ kind: 'keyword', value: 'a' }], relDir: 'x' });
    expect(chips.map((c) => c.text)).toEqual(['Starred', 'x', 'a', 'Near-duplicates']);
    expect(new Set(chips.map((c) => c.id)).size).toBe(chips.length);
  });

  it('count leaves the search text out', () => {
    expect(activeFilterCount({ starred: 'yes', from: 'a', to: 'b', text: 'x' })).toBe(2);
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ tags: [{ kind: 'keyword', value: 'a' }, { kind: 'keyword', value: 'b' }] })).toBe(1);
  });

  it('isFilterActive agrees with the list', () => {
    const cases: [GalleryFilter, boolean][] = [
      [{}, false],
      [{ text: '  ' }, false],
      [{ text: 'x' }, true],
      [{ relDir: '' }, true],
      [{ tags: [] }, false],
      [{ starred: 'yes' }, true],
      [{ starred: 'no' }, true],
      [{ orientation: 'portrait' }, true],
      [{ from: '2024-06-01' }, true],
      [{ to: '2024-06-09' }, true],
      [{ hidden: 'show' }, true],
      [{ hidden: 'only' }, true],
      [{ relDir: 'Day 2' }, true],
      [{ hasLocation: true }, true],
      [{ hasPeople: true }, true],
      [{ lowQuality: true }, true],
      [{ nearDuplicates: true }, true],
      [{ tags: [{ kind: 'keyword', value: 'lake' }] }, true],
    ];
    for (const [f, on] of cases) {
      expect(isFilterActive(f)).toBe(on);
      expect(FILTERS.some((d) => d.isOn(f))).toBe(on);
    }
  });
});
