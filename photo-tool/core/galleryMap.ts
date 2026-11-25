import type { GalleryItemLike } from './gallerySort';

// The gallery's Map tab, free of any UI: which photos get a marker, and the one address on the
// internet the gallery may use (only after the user chose "Load maps"; see photo-tool/electron/mapTiles.ts).

/** The OpenStreetMap tile server. The gallery window's request guard lets GETs of its tiles through, nothing else. */
export const OSM_TILE_ORIGIN = 'https://tile.openstreetmap.org';
/** One tile: zoom, column, row. */
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
/** The credit OpenStreetMap asks for wherever its map is shown. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const usable = (v: number | null, limit: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;

/**
 * The photos with a usable location (a finite latitude in −90…90 and longitude in −180…180), in the
 * order given, and how many others there are.
 */
export function locatedItems<T extends GalleryItemLike & { effectiveLon: number | null }>(items: T[]): { located: T[]; missing: number } {
  const located = items.filter((i) => usable(i.effectiveLat, 90) && usable(i.effectiveLon, 180));
  return { located, missing: items.length - located.length };
}

/** The note under the switch: "3 photos have no location" (empty when every photo has one). */
export function noLocationText(missing: number): string {
  if (missing <= 0) return '';
  return missing === 1 ? '1 photo has no location' : `${missing.toLocaleString('en-US')} photos have no location`;
}
