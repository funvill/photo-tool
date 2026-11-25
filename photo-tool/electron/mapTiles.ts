// The one exception to "the desktop app never uses the network": Photo Tool's Map tab shows
// OpenStreetMap tiles, once the user chose "Load maps". Only Photo Tool's window, only GETs of
// tiles, only while that answer is yes. Pure functions (plus the settings file), so they are
// unit-tested in photo-tool/tests/gallery-map.test.ts; main.ts wires them in.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OSM_TILE_ORIGIN } from '../core/galleryMap';
import { hostResolverRules, isAllowedRequest, type GuardOptions } from '../../shared/electron/netGuard';

export { OSM_TILE_ORIGIN };

const TILE_HOST = new URL(OSM_TILE_ORIGIN).hostname;
/** /zoom/column/row.png, plain digits only. */
const TILE_PATH = /^\/\d{1,2}\/\d{1,7}\/\d{1,7}\.png$/;

/** A GET of one tile from the tile server: https, the default port, no user name, no query, no fragment. */
export function isMapTileRequest(url: string, method: string): boolean {
  if (method !== 'GET' || url.includes('?') || url.includes('#')) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.hostname === TILE_HOST && u.port === '' && !u.username && !u.password && TILE_PATH.test(u.pathname);
}

/** The gallery window's guard: what any window may reach, plus tiles while the user allows maps. */
export function galleryRequestAllowed(url: string, method: string, opts: GuardOptions & { mapsAllowed: boolean }): boolean {
  return isAllowedRequest(url, opts) || (opts.mapsAllowed && isMapTileRequest(url, method));
}

/** OpenStreetMap's tile policy asks for an agent that names the program; nothing else is sent. */
export function mapTileUserAgent(version: string): string {
  return `PhotoTool/${version}`;
}

/**
 * The headers a tile request goes out with: Accept as Chromium wrote it (what image formats it takes)
 * and the program as User-Agent. Everything else (Accept-Language, the Sec-CH-UA client hints and other
 * Sec-* headers, Referer, Cookie, Origin) is dropped: it would tell the tile server more than it needs.
 */
export function mapTileRequestHeaders(headers: Record<string, string | string[]>, version: string): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'accept') kept[k] = v;
  kept['User-Agent'] = mapTileUserAgent(version);
  return kept;
}

/**
 * Photo Tool's host-resolver-rules: no name is ever looked up, except the tile server's. A tile request
 * still has to pass the guard first, so nothing is looked up before "Load maps".
 */
export function mapHostResolverRules(): string {
  return hostResolverRules([TILE_HOST]);
}

function readSettings(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The remembered answer to "Load maps from the internet?": null when it was never asked (or the file is unreadable). */
export function readMapConsent(file: string): boolean | null {
  const v = readSettings(file)?.mapsOnline;
  return typeof v === 'boolean' ? v : null;
}

/** Set one setting, keeping every other one in the file. Throws when it cannot be written. */
function writeSetting(file: string, key: string, value: unknown): void {
  const settings = { ...(readSettings(file) ?? {}), [key]: value };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Remember the answer, keeping any other setting in the file. Throws when it cannot be written. */
export function writeMapConsent(file: string, on: boolean): void {
  writeSetting(file, 'mapsOnline', on);
}

/** Where the gallery's photo edits go: into photoinfo.json ('info', the default) or into the photo file ('file'). */
export type EditTarget = 'info' | 'file';

/** The remembered edit target; anything but 'file' (including a missing or unreadable file) is 'info'. */
export function readEditTarget(file: string): EditTarget {
  return readSettings(file)?.editTarget === 'file' ? 'file' : 'info';
}

/** Remember the edit target, keeping any other setting in the file. Throws when it cannot be written. */
export function writeEditTarget(file: string, target: EditTarget): void {
  writeSetting(file, 'editTarget', target);
}
