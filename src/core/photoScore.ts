import type { GalleryFacts, GalleryItemLike } from './gallerySort';

// The photo score: one whole number per photo, used to rank (and later sort) a folder for the book.
// Made of lines anyone can read in the score's pop-up: how sharp the photo is next to the rest of the
// folder, its exposure, clipped highlights or shadows, cheap stand-ins for "interesting" (colour
// variety, a subject off-centre, people tagged), its size, being the weaker shot of a burst, and the
// person's own say: favourite +50, hidden −50, and their Up/Down nudges (photoinfo.json `scoreAdjust`).
// No upper or lower bound; a plain photo lands roughly between 30 and 90.

export interface ScoreLine {
  /** Short name of what this line counts, e.g. "Focus". */
  label: string;
  /** Points added (or taken away), whole. Lines worth 0 are left out. */
  points: number;
  /** Why, in a few words, e.g. "sharper than 80 % of this folder". */
  why: string;
}

export interface PhotoScore {
  total: number;
  /** Every non-zero line, in a fixed order. */
  lines: ScoreLine[];
  /** False until the folder scan has analysed the photo (its badge shows "–" meanwhile). */
  analysed: boolean;
}

/** Points per line, as the design sets them. */
export const SCORE_POINTS = {
  focus: 35,
  exposure: 20,
  clipping: 15,
  colour: 10,
  thirds: 5,
  perPerson: 5,
  people: 10,
  size: 10,
  burst: 10,
  favourite: 50,
  hidden: 50,
} as const;

/** Above this much of the photo blown to white or crushed to black (both together), clipping costs points. */
export const CLIPPING_FREE = 0.02;
/** Clipping at this fraction or more costs the most. */
const CLIPPING_WORST = 0.12;
/** A colour variety (0..1, see colourVariety) at or above this counts in full. */
const COLOUR_FULL = 0.3;
/** Megapixels for full size points. */
const FULL_MEGAPIXELS = 8;
/** Distance from the centre of a third's crossing, in fractions of the frame. */
const THIRDS_DISTANCE = Math.hypot(1 / 6, 1 / 6);
const MAX_RGB_DISTANCE = Math.hypot(255, 255, 255);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Spread of the 3 × 3 colour grid: mean distance of its nine colours from their mean, over the largest possible (0..1). */
export function colourVariety(grid: number[] | undefined): number {
  if (!grid || grid.length < 27) return 0;
  const mean = [0, 0, 0];
  for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) mean[c] += grid[i * 3 + c] / 9;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Math.hypot(grid[i * 3] - mean[0], grid[i * 3 + 1] - mean[1], grid[i * 3 + 2] - mean[2]);
  return clamp01(sum / 9 / MAX_RGB_DISTANCE);
}

/** The person's own nudges: photoinfo.json's `scoreAdjust`, a whole number (anything else counts as 0). */
export function scoreAdjustOf(info: { [field: string]: unknown }): number {
  const v = info.scoreAdjust;
  return typeof v === 'number' && Number.isInteger(v) ? v : 0;
}

/** "sharper than 80 % of this folder" for a percentile 0..1. */
const sharperThan = (p: number) => `sharper than ${Math.round(p * 100)} % of this folder`;

/**
 * Every photo's score, by path. Sharpness is ranked among the folder's analysed photos, so `items` is the
 * whole folder (not just what a filter shows). `facts` (galleryFacts) says which photos are the weaker
 * shots of a burst; without them (an empty map) no burst line is given.
 */
export function photoScores(items: GalleryItemLike[], facts: Map<string, GalleryFacts>): Map<string, PhotoScore> {
  const sharp = items.flatMap((i) => (i.analysis ? [i.analysis.sharpness] : [])).sort((a, b) => a - b);
  /** Share of the other analysed photos less sharp than this (0.5 when it is the only one). */
  const percentile = (v: number) => {
    if (sharp.length <= 1) return 0.5;
    let lo = 0;
    let hi = sharp.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sharp[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo / (sharp.length - 1);
  };

  const out = new Map<string, PhotoScore>();
  for (const i of items) {
    const lines: ScoreLine[] = [];
    const add = (label: string, points: number, why: string) => {
      const p = Math.round(points);
      if (p !== 0) lines.push({ label, points: p, why });
    };
    const a = i.analysis;
    if (a) {
      const p = percentile(a.sharpness);
      add('Focus', SCORE_POINTS.focus * p, sharperThan(p));
      const exposure = clamp01(1 - Math.abs(a.meanLuma - 0.48) * 2.2);
      add('Exposure', SCORE_POINTS.exposure * exposure, a.meanLuma < 0.3 ? 'on the dark side' : a.meanLuma > 0.68 ? 'on the bright side' : 'well exposed');
      const clipped = a.clippedHighlights + a.clippedShadows;
      if (clipped > CLIPPING_FREE) {
        const parts = [a.clippedHighlights > 0.005 && `${Math.round(a.clippedHighlights * 100)} % blown to white`, a.clippedShadows > 0.005 && `${Math.round(a.clippedShadows * 100)} % crushed to black`].filter(Boolean);
        add('Clipping', -SCORE_POINTS.clipping * clamp01((clipped - CLIPPING_FREE) / (CLIPPING_WORST - CLIPPING_FREE)), parts.join(', ') || 'clipped highlights or shadows');
      }
      const variety = colourVariety(a.colorGrid);
      add('Colour variety', SCORE_POINTS.colour * clamp01(variety / COLOUR_FULL), variety >= COLOUR_FULL * 0.66 ? 'many colours across the frame' : 'some colour across the frame');
      const d = Math.hypot(a.saliencyX - 0.5, a.saliencyY - 0.5);
      add('Composition', SCORE_POINTS.thirds * clamp01(1 - Math.abs(d - THIRDS_DISTANCE) / THIRDS_DISTANCE), 'subject near a third, not dead centre');
    }
    const people = Array.isArray(i.info.people) ? new Set(i.info.people.filter((p) => typeof p === 'string' && p !== '')).size : 0;
    if (people) add('People', Math.min(SCORE_POINTS.people, people * SCORE_POINTS.perPerson), `${people} ${people === 1 ? 'person' : 'people'} tagged`);
    const mp = (i.width * i.height) / 1e6;
    add('Size', SCORE_POINTS.size * clamp01(mp / FULL_MEGAPIXELS), `${mp >= 10 ? Math.round(mp) : mp.toFixed(1)} megapixels`);
    const f = facts.get(i.path);
    if (f && f.groupId !== null && !f.isKeeper) add('Burst', -SCORE_POINTS.burst, 'a similar shot in this burst is better');
    if (i.info.star === true) add('Favourite', SCORE_POINTS.favourite, 'starred');
    if (i.info.hidden === true) add('Hidden', -SCORE_POINTS.hidden, 'hidden');
    const nudges = scoreAdjustOf(i.info);
    if (nudges) add('Your nudges', nudges, `${nudges > 0 ? 'Up' : 'Down'} pressed ${Math.abs(nudges)} ${Math.abs(nudges) === 1 ? 'time' : 'times'} more`);
    out.set(i.path, { total: lines.reduce((t, l) => t + l.points, 0), lines, analysed: !!a });
  }
  return out;
}
