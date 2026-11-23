import type { PageSide } from './book';
import { reconcileCover } from './cover';
import { aspectOf, chronological, dateRangeOf, dayKey, timeOf } from './curation';
import { fingerprintPage, isPageEdited, pageElements, withFingerprints } from './draftState';
import { curatePool, distributeCounts, layoutAutoPage, layoutHeroSpread } from './generator';
import { defaultCrop } from './geometry';
import { isCutout, keepSubjectOutOfGutter, layoutPage, templateOrThrow } from './layout';
import type { BookDocument, Element, GenerationSettings, ImageElement, PhotoAsset, Spread } from './model';
import { mulberry32, newId, type Rng } from './random';
import { stylePreset, type StylePreset } from './styles';

// Updating an existing auto-draft from changed stars. Pages the user edited by hand are never
// re-laid (an unstarred photo there leaves an empty frame), photos placed by hand are never
// removed, and pages nothing happened to stay exactly as they were.

type Side = PageSide | 'spread';

export interface UpdateReport {
  added: string[];
  removed: string[];
  replaced: { removed: string; added: string; spreadIndex: number }[];
  relaidPages: { spreadIndex: number; side: Side }[];
  addedSpreads: number[];
  removedSpreads: number;
  emptiedFrames: { spreadIndex: number; elementId: string }[];
  pages: number;
  notes: string[];
}

/** The usable starred photos, or every usable photo (`fellBack`) when none is starred. */
export function starredPool(assets: PhotoAsset[]): { photos: PhotoAsset[]; fellBack: boolean } {
  const { pool } = curatePool(assets);
  const starred = pool.filter((a) => a.favorite);
  return starred.length ? { photos: starred, fellBack: false } : { photos: pool, fellBack: true };
}

/** Landscape at 1.1 or wider, portrait at 0.9 or narrower, otherwise square. */
const orientation = (a: PhotoAsset) => (aspectOf(a) >= 1.1 ? 'l' : aspectOf(a) <= 0.9 ? 'p' : 's');

interface Ctx {
  doc: BookDocument;
  preset: StylePreset;
  rng: Rng;
  explore: boolean;
  seed: number;
  captions: boolean;
  byId: Map<string, PhotoAsset>;
  /** Subtitle for a re-laid title page. */
  subtitle: string;
}

function makeCtx(doc: BookDocument, assets: PhotoAsset[], settings: GenerationSettings): Ctx {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const inBook = doc.spreads.flatMap((s) => imagesOf(s).map((e) => byId.get(e.assetId!)).filter((a): a is PhotoAsset => !!a));
  return {
    doc,
    preset: stylePreset(settings.stylePresetId),
    rng: mulberry32(settings.seed),
    explore: settings.seed !== 1,
    seed: settings.seed,
    captions: settings.includeCaptions && doc.style.captionMode === 'date',
    byId,
    subtitle: doc.subtitle || dateRangeOf(inBook),
  };
}

const imagesOf = (s: Spread) => s.elements.filter((e): e is ImageElement => e.type === 'image' && !!e.assetId);

/** The drafted pages of a spread: the panorama, or each page with a layout. */
const draftedSides = (s: Spread): Side[] => (s.layout?.spread ? ['spread'] : (['left', 'right'] as const).filter((k) => s.layout?.[k]));

/** Photos on a page that a re-layout may move (locked frames stay put), oldest first; null if one is not in the library. */
function pagePhotos(ctx: Ctx, s: Spread, side: Side): PhotoAsset[] | null {
  const out: PhotoAsset[] = [];
  for (const e of pageElements(ctx.doc, s, side)) {
    if (e.type !== 'image' || !e.assetId || e.locked) continue;
    const a = ctx.byId.get(e.assetId);
    if (!a) return null;
    out.push(a);
  }
  return chronological(out);
}

/** Elements for one page laid out afresh (title page, chapter page, or photos). */
function layoutSide(ctx: Ctx, s: Spread, index: number, side: PageSide, photos: PhotoAsset[], avoid: string[]): { elements: Element[]; layoutId: string } {
  const { doc } = ctx;
  if (index === 0 && side === 'right' && photos.length <= 1) {
    const t = templateOrThrow(photos.length ? 'title-photo' : 'title-text');
    return { elements: layoutPage(doc, t, 'right', photos, { title: doc.title, subtitle: ctx.subtitle }), layoutId: t.id };
  }
  if (!photos.length) {
    const t = templateOrThrow('chapter-divider');
    const heading = doc.chapters.find((c) => c.id === s.chapterId)?.title ?? doc.title;
    return { elements: layoutPage(doc, t, side, [], { heading, subtitle: '' }), layoutId: t.id };
  }
  const caption = ctx.captions ? dateRangeOf(photos) || undefined : undefined;
  return layoutAutoPage(doc, ctx.preset, photos, side, { rng: ctx.rng, avoid, explore: ctx.explore, seed: ctx.seed, caption });
}

/** Both pages of a spread laid out afresh from `photos`, like a generated pair. */
function layoutPair(ctx: Ctx, s: Spread, index: number, photos: PhotoAsset[], prev: string): { elements: Element[]; layout: Spread['layout'] } {
  const [l, r] = distributeCounts(photos.length, 2, ctx.preset.maxPerPage, ctx.rng, ctx.explore);
  const left = layoutSide(ctx, s, index, 'left', photos.slice(0, l), [prev, '']);
  const right = layoutSide(ctx, s, index, 'right', photos.slice(l, l + r), [left.layoutId, left.layoutId]);
  return { elements: [...left.elements, ...right.elements], layout: { left: left.layoutId, right: right.layoutId } };
}

/** Template of the page before this one, so a re-layout does not repeat it. */
function prevLayout(spreads: Spread[], index: number, side: Side): string {
  const s = spreads[index];
  if (side === 'right') return s.layout?.left ?? '';
  const before = spreads[index - 1];
  return before?.layout?.right ?? before?.layout?.spread ?? '';
}

/**
 * New fingerprints for the pages that were auto before this change (`autoSides`) and any page
 * the new layout adds; pages edited by hand keep their old fingerprint so they stay edited.
 */
function refingerprint(doc: BookDocument, s: Spread, autoSides: Side[], oldLayout: Spread['layout']): Spread {
  if (!s.provenance) return s;
  const fps = { ...(s.provenance.fingerprints ?? {}) };
  for (const k of ['left', 'right', 'spread'] as const) {
    if (!s.layout?.[k]) delete fps[k];
    else if (autoSides.includes(k) || !oldLayout?.[k]) fps[k] = fingerprintPage(doc, s, k);
  }
  return { ...s, provenance: { ...s.provenance, fingerprints: fps } };
}

/** Lay out one page of a spread (or the whole spread) afresh from `photos`, keeping locked elements and the other page. */
function relaySpreadSide(ctx: Ctx, spreads: Spread[], index: number, side: Side, photos: PhotoAsset[]): Spread {
  const s = spreads[index];
  const last = index === spreads.length - 1;
  const affected = pageElements(ctx.doc, s, side);
  const affectedIds = new Set(affected.map((e) => e.id));
  const kept = s.elements.filter((e) => !affectedIds.has(e.id));
  const locked = affected.filter((e) => e.locked);
  let elements: Element[];
  let layout: Spread['layout'];
  if (side === 'spread') {
    if (photos.length === 1 && s.layout?.spread && index > 0 && !last) {
      elements = layoutHeroSpread(ctx.doc, photos[0]);
      layout = { spread: 'panorama' };
    } else if (index === 0 || last) {
      const only: PageSide = index === 0 ? 'right' : 'left';
      const page = layoutSide(ctx, s, index, only, photos, [prevLayout(spreads, index, only)]);
      elements = page.elements;
      layout = { [only]: page.layoutId };
    } else ({ elements, layout } = layoutPair(ctx, s, index, photos, prevLayout(spreads, index, 'left')));
  } else {
    const facing = side === 'right' ? s.layout?.left ?? '' : '';
    const page = layoutSide(ctx, s, index, side, photos, [prevLayout(spreads, index, side), facing]);
    elements = page.elements;
    const { spread: _whole, ...rest } = s.layout ?? {};
    layout = { ...rest, [side]: page.layoutId };
  }
  return { ...s, layout, elements: [...kept, ...elements, ...locked] };
}

/**
 * Lay out the photos currently on one page (or the whole spread) afresh, as a draft would.
 * The page counts as auto-placed again: its photos join the draft's photos and get new fingerprints.
 */
export function relayPage(doc: BookDocument, assets: PhotoAsset[], spreadIndex: number, side: Side, settings: GenerationSettings): BookDocument {
  const s = doc.spreads[spreadIndex];
  if (!s) throw new Error('Spread not found');
  if (s.locked) throw new Error('Spread is locked — unlock it to re-lay its pages');
  const ctx = makeCtx(doc, assets, settings);
  const whole: Side = s.layout?.spread ? 'spread' : side;
  const photos = pagePhotos(ctx, s, whole);
  if (!photos) throw new Error('A photo on this page is no longer in the library');
  const autoBefore = draftedSides(s).filter((k) => k !== whole && !isPageEdited(doc, s, k));
  const laid = relaySpreadSide(ctx, doc.spreads, spreadIndex, whole, photos);
  const now = new Date().toISOString();
  const prov = s.provenance ?? { generatedAt: now, seed: settings.seed, assetIds: [] };
  const assetIds = [...new Set([...prov.assetIds, ...photos.map((a) => a.id)])];
  const relaid = whole === 'spread' ? (['left', 'right', 'spread'] as Side[]) : [whole];
  const next = refingerprint(doc, { ...laid, provenance: { ...prov, generatedAt: now, assetIds } }, [...autoBefore, ...relaid], s.layout);
  return { ...doc, spreads: doc.spreads.map((x, i) => (i === spreadIndex ? next : x)) };
}

// ---- updateDraft

interface Page {
  side: Side;
  auto: boolean;
  /** Photos the page will hold, oldest first. */
  photos: PhotoAsset[];
  title: boolean;
  /** Lost a photo that was not replaced. */
  removal: boolean;
  /** Gained a photo. */
  addition: boolean;
}

interface Work {
  spread: Spread;
  isNew: boolean;
  pages: Page[];
  assetIds: Set<string>;
  /** The spread an overflow spread was added after. */
  overflowOf?: Work;
  changed: boolean;
  /** A frame got a replacement photo on these (auto) pages. */
  replacedOn: Set<Side>;
  replaced: { removed: string; added: string }[];
  emptied: string[];
  hadPhotos: boolean;
}

const range = (p: Page) => {
  const ts = p.photos.map(timeOf).filter((t) => !Number.isNaN(t));
  return ts.length ? { lo: Math.min(...ts), hi: Math.max(...ts) } : null;
};

function insertChronological(list: PhotoAsset[], a: PhotoAsset) {
  const next = chronological([...list, a]);
  list.splice(0, list.length, ...next);
}

export function updateDraft(doc: BookDocument, assets: PhotoAsset[], settings: GenerationSettings): { doc: BookDocument; report: UpdateReport } {
  const ctx = makeCtx(doc, assets, settings);
  const cap = Math.min(7, ctx.preset.maxPerPage);
  const { photos: wantedPhotos, fellBack } = starredPool(assets);
  const wanted = new Set(wantedPhotos.map((a) => a.id));
  const placed = new Set(doc.spreads.flatMap((s) => imagesOf(s).map((e) => e.assetId!)));
  const removedIds: string[] = [];

  // ---- the book as pages
  const works: Work[] = doc.spreads.map((s, i) => {
    const pages: Page[] = draftedSides(s).map((side) => {
      const photos = pagePhotos(ctx, s, side);
      const auto = !s.locked && !isPageEdited(doc, s, side) && photos !== null;
      return { side, auto, photos: photos ?? [], title: i === 0 && side === 'right', removal: false, addition: false };
    });
    return {
      spread: s, isNew: false, pages, assetIds: new Set(s.provenance?.assetIds ?? []), changed: false,
      replacedOn: new Set(), replaced: [], emptied: [], hadPhotos: imagesOf(s).length > 0,
    };
  });

  // ---- removals: drafted photos that are no longer starred
  const removals: { w: Work; page: Page; el: ImageElement; asset: PhotoAsset }[] = [];
  for (const w of works) {
    if (w.spread.locked) continue;
    for (const el of imagesOf(w.spread)) {
      const id = el.assetId!;
      if (wanted.has(id) || !w.assetIds.has(id) || el.locked) continue;
      if (!removedIds.includes(id)) removedIds.push(id);
      const side: Side = w.spread.layout?.spread ? 'spread' : el.xMm + el.widthMm / 2 < doc.settings.trimWidthMm ? 'left' : 'right';
      const page = w.pages.find((p) => p.side === side);
      const asset = ctx.byId.get(id);
      if (page?.auto && asset) removals.push({ w, page, el, asset });
      else {
        // Hand work wins: the frame is left empty for the user to fill or remove.
        w.spread = { ...w.spread, elements: w.spread.elements.map((e) => (e.id === el.id ? { ...el, assetId: null } : e)) };
        w.assetIds.delete(id);
        w.emptied.push(el.id);
        w.changed = true;
      }
    }
  }

  // ---- additions, and same-day replacements
  const added = chronological(wantedPhotos.filter((a) => !placed.has(a.id)));
  const pending = [...added];
  for (const { w, page, el, asset } of removals) {
    w.assetIds.delete(asset.id);
    page.photos = page.photos.filter((a) => a.id !== asset.id);
    w.changed = true;
    const day = dayKey(asset);
    const k = pending.findIndex((a) => day !== null && dayKey(a) === day && orientation(a) === orientation(asset));
    if (k < 0) {
      page.removal = true;
      continue;
    }
    const [a] = pending.splice(k, 1);
    let frame: ImageElement = { ...el, assetId: a.id, crop: defaultCrop(a), fit: isCutout(a) ? 'contain' : 'cover', borderMm: isCutout(a) ? 0 : el.borderMm };
    delete frame.adjust;
    frame = keepSubjectOutOfGutter(frame, a, doc);
    w.spread = { ...w.spread, elements: w.spread.elements.map((e) => (e.id === el.id ? frame : e)) };
    w.assetIds.add(a.id);
    insertChronological(page.photos, a);
    w.replacedOn.add(page.side);
    w.replaced.push({ removed: asset.id, added: a.id });
  }

  const targets = () => works.flatMap((w) => w.pages.filter((p) => p.auto && !p.title && p.side !== 'spread' && p.photos.length > 0).map((p) => ({ w, p })));
  const newWork = (after: Work, chapterId: string | undefined): Work => {
    const spread: Spread = { id: newId(), locked: false, chapterId, layout: {}, elements: [] };
    const blank = (side: PageSide): Page => ({ side, auto: true, photos: [], title: false, removal: false, addition: true });
    return { spread, isNew: true, pages: [blank('left'), blank('right')], assetIds: new Set(), overflowOf: after, changed: true, replacedOn: new Set(), replaced: [], emptied: [], hadPhotos: false };
  };
  for (const a of pending) {
    const all = targets();
    let target: { w: Work; p: Page } | undefined;
    const t = timeOf(a);
    if (Number.isNaN(t)) target = all[all.length - 1];
    else {
      target = all.find(({ p }) => {
        const r = range(p);
        return r !== null && r.lo <= t && t <= r.hi;
      });
      if (!target) {
        let best = -Infinity;
        for (const c of all) {
          const r = range(c.p);
          if (r && r.hi < t && r.hi >= best) [best, target] = [r.hi, c];
        }
      }
      target ??= all[0];
    }
    if (!target) {
      // No drafted photo page at all: start one before the closing spread.
      const w = newWork(works[works.length - 1], works[works.length - 1]?.spread.chapterId);
      works.splice(Math.max(1, works.length - 1), 0, w);
      w.pages[0].photos.push(a);
      w.assetIds.add(a.id);
      continue;
    }
    const { w } = target;
    const other = w.pages.find((p) => p !== target!.p && p.auto && !p.title && p.side !== 'spread' && p.photos.length > 0);
    const page = target.p.photos.length < cap ? target.p : other && other.photos.length < cap ? other : undefined;
    w.assetIds.add(a.id);
    if (page) {
      insertChronological(page.photos, a);
      page.addition = true;
      w.changed = true;
      continue;
    }
    // Full: the overflow goes on a new spread right after (reusing one already added there).
    let ow = works.find((x) => x.overflowOf === w && x.pages.some((p) => p.photos.length < cap));
    if (!ow) {
      ow = newWork(w, w.spread.chapterId);
      const after = works.reduce((at, x, k) => (x === w || x.overflowOf === w ? k : at), -1);
      // Never after the closing spread: its right-hand side is the inside of the back cover.
      works.splice(Math.min(after + 1, works.length - 1), 0, ow);
    }
    w.assetIds.delete(a.id);
    ow.assetIds.add(a.id);
    insertChronological((ow.pages[0].photos.length < cap ? ow.pages[0] : ow.pages[1]).photos, a);
  }

  // ---- spreads emptied of photos go (never the title or closing spread)
  let removedSpreads = 0;
  const kept = works.filter((w, i) => {
    const empty = !w.isNew && w.hadPhotos && w.pages.length > 0 && w.pages.every((p) => p.auto && !p.photos.length)
      && !w.spread.elements.some((e) => e.locked || (e.type === 'image' && e.assetId && !removedIds.includes(e.assetId)));
    if (!empty || i === 0 || i === works.length - 1) return true;
    removedSpreads++;
    return false;
  });

  // ---- lay out what changed
  const now = new Date().toISOString();
  const report: UpdateReport = {
    added: added.map((a) => a.id), removed: removedIds, replaced: [], relaidPages: [], addedSpreads: [], removedSpreads,
    emptiedFrames: [], pages: kept.length * 2 - 2, notes: [],
  };
  if (fellBack) report.notes.push('No photos are starred, so every photo was used.');
  const grew = report.pages - (doc.spreads.length * 2 - 2);
  if (grew) report.notes.push(`${grew > 0 ? 'Added' : 'Removed'} ${Math.abs(grew)} pages, now ${report.pages}.`);
  const spreads = kept.map((w) => w.spread);
  kept.forEach((w, i) => {
    if (!w.changed) return;
    const s = w.spread;
    const relaid: Side[] = [];
    const removal = w.pages.some((p) => p.removal);
    const pair = w.pages.length === 2 && w.pages.every((p) => p.auto);
    if (w.isNew || (removal && pair) || (removal && w.pages.length === 1 && w.pages[0].side === 'spread')) {
      spreads[i] = relaySpreadSide(ctx, spreads, i, 'spread', chronological(w.pages.flatMap((p) => p.photos)));
      relaid.push('spread');
    } else {
      for (const p of w.pages) {
        if (!p.auto || !(p.removal || p.addition)) continue;
        spreads[i] = relaySpreadSide(ctx, spreads, i, p.side, p.photos);
        relaid.push(p.side);
      }
    }
    const autoSides = w.pages.filter((p) => p.auto).map((p) => p.side);
    const prov = s.provenance ?? { generatedAt: now, seed: settings.seed, assetIds: [] };
    const assetIds = [...w.assetIds];
    let next: Spread = { ...spreads[i], provenance: relaid.length || w.isNew ? { ...prov, generatedAt: now, seed: settings.seed, assetIds } : { ...prov, assetIds } };
    if (w.isNew || (relaid.includes('spread') && pair)) next = withFingerprints(doc, next);
    else if (relaid.length || w.replacedOn.size) next = refingerprint(doc, next, autoSides, s.layout);
    spreads[i] = next;
    if (w.isNew) report.addedSpreads.push(i);
    else for (const side of relaid) report.relaidPages.push({ spreadIndex: i, side });
    for (const r of w.replaced) report.replaced.push({ ...r, spreadIndex: i });
    for (const elementId of w.emptied) report.emptiedFrames.push({ spreadIndex: i, elementId });
  });

  const result = reconcileCover({ ...doc, spreads, generation: { settings, generatedAt: now } });
  return { doc: result, report };
}
