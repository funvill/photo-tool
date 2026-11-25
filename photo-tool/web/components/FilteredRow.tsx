import { filterChips } from '../../core/galleryFilters';
import { isFilterActive } from '../../core/gallerySort';
import { useFilteredItems, useGallery } from '../store';
import { countText } from './FilterBar';

/**
 * Shown only while the grid is filtered: a removable chip per filter that is on, then "Showing X of Y"
 * (X the photos that pass, stacks unfolded and matches by meaning included; Y every photo in the folder)
 * and Clear filter. `onClear` clears every filter and the search box.
 */
export function FilteredRow({ onClear }: { onClear: () => void }) {
  const filter = useGallery((s) => s.filter);
  const total = useGallery((s) => s.items.length);
  const shown = useFilteredItems().length;
  if (!isFilterActive(filter)) return null;
  return (
    <div className="gallery-filtered-row" role="region" aria-label="Active filters">
      {filterChips(filter).map((c) => (
        <span key={c.id} className="gallery-chip on gallery-filter-chip">
          {c.text}
          <button type="button" aria-label={`Remove filter ${c.text}`} title="Remove this filter" onClick={() => useGallery.getState().setFilter(c.clear)}>
            ×
          </button>
        </span>
      ))}
      <span className="gallery-filtered-count">
        <span className="muted" aria-live="polite">{countText(shown, total, true)}</span>
        <span className="muted" aria-hidden="true">·</span>
        <button type="button" className="btn btn-small" onClick={onClear}>
          Clear filter
        </button>
      </span>
    </div>
  );
}
