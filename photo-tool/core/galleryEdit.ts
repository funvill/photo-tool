// The gallery's photo-info edit rules, free of any UI: what a typed value becomes in photoinfo.json.

/** Trimmed, empty entries dropped, repeated names (ignoring case) kept once, first spelling wins. */
export function normalisePeople(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

const LOCAL_DATE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/;

/** The value a `datetime-local` input (with step=1) shows for a stored date; '' when it is not a local date-time. */
export function toDateTimeLocal(iso: string | null | undefined): string {
  const m = typeof iso === 'string' ? LOCAL_DATE.exec(iso) : null;
  return m ? `${m[1]}T${m[2]}:${m[3] ?? '00'}` : '';
}

/** What to store for a `datetime-local` value: an ISO local date-time without a zone, or null when it is empty or invalid. */
export function fromDateTimeLocal(value: string): string | null {
  const m = LOCAL_DATE.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3] ?? '00'}`;
  // 2025-02-31 matches the pattern but is not a day.
  const d = new Date(`${iso}Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 19) !== iso ? null : iso;
}

export type LocationEdit =
  | { ok: true; location: { lat: number; lon: number; name?: string } | null }
  | { ok: false; message: string };

function coordinate(text: string, what: string, limit: number): { value: number } | { message: string } | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const value = Number(t);
  if (!Number.isFinite(value)) return { message: `${what} must be a number.` };
  if (Math.abs(value) > limit) return { message: `${what} must be between -${limit} and ${limit}.` };
  return { value };
}

/** Checks the location fields. All empty is a clear (`location: null`); latitude and longitude go together. */
export function parseLocation(latText: string, lonText: string, nameText: string): LocationEdit {
  const lat = coordinate(latText, 'Latitude', 90);
  const lon = coordinate(lonText, 'Longitude', 180);
  if (lat && 'message' in lat) return { ok: false, message: lat.message };
  if (lon && 'message' in lon) return { ok: false, message: lon.message };
  const name = nameText.trim();
  if (!lat && !lon) {
    return name ? { ok: false, message: 'Add a latitude and longitude for this place, or clear the name.' } : { ok: true, location: null };
  }
  if (!lat || !lon) return { ok: false, message: 'Enter both latitude and longitude.' };
  return { ok: true, location: { lat: lat.value, lon: lon.value, ...(name ? { name } : {}) } };
}

/**
 * What location fields left without a save (the panel closed while typing) save: nothing when they
 * are as `saved`, not valid, or emptied with no saved location to delete (`hasOverride` false);
 * else the location, null deleting it.
 */
export function locationToSave(
  fields: { lat: string; lon: string; name: string },
  saved: { lat: string; lon: string; name: string },
  hasOverride: boolean,
): { location: { lat: number; lon: number; name?: string } | null } | null {
  if (fields.lat === saved.lat && fields.lon === saved.lon && fields.name === saved.name) return null;
  const parsed = parseLocation(fields.lat, fields.lon, fields.name);
  if (!parsed.ok || (parsed.location === null && !hasOverride)) return null;
  return { location: parsed.location };
}
