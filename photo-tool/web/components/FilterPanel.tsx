import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { FILTER_GROUPS, FILTERS, type PanelControl } from '../../core/galleryFilters';
import type { GalleryFilter } from '../../core/gallerySort';
import { useGallery } from '../store';

const set = (patch: Partial<GalleryFilter>) => useGallery.getState().setFilter(patch);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="gallery-filter-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * Draws one control the list of filters asks for. The switch covers every PanelControl kind (a new kind is a
 * compile error until it is drawn here), and every panel filter must bring its controls, so none is left out.
 */
function Control({ c, filter, dirs }: { c: PanelControl; filter: GalleryFilter; dirs: string[] }) {
  switch (c.kind) {
    case 'select':
      return (
        <Field label={c.label}>
          <select value={filter[c.key] ?? ''} onChange={(e) => set({ [c.key]: e.target.value || undefined })}>
            {c.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
      );
    case 'date':
      return (
        <Field label={c.label}>
          <input
            type="date"
            value={filter[c.key] ?? ''}
            max={c.key === 'from' ? filter.to : undefined}
            min={c.key === 'to' ? filter.from : undefined}
            onChange={(e) => set({ [c.key]: e.target.value || undefined })}
          />
        </Field>
      );
    case 'check':
      return (
        <label className="row gallery-check">
          <input type="checkbox" checked={filter[c.key] === true} onChange={(e) => set({ [c.key]: e.target.checked || undefined })} />
          {c.label}
        </label>
      );
    case 'folder':
      // Only when the open folder has subfolders.
      if (dirs.length < 2) return null;
      return (
        <Field label={c.label}>
          <select value={filter.relDir === undefined ? '' : `d:${filter.relDir}`} onChange={(e) => set({ relDir: e.target.value === '' ? undefined : e.target.value.slice(2) })}>
            <option value="">All folders</option>
            {dirs.map((d) => (
              <option key={d} value={`d:${d}`}>{d === '' ? 'Top folder' : d}</option>
            ))}
          </select>
        </Field>
      );
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
    default: {
      const unknown: never = c;
      return unknown;
    }
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
          {FILTERS.flatMap((d) =>
            d.group === g ? d.controls.map((c, i) => <Control key={`${d.id}:${i}`} c={c} filter={filter} dirs={dirs} />) : [],
          )}
        </fieldset>
      ))}
    </div>
  );
}
