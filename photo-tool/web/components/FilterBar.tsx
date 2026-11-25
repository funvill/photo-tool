import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeFilterCount } from '../../core/galleryFilters';
import { queryExamples, searchTextOf, takeQueryWords } from '../../core/galleryQuery';
import type { GalleryFilter, GallerySortKey } from '../../core/gallerySort';
import { isFilterActive } from '../../core/gallerySort';
import { useGallery } from '../store';
import { FilteredRow } from './FilteredRow';
import { FilterPanel } from './FilterPanel';

const SORTS: { key: GallerySortKey; label: string }[] = [
  { key: 'date', label: 'Date taken' },
  { key: 'score', label: 'Photo score' },
  { key: 'interesting', label: 'Most interesting' },
  { key: 'colour', label: 'Main colour' },
  { key: 'name', label: 'File name' },
];

const EXAMPLES = queryExamples();
const PANEL_ID = 'gallery-filter-panel';
const HINT_ID = 'gallery-search-hint';

/** "Showing 312 of 2,140" while a filter is set, else "2,140 photos". */
export function countText(shown: number, total: number, filtered: boolean): string {
  if (filtered) return `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`;
  return `${total.toLocaleString()} ${total === 1 ? 'photo' : 'photos'}`;
}

/** The box ends with a space that is not inside double quotes: the word before it is finished. */
const endsWord = (v: string) => v.endsWith(' ') && (v.split('"').length - 1) % 2 === 0;

/**
 * The bar under the folder bar: Sort, Stack similar, the search box (query words like star:yes become
 * filters) and the Filters button with its panel; then, while filtered, the row of chips with
 * "Showing X of Y · Clear filter".
 */
export function FilterBar() {
  const sort = useGallery((s) => s.sort);
  const filter = useGallery((s) => s.filter);
  const stacked = useGallery((s) => s.stacked);
  const items = useGallery((s) => s.items);
  const dirs = useMemo(() => [...new Set(items.map((i) => i.relDir))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))), [items]);
  const active = isFilterActive(filter);
  const count = activeFilterCount(filter);

  // The box holds the free text (the search text) and words still being typed; the filters live in the store.
  const [draft, setDraft] = useState(filter.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  // Follow changes to the search text made elsewhere (a chip's ×, What's in it, a cleared filter).
  useEffect(() => {
    setDraft((d) => (searchTextOf(d) === filter.text ? d : (filter.text ?? '')));
  }, [filter.text]);

  /** Takes the finished query words out of the box into the filters; true when it took any. */
  const take = (box: string, final: boolean): boolean => {
    const r = takeQueryWords(box, { dirs }, final);
    setError(r.error);
    if (!Object.keys(r.patch).length && !r.tags.length) return false;
    // On Enter every word is finished: what is left (bad words too) is the search text.
    const patch: Partial<GalleryFilter> = { ...r.patch, text: final ? r.rest.trim() || undefined : searchTextOf(r.rest) };
    if (r.tags.length) {
      const have = useGallery.getState().filter.tags ?? [];
      patch.tags = [...have, ...r.tags.filter((t) => !have.some((h) => h.kind === t.kind && h.value === t.value))];
    }
    setDraft(r.rest);
    useGallery.getState().setFilter(patch);
    return true;
  };

  const onChange = (v: string) => {
    setDraft(v);
    setError(null);
    if (endsWord(v) && take(v, false)) return;
    useGallery.getState().setFilter({ text: searchTextOf(v) });
  };

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  const clearAll = () => {
    setDraft('');
    setError(null);
    useGallery.getState().clearFilter();
  };

  return (
    <>
      <div className={`gallery-filters${open ? ' open' : ''}`} role="search" aria-label="Sort and filter">
        <label className="row gallery-field">
          Sort
          <select value={sort} onChange={(e) => useGallery.getState().setSort(e.target.value as GallerySortKey)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="row gallery-check" title="Show the near-identical shots of a burst as one photo">
          <input type="checkbox" checked={stacked} onChange={(e) => useGallery.getState().setStacked(e.target.checked)} />
          Stack similar
        </label>
        <div className="gallery-search-box">
          <input
            type="search"
            className="gallery-search"
            placeholder="Search descriptions, notes and keywords"
            aria-label="Search photos"
            aria-describedby={HINT_ID}
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !take(draft, true)) useGallery.getState().setFilter({ text: draft.trim() || undefined });
            }}
          />
          <p id={HINT_ID} className={`gallery-search-hint${error ? ' error' : ''}`} aria-live="polite">
            {error ?? (
              <>
                Try
                {EXAMPLES.map((x) => (
                  <code key={x}>{x}</code>
                ))}
              </>
            )}
          </p>
        </div>
        <div className="gallery-filters-anchor">
          <button
            ref={button}
            type="button"
            className={`btn gallery-filters-btn${count ? ' on' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={PANEL_ID}
            onClick={() => (open ? close(true) : setOpen(true))}
          >
            {count ? `Filters · ${count}` : 'Filters'}
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {open && <FilterPanel id={PANEL_ID} dirs={dirs} button={button} onClose={close} />}
        </div>
        {!active && <span className="muted gallery-count" aria-live="polite">{countText(items.length, items.length, false)}</span>}
      </div>
      <FilteredRow onClear={clearAll} />
    </>
  );
}
