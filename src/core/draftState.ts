import type { PageSide } from './book';
import type { BookDocument, Element, Spread } from './model';

type Side = PageSide | 'spread';

/** Elements on one page of a spread (an element belongs to the page its centre lies on), or all of them for 'spread'. */
export function pageElements(doc: BookDocument, spread: Spread, side: Side): Element[] {
  if (side === 'spread') return spread.elements;
  const spine = doc.settings.trimWidthMm;
  return spread.elements.filter((e) => (e.xMm + e.widthMm / 2 < spine ? 'left' : 'right') === side);
}

const r = (n: number) => Math.round(n * 100) / 100;

function layoutOf(e: Element): unknown[] {
  const box = [r(e.xMm), r(e.yMm), r(e.widthMm), r(e.heightMm)];
  switch (e.type) {
    case 'image':
      return ['image', e.assetId, ...box, r(e.rotationDeg), [r(e.crop.cx), r(e.crop.cy), r(e.crop.zoom)], e.fit, e.mask ?? null];
    case 'text':
      // Auto-filled text (contents pages) changes by itself, so its words do not count.
      return ['text', e.auto ? null : e.text, ...box];
    case 'shape':
      return ['shape', ...box];
    case 'calendar':
      return ['calendar', ...box];
  }
}

/** FNV-1a (32-bit) over a string: small, stable and browser-safe. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A stable hash of one page's layout (photos, positions, sizes, crops, text words); style is left out. */
export function fingerprintPage(doc: BookDocument, spread: Spread, side: Side): string {
  const rows = pageElements(doc, spread, side).map((e) => JSON.stringify(layoutOf(e))).sort();
  return hash(JSON.stringify(rows));
}

/** Records the current fingerprint of each page the spread's layout covers. */
export function withFingerprints(doc: BookDocument, spread: Spread): Spread {
  const fingerprints: Partial<Record<Side, string>> = {};
  for (const side of ['left', 'right', 'spread'] as const) {
    if (spread.layout?.[side]) fingerprints[side] = fingerprintPage(doc, spread, side);
  }
  const provenance = spread.provenance ? { ...spread.provenance, fingerprints } : undefined;
  return provenance ? { ...spread, provenance } : spread;
}

/** True when the page was changed by hand since it was drafted (or was never drafted). */
export function isPageEdited(doc: BookDocument, spread: Spread, side: Side): boolean {
  if (spread.locked) return true;
  if (!spread.provenance) return true;
  const stored = spread.provenance.fingerprints?.[side];
  if (stored === undefined) return false;
  return stored !== fingerprintPage(doc, spread, side);
}

/** Photos on the spread that the generator did not place. */
export function handPlacedAssetIds(spread: Spread): Set<string> {
  const generated = new Set(spread.provenance?.assetIds ?? []);
  const out = new Set<string>();
  for (const e of spread.elements) if (e.type === 'image' && e.assetId && !generated.has(e.assetId)) out.add(e.assetId);
  return out;
}
