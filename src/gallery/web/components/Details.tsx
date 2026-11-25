import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  aspectRatio,
  formatAperture,
  formatBias,
  formatFocal,
  formatShutter,
  fromDateTimeLocal,
  megapixels,
  normalisePeople,
  toDateTimeLocal,
} from '../../../core';
import { Icon } from '../../../web/components/Icon';
import { formatSize, formatTaken } from '../../../web/components/HoverPreview';
import { galleryApi, type GalleryItem } from '../api';
import { useGallery } from '../store';
import { Histogram } from './Histogram';
import { LocationInput } from './LocationInput';
import { PeopleInput } from './PeopleInput';
import { ScoreCard } from './ScoreCard';
import { Section } from './Section';
import { WhatsInIt } from './WhatsInIt';

/** The country list is the same for every photo: fetched once. */
let allPlaces: Promise<{ id: string; name: string }[]> | null = null;

interface Draft {
  value: string;
  set(v: string): void;
  /** The value last sent to be saved and not confirmed yet, so it is not sent twice. */
  sent: { current: string | null };
}

/**
 * A draft of a text field that follows the saved value `source` while it holds nothing unsaved: the
 * reply to a save, or another program's change, never overwrites what is still being typed.
 */
function useDraft(source: string): Draft {
  const [value, set] = useState(source);
  const [seen, setSeen] = useState(source);
  const sent = useRef<string | null>(null);
  if (seen !== source) {
    setSeen(source);
    if (value === seen || value === sent.current) set(source);
    if (source === sent.current) sent.current = null;
  }
  return { value, set, sent };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gallery-fact">
      <span className="muted small">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Field({ label, saved, children }: { label: string; saved: boolean; children: ReactNode }) {
  return (
    <div className="gallery-edit">
      <div className="gallery-edit-label">
        <span>{label}</span>
        {saved && <span className="gallery-saved" role="status">Saved</span>}
      </div>
      {children}
    </div>
  );
}

/** The panel beside the grid for the selected photo: what is known about it, and its editable info. */
export function Details() {
  const item = useGallery((s) => s.items.find((i) => i.path === s.selected));
  if (!item) return null;
  // Everything in the panel starts again for another photo.
  return <DetailsFor key={item.path} item={item} />;
}

function DetailsFor({ item }: { item: GalleryItem }) {
  const job = useGallery((s) => s.job);
  const [flashed, setFlashed] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const [places, setPlaces] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [country, setCountry] = useState<string | null>(null);
  const [dateError, setDateError] = useState('');

  const info = item.info;
  const savedPeople = Array.isArray(info.people) ? info.people.filter((p): p is string => typeof p === 'string') : [];
  const overridden = typeof info.date === 'string';
  const hasLocation = item.effectiveLat !== null && item.effectiveLon !== null;

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  useEffect(() => {
    let live = true;
    void (allPlaces ??= galleryApi.places()).then((p) => live && setPlaces(p)).catch(() => undefined);
    return () => void (live = false);
  }, []);
  useEffect(() => {
    let live = true;
    if (job) void galleryApi.people(job).then((p) => live && setPeople(p)).catch(() => undefined);
    return () => void (live = false);
  }, [job, savedPeople.join('\n')]);
  useEffect(() => {
    setCountry(null);
    if (item.effectiveLat === null || item.effectiveLon === null) return;
    let live = true;
    galleryApi.suggestPlaces([[item.effectiveLon, item.effectiveLat]]).then((s) => live && setCountry(s[0]?.name ?? null)).catch(() => undefined);
    return () => void (live = false);
  }, [item.effectiveLat, item.effectiveLon]);

  /** Saves one field; "Saved" shows beside it for a moment. A failure is toasted by the store and the field is left as typed. */
  const save = async (field: string, patch: Record<string, unknown>): Promise<boolean> => {
    const ok = await useGallery.getState().saveInfo(item.path, patch);
    if (ok) {
      setFlashed(field);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashed(null), 1800);
    }
    return ok;
  };

  const [peopleDraft, setPeopleDraft] = useState(savedPeople);
  const [peopleSeen, setPeopleSeen] = useState(JSON.stringify(savedPeople));
  if (peopleSeen !== JSON.stringify(savedPeople)) {
    setPeopleSeen(JSON.stringify(savedPeople));
    setPeopleDraft(savedPeople);
  }
  const changePeople = (next: string[]) => {
    const clean = normalisePeople(next);
    setPeopleDraft(clean);
    if (JSON.stringify(clean) !== JSON.stringify(savedPeople)) void save('people', { people: clean.length ? clean : null });
  };

  const description = useDraft(typeof info.description === 'string' ? info.description : '');
  const notes = useDraft(typeof info.notes === 'string' ? info.notes : '');
  const saveText = (field: 'description' | 'notes', draft: Draft) => {
    const value = draft.value;
    const current = typeof info[field] === 'string' ? (info[field] as string) : '';
    if (value === current || value === draft.sent.current) return;
    draft.sent.current = value;
    void save(field, { [field]: value.trim() === '' ? null : value }).then((ok) => {
      if (!ok && draft.sent.current === value) draft.sent.current = null;
    });
  };

  // An uncontrolled input: a half-typed date reads as '' and a controlled input would wipe it.
  const shownDate = toDateTimeLocal(item.effectiveDate);
  // The input drops ":00" seconds ("09:05", not "09:05:00"): that is still the date shown, not an edit.
  const unchangedDate = (value: string) => value === shownDate || (value !== '' && fromDateTimeLocal(value) === shownDate);
  const commitDate = (el: HTMLInputElement) => {
    if (unchangedDate(el.value)) {
      setDateError('');
      return;
    }
    if (el.value === '') {
      if (el.validity.badInput) {
        setDateError('Finish the date and time.');
      } else {
        setDateError('');
        if (overridden) void save('date', { date: null });
        else el.value = shownDate;
      }
      return;
    }
    const iso = fromDateTimeLocal(el.value);
    if (!iso) {
      setDateError('That is not a valid date and time.');
      return;
    }
    setDateError('');
    dateSent.current = iso;
    void save('date', { date: iso });
  };
  const dateSent = useRef<string | null>(null);
  // Kept after the input goes, so a date being typed can still be read when the panel closes.
  const dateInput = useRef<HTMLInputElement | null>(null);

  // Another photo selected (Shift-click, closing the viewer) or the panel closed does not always blur
  // the field being typed in first: whatever a field holds unsaved is saved as the panel goes.
  const flush = useRef<() => void>(() => undefined);
  flush.current = () => {
    saveText('description', description);
    saveText('notes', notes);
    const el = dateInput.current;
    const iso = el && !unchangedDate(el.value) && el.value !== '' ? fromDateTimeLocal(el.value) : null;
    if (iso && iso !== info.date && iso !== dateSent.current) void save('date', { date: iso });
  };
  useEffect(() => () => flush.current(), []);

  const locationFields = {
    lat: item.effectiveLat === null ? '' : String(item.effectiveLat),
    lon: item.effectiveLon === null ? '' : String(item.effectiveLon),
    name: typeof info.location?.name === 'string' ? info.location.name : '',
  };

  const exif = item.exif ?? {};
  const cameraRows: [string, string][] = [];
  if (item.camera) cameraRows.push(['Camera', item.camera]);
  if (exif.lens) cameraRows.push(['Lens', exif.lens]);
  if (exif.focalLength !== undefined) cameraRows.push(['Focal length', formatFocal(exif.focalLength, exif.focalLength35)]);
  if (exif.aperture !== undefined) cameraRows.push(['Aperture', formatAperture(exif.aperture)]);
  if (exif.exposureTime !== undefined) cameraRows.push(['Shutter', formatShutter(exif.exposureTime)]);
  if (exif.iso !== undefined) cameraRows.push(['ISO', String(exif.iso)]);
  if (exif.exposureBias !== undefined) cameraRows.push(['Exposure', formatBias(exif.exposureBias)]);
  if (exif.flash !== undefined) cameraRows.push(['Flash', exif.flash ? 'Fired' : 'Did not fire']);

  return (
    <aside className="gallery-details" aria-label="Photo details">
      <div className="gallery-details-head">
        <strong className="ellipsis" title={item.path}>{item.fileName}</strong>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={() => useGallery.getState().select(null)}>
          <Icon name="x" />
        </button>
      </div>
      <div className="gallery-details-body">
        <ScoreCard path={item.path} />
        {item.infoSource === 'fallback' && (
          <p className="gallery-note small">This folder can&apos;t be written; info is kept in Photobook&apos;s own folder</p>
        )}
        {item.infoError && <p className="gallery-note gallery-note-error small">{item.infoError}</p>}

        <Section id="photo" title="Photo">
          <div className="gallery-facts">
            <Row label="Taken">
              {item.effectiveDate ? formatTaken(item.effectiveDate) : 'Unknown'}
              {overridden && <span className="badge gallery-changed" title="The date was changed here; the camera's is kept in the photo">changed</span>}
            </Row>
            <Row label="Size">{item.width} × {item.height} px · {formatSize(item.size)}</Row>
            <Row label="Resolution">{megapixels(item.width, item.height)} · {aspectRatio(item.width, item.height)}</Row>
            <Row label="Shape">{item.width === item.height ? 'Square' : item.width > item.height ? 'Landscape' : 'Portrait'}</Row>
            <Row label="Format">{item.format && item.format !== 'unknown' ? item.format.toUpperCase() : 'Unknown'}</Row>
            {item.relDir && <Row label="Folder">{item.relDir}</Row>}
          </div>
        </Section>

        <Section id="whatsinit" title="What's in it">
          <WhatsInIt item={item} />
        </Section>

        <Section id="camera" title="Camera">
          {cameraRows.length ? (
            <div className="gallery-facts">
              {cameraRows.map(([label, value]) => (
                <Row key={label} label={label}>{value}</Row>
              ))}
            </div>
          ) : (
            <p className="muted small">No camera details in this file</p>
          )}
        </Section>

        <Section id="histogram" title="Histogram" lazy>
          <Histogram item={item} />
        </Section>

        <Section id="place" title="Place">
          {hasLocation && (
            <div className="gallery-facts">
              <Row label="Country">{country ?? '…'}</Row>
              <Row label="Coordinates">{item.effectiveLat!.toFixed(5)}, {item.effectiveLon!.toFixed(5)}</Row>
            </div>
          )}
          <Field label="Location" saved={flashed === 'location'}>
            <LocationInput initial={locationFields} hasOverride={!!info.location} places={places} onSave={(location) => save('location', { location })} />
          </Field>
        </Section>

        <Section id="people" title="People">
          <Field label="People" saved={flashed === 'people'}>
            <PeopleInput value={peopleDraft} suggestions={people} onChange={changePeople} />
          </Field>
        </Section>

        <Section id="date" title="Date and time">
          <Field label="Date and time" saved={flashed === 'date'}>
            <input
              key={shownDate}
              ref={(el) => {
                if (el) dateInput.current = el;
              }}
              type="datetime-local"
              step={1}
              defaultValue={shownDate}
              aria-label="Date and time taken"
              onBlur={(e) => commitDate(e.currentTarget)}
              onKeyDown={(e) => e.key === 'Enter' && commitDate(e.currentTarget)}
            />
            {overridden && (
              <button type="button" className="link small" onClick={() => void save('date', { date: null })}>
                Use the camera&apos;s date
              </button>
            )}
            {dateError && <p className="gallery-field-error" role="alert">{dateError}</p>}
          </Field>
        </Section>

        <Section id="notes" title="Description and notes">
          <Field label="Description" saved={flashed === 'description'}>
            <input
              type="text"
              value={description.value}
              aria-label="Description"
              onChange={(e) => description.set(e.target.value)}
              onBlur={() => saveText('description', description)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </Field>

          <Field label="Notes" saved={flashed === 'notes'}>
            <textarea rows={4} value={notes.value} aria-label="Notes" onChange={(e) => notes.set(e.target.value)} onBlur={() => saveText('notes', notes)} />
          </Field>
        </Section>
      </div>
    </aside>
  );
}
