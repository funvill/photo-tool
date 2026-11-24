import { cleanupSuggestions, type PhotoFlags } from './cleanup';
import type { PhotoAnalysis, PhotoAsset } from './model';

// The gallery's sorts and filters, free of any UI or server. The "facts" of a folder (interesting
// score, main colour, quality flags, bursts) are worked out once per list of photos; sorting and
// filtering then only read them.

export type GallerySortKey = 'date' | 'interesting' | 'colour' | 'name';

export interface GalleryFilter {
  starred?: 'yes' | 'no';
  /** Days as YYYY-MM-DD, both inclusive. A photo without a date never matches a range. */
  from?: string;
  to?: string;
  /** Blurry, dark, bright or low resolution (the clean-up rules). */
  lowQuality?: boolean;
  /** Photos that are in a group of two or more near-identical shots. */
  nearDuplicates?: boolean;
  orientation?: 'portrait' | 'landscape';
  hasLocation?: boolean;
  hasPeople?: boolean;
  /** Hidden photos are left out unless this is 'show' (everything) or 'only' (just the hidden ones). */
  hidden?: 'show' | 'only';
  /** The subfolder, as GalleryItem.relDir; '' is the top folder. */
  relDir?: string;
  /** Case-insensitive, over description and notes. */
  text?: string;
}

/** True when any filter is set (an empty search box or a cleared option does not count). */
export function isFilterActive(f: GalleryFilter): boolean {
  return !!(f.starred || f.from || f.to || f.lowQuality || f.nearDuplicates || f.orientation || f.hasLocation || f.hasPeople || f.hidden || f.relDir !== undefined || f.text?.trim());
}

export type ColourBucket = 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple' | 'pink' | 'neutral';

export interface GalleryFacts {
  /** 0..1, higher is more worth looking at. 0 until the photo is analysed. */
  interesting: number;
  colour: { bucket: ColourBucket; lightness: number };
  flags: PhotoFlags;
  /** Shared by the photos of one burst; null for a photo in no group. */
  groupId: string | null;
  /** The burst's suggested keeper; true too for a photo in no group (it is its own keeper). */
  isKeeper: boolean;
}

/** What these functions need of a gallery photo (GalleryItem satisfies it; src/core must not import the server). */
export interface GalleryItemLike {
  path: string;
  fileName: string;
  relDir: string;
  width: number;
  height: number;
  size: number;
  effectiveDate: string | null;
  effectiveLat: number | null;
  info: { star?: boolean; description?: unknown; notes?: unknown; people?: unknown; [extra: string]: unknown };
  analysis: PhotoAnalysis | null;
}

// Perceptual hue ranges in degrees, lower bound inclusive; red wraps through 0.
const HUE_RANGES: [ColourBucket, number][] = [
  ['orange', 15],
  ['yellow', 40],
  ['green', 70],
  ['cyan', 165],
  ['blue', 200],
  ['purple', 260],
  ['pink', 290],
  ['red', 345],
];
const BUCKET_ORDER = new Map<ColourBucket, number>((['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'neutral'] as const).map((b, i) => [b, i]));
const NEUTRAL_BELOW = 0.15;
const MAX_RGB_DISTANCE = Math.hypot(255, 255, 255);

/** Main colour of an sRGB (0–255) colour: its hue range (red, orange, yellow, green, cyan, blue, purple, pink), or neutral when grey. */
export function colourBucket(rgb: [number, number, number]): { bucket: ColourBucket; lightness: number } {
  const [r, g, b] = rgb.map((v) => Math.min(255, Math.max(0, v)) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const lightness = (max + min) / 2;
  const saturation = d === 0 ? 0 : d / (1 - Math.abs(2 * lightness - 1));
  if (saturation < NEUTRAL_BELOW) return { bucket: 'neutral', lightness };
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  let bucket: ColourBucket = 'red';
  for (const [name, from] of HUE_RANGES) if (hue >= from) bucket = name;
  if (hue < 15) bucket = 'red';
  return { bucket, lightness };
}

/** Spread of the 3 × 3 colour grid: mean distance of its nine colours from their mean, over the largest possible. */
function colourVariety(grid: number[] | undefined): number {
  if (!grid || grid.length < 27) return 0;
  const mean = [0, 0, 0];
  for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) mean[c] += grid[i * 3 + c] / 9;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Math.hypot(grid[i * 3] - mean[0], grid[i * 3 + 1] - mean[1], grid[i * 3 + 2] - mean[2]);
  return Math.min(1, Math.max(0, sum / 9 / MAX_RGB_DISTANCE));
}

const NO_FLAGS: PhotoFlags = { blurry: false, dark: false, bright: false, lowRes: false };

/** Everything the sorts and filters need to know about each photo, keyed by path. */
export function galleryFacts(items: GalleryItemLike[]): Map<string, GalleryFacts> {
  const assets: PhotoAsset[] = items.map((i) => ({
    id: i.path,
    fileName: i.fileName,
    format: '',
    fileSizeBytes: i.size,
    widthPx: i.width,
    heightPx: i.height,
    capturedAt: i.effectiveDate,
    gpsLat: null,
    gpsLon: null,
    rating: 0,
    favorite: i.info.star === true,
    tags: [],
    contentHash: i.path,
    exactDuplicateOf: null,
    analysis: i.analysis,
    excluded: false,
    missing: false,
  }));
  const clean = cleanupSuggestions(assets);

  const groupOf = new Map<string, { id: string; keeper: string }>();
  for (const g of clean.groups) for (const id of g.ids) groupOf.set(id, { id: g.ids[0], keeper: g.keeperId });

  // Quality is judged against this folder: stretch the analysed photos' scores over 0..1 (all equal: 0.5).
  const scores = [...clean.quality.values()];
  const lo = scores.length ? Math.min(...scores) : 0;
  const hi = scores.length ? Math.max(...scores) : 0;

  const out = new Map<string, GalleryFacts>();
  for (const i of items) {
    const group = groupOf.get(i.path) ?? null;
    const isKeeper = !group || group.keeper === i.path;
    const flags = clean.flags.get(i.path) ?? NO_FLAGS;
    const rawQuality = clean.quality.get(i.path);
    let interesting = 0;
    if (rawQuality !== undefined && i.analysis) {
      const quality = hi > lo ? (rawQuality - lo) / (hi - lo) : 0.5;
      const exposureOk = flags.dark || flags.bright ? 0 : 1;
      interesting = 0.45 * quality + 0.2 * colourVariety(i.analysis.colorGrid) + 0.2 * (isKeeper ? 1 : 0) + 0.15 * exposureOk;
    }
    const avg = i.analysis?.avgColor;
    out.set(i.path, {
      interesting,
      colour: avg ? colourBucket(avg) : { bucket: 'neutral', lightness: 0 },
      flags,
      groupId: group?.id ?? null,
      isKeeper,
    });
  }
  return out;
}

const byName = (a: GalleryItemLike, b: GalleryItemLike) =>
  a.fileName.localeCompare(b.fileName, undefined, { numeric: true }) || a.relDir.localeCompare(b.relDir) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A sorted copy. Date: oldest first, undated last. Interesting: best first. Colour: red ... pink, neutral, then by lightness. Photos not analysed yet come last in the last two. */
export function sortItems<T extends GalleryItemLike>(items: T[], key: GallerySortKey, facts: Map<string, GalleryFacts>): T[] {
  const copy = [...items];
  if (key === 'name') return copy.sort(byName);
  if (key === 'date') {
    const time = new Map(copy.map((i) => [i.path, i.effectiveDate ? Date.parse(i.effectiveDate) : NaN]));
    return copy.sort((a, b) => {
      const ta = time.get(a.path)!;
      const tb = time.get(b.path)!;
      if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
      return (Number.isNaN(ta) ? 0 : ta - tb) || byName(a, b);
    });
  }
  const ready = (i: T) => (key === 'colour' ? !!i.analysis?.avgColor : !!i.analysis);
  return copy.sort((a, b) => {
    if (ready(a) !== ready(b)) return ready(a) ? -1 : 1;
    const fa = facts.get(a.path);
    const fb = facts.get(b.path);
    if (fa && fb) {
      const d =
        key === 'interesting'
          ? fb.interesting - fa.interesting
          : BUCKET_ORDER.get(fa.colour.bucket)! - BUCKET_ORDER.get(fb.colour.bucket)! || fa.colour.lightness - fb.colour.lightness;
      if (d) return d;
    }
    return byName(a, b);
  });
}

const day = (date: string | null) => (date ? date.slice(0, 10) : null);

/** The photos that pass every filter that is set. Keeps the order. */
export function filterItems<T extends GalleryItemLike>(items: T[], f: GalleryFilter, facts: Map<string, GalleryFacts>): T[] {
  const text = f.text?.trim().toLowerCase();
  return items.filter((i) => {
    const isHidden = i.info.hidden === true;
    if (f.hidden === 'only' ? !isHidden : isHidden && f.hidden !== 'show') return false;
    const star = i.info.star === true;
    if (f.starred === 'yes' && !star) return false;
    if (f.starred === 'no' && star) return false;
    if (f.from || f.to) {
      const d = day(i.effectiveDate);
      if (!d || (f.from && d < f.from) || (f.to && d > f.to)) return false;
    }
    if (f.lowQuality) {
      const fl = facts.get(i.path)?.flags;
      if (!fl || !(fl.blurry || fl.dark || fl.bright || fl.lowRes)) return false;
    }
    if (f.nearDuplicates && !facts.get(i.path)?.groupId) return false;
    if (f.orientation === 'portrait' && !(i.height > i.width)) return false;
    if (f.orientation === 'landscape' && !(i.width > i.height)) return false;
    if (f.hasLocation && i.effectiveLat === null) return false;
    if (f.hasPeople && !(Array.isArray(i.info.people) && i.info.people.length > 0)) return false;
    if (f.relDir !== undefined && i.relDir !== f.relDir) return false;
    if (text) {
      const hay = [i.info.description, i.info.notes].filter((v): v is string => typeof v === 'string').join('\n').toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}
