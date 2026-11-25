import { describe, expect, it } from 'vitest';
import { fromDateTimeLocal, locationToSave, normalisePeople, parseLocation, toDateTimeLocal } from '../src/core/galleryEdit';

describe('gallery edit rules', () => {
  it('normalises people: trimmed, no repeats ignoring case, no empties', () => {
    expect(normalisePeople(['  Ann ', 'ann', '', ' ', 'Bo', 'BO', 'Cy'])).toEqual(['Ann', 'Bo', 'Cy']);
    expect(normalisePeople([])).toEqual([]);
  });

  it('turns dates to and from datetime-local values', () => {
    expect(toDateTimeLocal('2025-08-12T17:40:00')).toBe('2025-08-12T17:40:00');
    expect(toDateTimeLocal('2025-08-12T17:40')).toBe('2025-08-12T17:40:00');
    expect(toDateTimeLocal('2025-08-12T17:40:00.000Z')).toBe('2025-08-12T17:40:00');
    expect(toDateTimeLocal(null)).toBe('');
    expect(toDateTimeLocal('nonsense')).toBe('');
    expect(fromDateTimeLocal('2025-08-12T17:40')).toBe('2025-08-12T17:40:00');
    expect(fromDateTimeLocal('2025-08-12T17:40:09')).toBe('2025-08-12T17:40:09');
    expect(fromDateTimeLocal('')).toBeNull();
    expect(fromDateTimeLocal('2025-02-31T10:00')).toBeNull();
  });

  it('validates the location fields', () => {
    expect(parseLocation('49.28', '-123.12', ' Vancouver ')).toEqual({ ok: true, location: { lat: 49.28, lon: -123.12, name: 'Vancouver' } });
    expect(parseLocation('0', '0', '')).toEqual({ ok: true, location: { lat: 0, lon: 0 } });
    expect(parseLocation('', ' ', '')).toEqual({ ok: true, location: null });
    expect(parseLocation('90', '180', '').ok).toBe(true);
    for (const [lat, lon] of [['91', '0'], ['-90.1', '0'], ['0', '181'], ['0', '-180.5'], ['abc', '0'], ['0', 'x']]) {
      expect(parseLocation(lat, lon, '').ok, `${lat},${lon}`).toBe(false);
    }
    expect(parseLocation('10', '', '')).toMatchObject({ ok: false, message: 'Enter both latitude and longitude.' });
    expect(parseLocation('', '', 'Canada').ok).toBe(false);
  });

  it('saves location fields left unsaved (the panel closed while typing) only when they changed and are valid', () => {
    const saved = { lat: '49.28', lon: '-123.12', name: '' };
    expect(locationToSave({ ...saved, name: 'Vancouver' }, saved, true)).toEqual({ location: { lat: 49.28, lon: -123.12, name: 'Vancouver' } });
    expect(locationToSave(saved, saved, true)).toBeNull();
    expect(locationToSave({ ...saved, lat: '95' }, saved, true)).toBeNull();
    expect(locationToSave({ ...saved, lon: '' }, saved, true)).toBeNull();
    // Emptied: deletes a saved location; with only the camera's GPS there is nothing to delete.
    expect(locationToSave({ lat: '', lon: '', name: '' }, saved, true)).toEqual({ location: null });
    expect(locationToSave({ lat: '', lon: '', name: '' }, saved, false)).toBeNull();
  });
});
