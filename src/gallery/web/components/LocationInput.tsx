import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { locationToSave, parseLocation } from '../../../core';

export interface LocationFields {
  lat: string;
  lon: string;
  name: string;
}

/**
 * Where a photo was taken: a country search (it sets the place's name), latitude, longitude and a
 * free-text name. Saved when focus leaves the group or Enter is pressed; a bad number shows a message
 * here and is not saved. What was typed stays in the fields whatever happens to the save.
 *
 * `initial` is what the photo has now (the camera's GPS or the saved override). When it changes the
 * fields start again from it. `hasOverride` says whether clearing the fields has anything to delete.
 */
export function LocationInput({
  initial,
  hasOverride,
  places,
  onSave,
}: {
  initial: LocationFields;
  hasOverride: boolean;
  places: { id: string; name: string }[];
  /** `null` removes the saved location. Resolves false when it could not be saved. */
  onSave(location: { lat: number; lon: number; name?: string } | null): Promise<boolean>;
}) {
  const key = JSON.stringify(initial);
  const [seen, setSeen] = useState(key);
  const [fields, setFields] = useState<LocationFields>(initial);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  /** The location last sent to be saved (JSON), until the photo's location changes. */
  const sent = useRef<string | null>(null);
  if (seen !== key) {
    setSeen(key);
    setFields(initial);
    setError('');
    sent.current = null;
  }

  const set = (patch: Partial<LocationFields>) => setFields((f) => ({ ...f, ...patch }));
  const matches = search.trim() ? places.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 6) : [];

  const commit = async (next: LocationFields) => {
    if (next.lat === initial.lat && next.lon === initial.lon && next.name === initial.name) {
      setError('');
      return;
    }
    const parsed = parseLocation(next.lat, next.lon, next.name);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError('');
    if (parsed.location === null && !hasOverride) {
      // Nothing saved to delete: go back to the camera's values.
      setFields(initial);
      return;
    }
    const sending = JSON.stringify(parsed.location);
    sent.current = sending;
    if (!(await onSave(parsed.location)) && sent.current === sending) sent.current = null;
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void commit(fields);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      void commit(fields);
    }
  };
  // The panel can close (another photo selected, a folder opened from outside) without the fields
  // being left first: valid changes they hold are saved then; a bad number is not.
  const latest = useRef({ fields, initial, hasOverride, onSave });
  latest.current = { fields, initial, hasOverride, onSave };
  useEffect(
    () => () => {
      const l = latest.current;
      const save = locationToSave(l.fields, l.initial, l.hasOverride);
      // Already on its way from a blur or Enter.
      if (save && JSON.stringify(save.location) !== sent.current) void l.onSave(save.location);
    },
    [],
  );

  const pick = (name: string) => {
    const next = { ...fields, name };
    setFields(next);
    setSearch('');
    void commit(next);
  };

  return (
    <div className="gallery-location" onBlur={onBlur} onKeyDown={onKeyDown}>
      <input type="text" value={search} placeholder="Search for a country…" aria-label="Search for a country" onChange={(e) => setSearch(e.target.value)} />
      {matches.length > 0 && (
        <div className="place-list">
          {matches.map((p) => (
            <button key={p.id} type="button" className="place" onClick={() => pick(p.name)}>
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span>Latitude</span>
          <input type="text" inputMode="decimal" value={fields.lat} aria-label="Latitude" aria-invalid={!!error} onChange={(e) => set({ lat: e.target.value })} />
        </label>
        <label className="field">
          <span>Longitude</span>
          <input type="text" inputMode="decimal" value={fields.lon} aria-label="Longitude" aria-invalid={!!error} onChange={(e) => set({ lon: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>Place name</span>
        <input type="text" value={fields.name} aria-label="Place name" onChange={(e) => set({ name: e.target.value })} />
      </label>
      {error && <p className="gallery-field-error" role="alert">{error}</p>}
    </div>
  );
}
