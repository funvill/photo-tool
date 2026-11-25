import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { FILTER_GROUPS, FILTERS } from '../../core/galleryFilters';
import type { GalleryFilter } from '../../core/gallerySort';
import { useGallery } from '../store';

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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="gallery-filter-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Each panel filter's control, by its id in the list of filters (today's controls and labels). */
function Control({ id, filter, dirs }: { id: string; filter: GalleryFilter; dirs: string[] }) {
  switch (id) {
    case 'starred':
      return (
        <Field label="Stars">
          <select value={filter.starred ?? ''} onChange={(e) => set({ starred: (e.target.value || undefined) as GalleryFilter['starred'] })}>
            <option value="">All</option>
            <option value="yes">Starred</option>
            <option value="no">Not starred</option>
          </select>
        </Field>
      );
    case 'orientation':
      return (
        <Field label="Shape">
          <select value={filter.orientation ?? ''} onChange={(e) => set({ orientation: (e.target.value || undefined) as GalleryFilter['orientation'] })}>
            <option value="">Any</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </Field>
      );
    case 'hidden':
      return (
        <Field label="Hidden">
          <select value={filter.hidden ?? ''} onChange={(e) => set({ hidden: (e.target.value || undefined) as GalleryFilter['hidden'] })}>
            <option value="">Leave out</option>
            <option value="show">Show</option>
            <option value="only">Only</option>
          </select>
        </Field>
      );
    case 'dates':
      return (
        <>
          <Field label="From">
            <input type="date" value={filter.from ?? ''} max={filter.to} onChange={(e) => set({ from: e.target.value || undefined })} />
          </Field>
          <Field label="To">
            <input type="date" value={filter.to ?? ''} min={filter.from} onChange={(e) => set({ to: e.target.value || undefined })} />
          </Field>
        </>
      );
    case 'relDir':
      // Only when the open folder has subfolders.
      if (dirs.length < 2) return null;
      return (
        <Field label="Folder">
          <select value={filter.relDir === undefined ? '' : `d:${filter.relDir}`} onChange={(e) => set({ relDir: e.target.value === '' ? undefined : e.target.value.slice(2) })}>
            <option value="">All folders</option>
            {dirs.map((d) => (
              <option key={d} value={`d:${d}`}>{d === '' ? 'Top folder' : d}</option>
            ))}
          </select>
        </Field>
      );
    case 'hasLocation':
      return <Toggle label="Has location" field="hasLocation" />;
    case 'hasPeople':
      return <Toggle label="Has people" field="hasPeople" />;
    case 'tags':
      return filter.tags?.length ? (
        <div className="gallery-chip-row" aria-label="Keywords and objects">
          {filter.tags.map((t) => (
            <span key={`${t.kind}:${t.value}`} className="gallery-chip on gallery-filter-chip">
              {t.value}
              <button type="button" aria-label={`Remove filter ${t.value}`} onClick={() => useGallery.getState().toggleTagFilter(t)}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="muted gallery-filter-note">Pick a keyword under What's in it, or type tag:word in the search box.</p>
      );
    case 'lowQuality':
      return <Toggle label="Low quality" field="lowQuality" />;
    case 'nearDuplicates':
      return <Toggle label="Near-duplicates" field="nearDuplicates" />;
    default:
      return null;
  }
}

/**
 * The Filters popover: one group per FILTER_GROUPS, the list's filters in it. A dialog, so the review keys
 * leave keys typed in it alone. Esc closes it (and nothing else); so do a press outside it and its button.
 * Focus goes to its first control on open; `onClose(true)` asks for it to go back to the button.
 */
export function FilterPanel({ id, dirs, button, onClose }: { id: string; dirs: string[]; button: RefObject<HTMLButtonElement | null>; onClose: (refocus: boolean) => void }) {
  const filter = useGallery((s) => s.filter);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('select, input, button')?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || button.current?.contains(t)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [button, onClose]);

  return (
    <div
      id={id}
      ref={ref}
      className="gallery-filter-panel"
      role="dialog"
      aria-label="Filters"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      }}
    >
      {FILTER_GROUPS.map((g) => (
        <fieldset key={g} className="gallery-filter-group">
          <legend>{g}</legend>
          {FILTERS.filter((d) => d.group === g).map((d) => (
            <Control key={d.id} id={d.id} filter={filter} dirs={dirs} />
          ))}
        </fieldset>
      ))}
    </div>
  );
}
