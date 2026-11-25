import { useMemo } from 'react';
import type { GalleryFilter, GallerySortKey } from '../../../core/gallerySort';
import { isFilterActive } from '../../../core/gallerySort';
import { useGallery, useVisibleItems } from '../store';

const SORTS: { key: GallerySortKey; label: string }[] = [
  { key: 'date', label: 'Date taken' },
  { key: 'score', label: 'Photo score' },
  { key: 'interesting', label: 'Most interesting' },
  { key: 'colour', label: 'Main colour' },
  { key: 'name', label: 'File name' },
];

/** "312 of 2,140" while a filter is set, else "2,140 photos". */
export function countText(shown: number, total: number, filtered: boolean): string {
  if (filtered) return `${shown.toLocaleString()} of ${total.toLocaleString()}`;
  return `${total.toLocaleString()} ${total === 1 ? 'photo' : 'photos'}`;
}

const set = (patch: Partial<GalleryFilter>) => useGallery.getState().setFilter(patch);

function Toggle({ label, field }: { label: string; field: 'lowQuality' | 'nearDuplicates' | 'hasLocation' | 'hasPeople' }) {
  const on = useGallery((s) => s.filter[field] === true);
  return (
    <label className="row gallery-check">
      <input type="checkbox" checked={on} onChange={(e) => set({ [field]: e.target.checked || undefined })} />
      {label}
    </label>
  );
}

/** The bar under the folder bar: sort order, filters, and how many photos pass them. */
export function FilterBar() {
  const sort = useGallery((s) => s.sort);
  const filter = useGallery((s) => s.filter);
  const stacked = useGallery((s) => s.stacked);
  const items = useGallery((s) => s.items);
  const shown = useVisibleItems().length;
  const dirs = useMemo(() => [...new Set(items.map((i) => i.relDir))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))), [items]);
  const active = isFilterActive(filter);

  return (
    <div className="gallery-filters" role="search" aria-label="Sort and filter">
      <label className="row gallery-field">
        Sort
        <select value={sort} onChange={(e) => useGallery.getState().setSort(e.target.value as GallerySortKey)}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </label>
      <label className="row gallery-field">
        Stars
        <select value={filter.starred ?? ''} onChange={(e) => set({ starred: (e.target.value || undefined) as GalleryFilter['starred'] })}>
          <option value="">All</option>
          <option value="yes">Starred</option>
          <option value="no">Not starred</option>
        </select>
      </label>
      <label className="row gallery-field">
        Shape
        <select value={filter.orientation ?? ''} onChange={(e) => set({ orientation: (e.target.value || undefined) as GalleryFilter['orientation'] })}>
          <option value="">Any</option>
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </label>
      <label className="row gallery-field">
        From
        <input type="date" value={filter.from ?? ''} max={filter.to} onChange={(e) => set({ from: e.target.value || undefined })} />
      </label>
      <label className="row gallery-field">
        To
        <input type="date" value={filter.to ?? ''} min={filter.from} onChange={(e) => set({ to: e.target.value || undefined })} />
      </label>
      <label className="row gallery-field">
        Hidden
        <select value={filter.hidden ?? ''} onChange={(e) => set({ hidden: (e.target.value || undefined) as GalleryFilter['hidden'] })}>
          <option value="">Leave out</option>
          <option value="show">Show</option>
          <option value="only">Only</option>
        </select>
      </label>
      {dirs.length > 1 && (
        <label className="row gallery-field">
          Folder
          <select value={filter.relDir === undefined ? '' : `d:${filter.relDir}`} onChange={(e) => set({ relDir: e.target.value === '' ? undefined : e.target.value.slice(2) })}>
            <option value="">All folders</option>
            {dirs.map((d) => (
              <option key={d} value={`d:${d}`}>{d === '' ? 'Top folder' : d}</option>
            ))}
          </select>
        </label>
      )}
      <Toggle label="Low quality" field="lowQuality" />
      <Toggle label="Near-duplicates" field="nearDuplicates" />
      <Toggle label="Has location" field="hasLocation" />
      <Toggle label="Has people" field="hasPeople" />
      <label className="row gallery-check" title="Show the near-identical shots of a burst as one photo">
        <input type="checkbox" checked={stacked} onChange={(e) => useGallery.getState().setStacked(e.target.checked)} />
        Stack similar
      </label>
      <input
        type="search"
        className="gallery-search"
        placeholder="Search descriptions and notes"
        aria-label="Search descriptions and notes"
        value={filter.text ?? ''}
        onChange={(e) => set({ text: e.target.value || undefined })}
      />
      {filter.tags?.map((t) => (
        <span key={`${t.kind}:${t.value}`} className="gallery-chip on gallery-filter-chip">
          {t.value}
          <button type="button" aria-label={`Remove filter ${t.value}`} onClick={() => useGallery.getState().toggleTagFilter(t)}>
            ×
          </button>
        </span>
      ))}
      <span className="muted gallery-count" aria-live="polite">{countText(shown, items.length, active)}</span>
      <button type="button" className="btn" disabled={!active} onClick={() => useGallery.getState().clearFilter()}>
        Clear
      </button>
    </div>
  );
}
