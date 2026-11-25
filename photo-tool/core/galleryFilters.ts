import type { GalleryFilter } from './gallerySort';

// The one list of the grid's filters. Each entry owns some GalleryFilter keys and says where it sits in
// the Filters panel, what its chips say, how to clear it and whether it is on. The panel, the chips, the
// Filters · N badge and isFilterActive all read this list; a test fails when a GalleryFilter key has no entry.
// Only types are imported from gallerySort.ts (it imports FILTERS), so there is no import cycle at run time.

export type FilterGroup = 'Photo' | 'When' | 'Where' | 'Content' | 'Quality';

/** One removable chip: `clear` is the setFilter patch that turns just this chip off. */
export interface FilterChip {
  id: string;
  text: string;
  clear: Partial<GalleryFilter>;
}

export interface FilterDef {
  id: string;
  /** The GalleryFilter keys it owns. */
  keys: (keyof GalleryFilter)[];
  /** Its group in the Filters panel; null when it is not in the panel (the search text lives in the search box). */
  group: FilterGroup | null;
  /** [] while off; the tags give one chip per tag; the search text gives none. */
  chips(f: GalleryFilter): FilterChip[];
  isOn(f: GalleryFilter): boolean;
}

/** An entry for one key that shows one chip while on. */
function single<K extends keyof GalleryFilter>(id: string, key: K, group: FilterGroup, text: (v: NonNullable<GalleryFilter[K]>) => string, isOn = (v: GalleryFilter[K]) => !!v): FilterDef {
  return {
    id,
    keys: [key],
    group,
    isOn: (f) => isOn(f[key]),
    chips: (f) => (isOn(f[key]) ? [{ id, text: text(f[key] as NonNullable<GalleryFilter[K]>), clear: { [key]: undefined } as Partial<GalleryFilter> }] : []),
  };
}

export const FILTERS: readonly FilterDef[] = [
  single('starred', 'starred', 'Photo', (v) => (v === 'yes' ? 'Starred' : 'Not starred')),
  single('orientation', 'orientation', 'Photo', (v) => (v === 'portrait' ? 'Portrait' : 'Landscape')),
  single('hidden', 'hidden', 'Photo', (v) => (v === 'show' ? 'Hidden shown' : 'Only hidden')),
  {
    id: 'dates',
    keys: ['from', 'to'],
    group: 'When',
    isOn: (f) => !!(f.from || f.to),
    chips: (f) => {
      if (!f.from && !f.to) return [];
      const text = f.from && f.to ? `${f.from} → ${f.to}` : f.from ? `From ${f.from}` : `Until ${f.to}`;
      return [{ id: 'dates', text, clear: { from: undefined, to: undefined } }];
    },
  },
  single('relDir', 'relDir', 'Where', (v) => (v === '' ? 'Top folder' : v), (v) => v !== undefined),
  single('hasLocation', 'hasLocation', 'Where', () => 'Has location'),
  single('hasPeople', 'hasPeople', 'Content', () => 'Has people'),
  {
    id: 'tags',
    keys: ['tags'],
    group: 'Content',
    isOn: (f) => !!f.tags?.length,
    chips: (f) =>
      (f.tags ?? []).map((t, i, all) => {
        const rest = all.filter((_, j) => j !== i);
        return { id: `tags:${t.kind}:${t.value}`, text: t.value, clear: { tags: rest.length ? rest : undefined } };
      }),
  },
  single('lowQuality', 'lowQuality', 'Quality', () => 'Low quality'),
  single('nearDuplicates', 'nearDuplicates', 'Quality', () => 'Near-duplicates'),
  { id: 'text', keys: ['text'], group: null, isOn: (f) => !!f.text?.trim(), chips: () => [] },
];

/** The Filters panel's groups, in order. */
export const FILTER_GROUPS: readonly FilterGroup[] = ['Photo', 'When', 'Where', 'Content', 'Quality'];

/** Every chip of the filters that are on, in FILTERS order. */
export function filterChips(f: GalleryFilter): FilterChip[] {
  return FILTERS.flatMap((d) => d.chips(f));
}

/** How many entries are on, the search text left out (the Filters · N badge). */
export function activeFilterCount(f: GalleryFilter): number {
  return FILTERS.filter((d) => d.group !== null && d.isOn(f)).length;
}
