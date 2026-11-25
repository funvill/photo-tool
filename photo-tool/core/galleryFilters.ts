import type { GalleryFilter, TagFilter } from './gallerySort';

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
  /** Its key:value words for the search box (the dates have two, from: and to:; the search text none). */
  query?: QueryWord[];
}

/** What a query word may need to know of the open folder. */
export interface QueryContext {
  /** The open folder's relDirs ('' is the top folder). */
  dirs: string[];
}

/** One key:value word, e.g. star:yes. Keys shared by several filters (has:, is:) are tried in list order. */
export interface QueryWord {
  /** Lower case, without the colon: 'star', 'has', ... */
  key: string;
  /** Said after "isn't a filter: " for a value this key doesn't take, e.g. 'try star:yes or star:no'. */
  hint(value: string, ctx: QueryContext): string;
  /** Shown in the examples line under the search box when set. */
  example?: string;
  /** The filter this value sets, or null when it isn't this word's value. `value` is unquoted, not lower-cased. */
  parse(value: string, ctx: QueryContext): Partial<GalleryFilter> | TagFilter | null;
}

/** A word with a fixed set of values (case-insensitive). */
function choice(key: string, values: Record<string, Partial<GalleryFilter>>, hint: string, example?: string): QueryWord {
  return { key, example, hint: () => hint, parse: (v) => values[v.toLowerCase()] ?? null };
}

/** A real day written YYYY-MM-DD. */
function isDay(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const day = (key: 'from' | 'to', example?: string): QueryWord => ({
  key,
  example,
  hint: () => `try ${key}:YYYY-MM-DD`,
  parse: (v) => (isDay(v) ? { [key]: v } : null),
});

const tag = (key: string, kind: TagFilter['kind'], example?: string): QueryWord => ({
  key,
  example,
  hint: () => `try ${key}:<word>`,
  parse: (v) => (v.trim() ? { kind, value: v.trim().toLowerCase() } : null),
});

/** folder:<name>, a subfolder of the open folder matched case-insensitively and given back as its exact relDir; folder:top is the top folder. */
const FOLDER_WORD: QueryWord = {
  key: 'folder',
  hint: (v) => `no folder named ${v}`,
  parse: (v, ctx) => {
    if (v.toLowerCase() === 'top') return ctx.dirs.includes('') ? { relDir: '' } : null;
    const dir = ctx.dirs.find((d) => d !== '' && d.toLowerCase() === v.toLowerCase());
    return dir === undefined ? null : { relDir: dir };
  },
};

const HAS_HINT ='try has:location or has:people';
const IS_HINT = 'try is:lowquality or is:duplicate';

/** An entry for one key that shows one chip while on. */
function single<K extends keyof GalleryFilter>(id: string, key: K, group: FilterGroup, query: QueryWord, text: (v: NonNullable<GalleryFilter[K]>) => string, isOn = (v: GalleryFilter[K]) => !!v): FilterDef {
  return {
    id,
    query: [query],
    keys: [key],
    group,
    isOn: (f) => isOn(f[key]),
    chips: (f) => (isOn(f[key]) ? [{ id, text: text(f[key] as NonNullable<GalleryFilter[K]>), clear: { [key]: undefined } as Partial<GalleryFilter> }] : []),
  };
}

export const FILTERS: readonly FilterDef[] = [
  single('starred', 'starred', 'Photo', choice('star', { yes: { starred: 'yes' }, no: { starred: 'no' } }, 'try star:yes or star:no', 'star:yes'), (v) => (v === 'yes' ? 'Starred' : 'Not starred')),
  single('orientation', 'orientation', 'Photo', choice('shape', { portrait: { orientation: 'portrait' }, landscape: { orientation: 'landscape' } }, 'try shape:portrait or shape:landscape', 'shape:portrait'), (v) => (v === 'portrait' ? 'Portrait' : 'Landscape')),
  single('hidden', 'hidden', 'Photo', choice('hidden', { show: { hidden: 'show' }, only: { hidden: 'only' } }, 'try hidden:show or hidden:only'), (v) => (v === 'show' ? 'Hidden shown' : 'Only hidden')),
  {
    id: 'dates',
    keys: ['from', 'to'],
    group: 'When',
    query: [day('from', 'from:2024-06-01'), day('to')],
    isOn: (f) => !!(f.from || f.to),
    chips: (f) => {
      if (!f.from && !f.to) return [];
      const text = f.from && f.to ? `${f.from} → ${f.to}` : f.from ? `From ${f.from}` : `Until ${f.to}`;
      return [{ id: 'dates', text, clear: { from: undefined, to: undefined } }];
    },
  },
  single('relDir', 'relDir', 'Where', FOLDER_WORD, (v) => (v === '' ? 'Top folder' : v), (v) => v !== undefined),
  single('hasLocation', 'hasLocation', 'Where', choice('has', { location: { hasLocation: true } }, HAS_HINT), () => 'Has location'),
  single('hasPeople', 'hasPeople', 'Content', choice('has', { people: { hasPeople: true } }, HAS_HINT, 'has:people'), () => 'Has people'),
  {
    id: 'tags',
    keys: ['tags'],
    group: 'Content',
    query: [tag('tag', 'keyword', 'tag:lake'), tag('object', 'object')],
    isOn: (f) => !!f.tags?.length,
    chips: (f) =>
      (f.tags ?? []).map((t, i, all) => {
        const rest = all.filter((_, j) => j !== i);
        return { id: `tags:${t.kind}:${t.value}`, text: t.value, clear: { tags: rest.length ? rest : undefined } };
      }),
  },
  single('lowQuality', 'lowQuality', 'Quality', choice('is', { lowquality: { lowQuality: true } }, IS_HINT), () => 'Low quality'),
  single('nearDuplicates', 'nearDuplicates', 'Quality', choice('is', { duplicate: { nearDuplicates: true } }, IS_HINT), () => 'Near-duplicates'),
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
