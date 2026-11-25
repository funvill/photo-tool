import { FILTERS, type QueryContext, type QueryWord } from './galleryFilters';
import type { GalleryFilter, TagFilter } from './gallerySort';

// key:value words typed in the grid's search box (star:yes, shape:portrait, folder:"Day 2" ...). The words
// themselves come from the list of filters (galleryFilters.ts); this only splits the box and reads them.

export type { QueryContext } from './galleryFilters';

export interface QueryResult {
  /** Filters to set (tags not included). */
  patch: Partial<GalleryFilter>;
  /** Tags to add (deduped against each other, not against the filter already set). */
  tags: TagFilter[];
  /** What stays in the box: free text, bad words and an unfinished last word. */
  rest: string;
  /** The first bad word's message, or null. */
  error: string | null;
}

const WORDS: QueryWord[] = FILTERS.flatMap((d) => d.query ?? []);
const KEYS = new Set(WORDS.map((w) => w.key));
const SHAPE = /^([a-z]+):(.*)$/is;

/** The box split on spaces outside double quotes; `open` is the last word when the box doesn't end with such a space. */
function split(box: string): { words: string[]; open: string | null } {
  const words: string[] = [];
  let word = '';
  let quoted = false;
  for (const ch of box) {
    if (ch === '"') quoted = !quoted;
    if (ch === ' ' && !quoted) {
      if (word) words.push(word);
      word = '';
    } else word += ch;
  }
  return { words, open: word || null };
}

/** The known key of a key:value word, or null for plain text. */
function keyOf(word: string): { key: string; value: string } | null {
  const m = SHAPE.exec(word);
  if (!m || !KEYS.has(m[1].toLowerCase())) return null;
  return { key: m[1].toLowerCase(), value: m[2] };
}

const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, v.endsWith('"') && v.length > 1 ? -1 : undefined) : v);
const isTag = (r: Partial<GalleryFilter> | TagFilter): r is TagFilter => 'kind' in r;

/**
 * Takes the known key:value words out of the box. `final` (Enter) takes the last word too; while typing
 * (`final` false) a last word not yet followed by a space outside quotes is left in `rest` untouched.
 * A later word for the same filter wins. A known key with a value it doesn't take stays in `rest`.
 */
export function takeQueryWords(box: string, ctx: QueryContext, final: boolean): QueryResult {
  const { words, open } = split(box);
  if (open !== null && final) words.push(open);
  const patch: Partial<GalleryFilter> = {};
  const tags: TagFilter[] = [];
  const rest: string[] = [];
  let error: string | null = null;
  for (const word of words) {
    const kv = keyOf(word);
    if (!kv) {
      rest.push(word);
      continue;
    }
    const value = unquote(kv.value);
    const candidates = WORDS.filter((w) => w.key === kv.key);
    let found: Partial<GalleryFilter> | TagFilter | null = null;
    for (const w of candidates) if ((found = w.parse(value, ctx))) break;
    if (!found) {
      rest.push(word);
      error ??= `"${word}" isn't a filter: ${candidates[0].hint(value, ctx)}`;
    } else if (isTag(found)) {
      const t = found;
      if (!tags.some((x) => x.kind === t.kind && x.value === t.value)) tags.push(t);
    } else Object.assign(patch, found);
  }
  if (open !== null && !final) rest.push(open);
  return { patch, tags, rest: rest.join(' '), error };
}

/** The search text of the box: the box minus a trailing unfinished word that starts with a known key:, trimmed; undefined when empty. */
export function searchTextOf(box: string): string | undefined {
  const { open } = split(box);
  let text = box;
  if (open !== null && keyOf(open)) text = box.slice(0, box.length - open.length);
  return text.trim() || undefined;
}

/** The examples line under the search box, in list order. */
export function queryExamples(): string[] {
  return WORDS.flatMap((w) => (w.example ? [w.example] : []));
}
