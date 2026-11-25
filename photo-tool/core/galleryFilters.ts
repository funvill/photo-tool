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

/**
 * One control in the Filters panel, as data: the panel draws each kind (an exhaustive switch, so a new
 * kind doesn't compile until it is drawn). The first `select` option is the "off" one (value '').
 */
export type PanelControl =
  | { kind: 'select'; label: string; key: 'starred' | 'orientation' | 'hidden'; options: { value: string; label: string }[] }
  | { kind: 'date'; label: string; key: 'from' | 'to' }
  | { kind: 'check'; label: string; key: 'lowQuality' | 'nearDuplicates' | 'hasLocation' | 'hasPeople' }
  /** The open folder's subfolders (shown only when there are any). */
  | { kind: 'folder'; label: string }
  /** The keyword and object chips that are on. */
  | { kind: 'tags' };

interface FilterDefBase {
  id: string;
  /** The GalleryFilter keys it owns. */
  keys: (keyof GalleryFilter)[];
  /** [] while off; the tags give one chip per tag; the search text gives none. */
  chips(f: GalleryFilter): FilterChip[];
  isOn(f: GalleryFilter): boolean;
  /** Its key:value words for the search box (the dates have two, from: and to:; the search text none). */
  query?: QueryWord[];
}

/**
 * A filter in the panel must bring its controls (at least one): an entry with a group and no controls
 * doesn't compile. `group` null: not in the panel (the search text lives in the search box).
 */
export type FilterDef = FilterDefBase & ({ group: FilterGroup; controls: [PanelControl, ...PanelControl[]] } | { group: null; controls?: undefined });

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

/** A word with a fixed set of values (case-insensitive). A Map, so star:constructor or has:__proto__ is no value. */
function choice(key: string, values: Record<string, Partial<GalleryFilter>>, hint: string, example?: string): QueryWord {
  const table = new Map(Object.entries(values));
  return { key, example, hint: () => hint, parse: (v) => table.get(v.toLowerCase()) ?? null };
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

/** An entry for one key (its id is the key) with one panel control, one query word and one chip while on. */
function single<K extends keyof GalleryFilter>(
  id: K,
  group: FilterGroup,
  control: PanelControl,
  query: QueryWord,
  text: (v: NonNullable<GalleryFilter[K]>) => string,
  isOn = (v: GalleryFilter[K]) => !!v,
): FilterDef {
  return {
    id,
    keys: [id],
    group,
    controls: [control],
    query: [query],
    isOn: (f) => isOn(f[id]),
    chips: (f) => (isOn(f[id]) ? [{ id, text: text(f[id] as NonNullable<GalleryFilter[K]>), clear: { [id]: undefined } as Partial<GalleryFilter> }] : []),
  };
}

const opts = (off: string, ...on: [string, string][]) => [{ value: '', label: off }, ...on.map(([value, label]) => ({ value, label }))];

export const FILTERS: readonly FilterDef[] = [
  single(
    'starred',
    'Photo',
    { kind: 'select', label: 'Stars', key: 'starred', options: opts('All', ['yes', 'Starred'], ['no', 'Not starred']) },
    choice('star', { yes: { starred: 'yes' }, no: { starred: 'no' } }, 'try star:yes or star:no', 'star:yes'),
    (v) => (v === 'yes' ? 'Starred' : 'Not starred'),
  ),
  single(
    'orientation',
    'Photo',
    { kind: 'select', label: 'Shape', key: 'orientation', options: opts('Any', ['portrait', 'Portrait'], ['landscape', 'Landscape']) },
    choice('shape', { portrait: { orientation: 'portrait' }, landscape: { orientation: 'landscape' } }, 'try shape:portrait or shape:landscape', 'shape:portrait'),
    (v) => (v === 'portrait' ? 'Portrait' : 'Landscape'),
  ),
  single(
    'hidden',
    'Photo',
    { kind: 'select', label: 'Hidden', key: 'hidden', options: opts('Leave out', ['show', 'Show'], ['only', 'Only']) },
    choice('hidden', { show: { hidden: 'show' }, only: { hidden: 'only' } }, 'try hidden:show or hidden:only'),
    (v) => (v === 'show' ? 'Hidden shown' : 'Only hidden'),
  ),
  {
    id: 'dates',
    keys: ['from', 'to'],
    group: 'When',
    controls: [
      { kind: 'date', label: 'From', key: 'from' },
      { kind: 'date', label: 'To', key: 'to' },
    ],
    query: [day('from', 'from:2024-06-01'), day('to')],
    isOn: (f) => !!(f.from || f.to),
    chips: (f) => {
      if (!f.from && !f.to) return [];
      const text = f.from && f.to ? `${f.from} → ${f.to}` : f.from ? `From ${f.from}` : `Until ${f.to}`;
      return [{ id: 'dates', text, clear: { from: undefined, to: undefined } }];
    },
  },
  single('relDir', 'Where', { kind: 'folder', label: 'Folder' }, FOLDER_WORD, (v) => (v === '' ? 'Top folder' : v), (v) => v !== undefined),
  single('hasLocation', 'Where', { kind: 'check', label: 'Has location', key: 'hasLocation' }, choice('has', { location: { hasLocation: true } }, HAS_HINT), () => 'Has location'),
  single('hasPeople', 'Content', { kind: 'check', label: 'Has people', key: 'hasPeople' }, choice('has', { people: { hasPeople: true } }, HAS_HINT, 'has:people'), () => 'Has people'),
  {
    id: 'tags',
    keys: ['tags'],
    group: 'Content',
    controls: [{ kind: 'tags' }],
    query: [tag('tag', 'keyword', 'tag:lake'), tag('object', 'object')],
    isOn: (f) => !!f.tags?.length,
    chips: (f) =>
      (f.tags ?? []).map((t, i, all) => {
        const rest = all.filter((_, j) => j !== i);
        return { id: `tags:${t.kind}:${t.value}`, text: t.value, clear: { tags: rest.length ? rest : undefined } };
      }),
  },
  single('lowQuality', 'Quality', { kind: 'check', label: 'Low quality', key: 'lowQuality' }, choice('is', { lowquality: { lowQuality: true } }, IS_HINT), () => 'Low quality'),
  single('nearDuplicates', 'Quality', { kind: 'check', label: 'Near-duplicates', key: 'nearDuplicates' }, choice('is', { duplicate: { nearDuplicates: true } }, IS_HINT), () => 'Near-duplicates'),
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
