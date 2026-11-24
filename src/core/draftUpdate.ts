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
const orientationOf = (aspect: number) => (aspect >= 1.1 ? 'l' : aspect <= 0.9 ? 'p' : 's');

interface Ctx {
  doc: BookDocument;
  preset: StylePreset;
  /** Most photos a laid-out page may hold. */
  cap: number;
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
  const preset = stylePreset(settings.stylePresetId);
  return {
    doc,
    preset,
    cap: Math.min(7, preset.maxPerPage),
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
  if (index === 0 && side === 'right') {
    // The caller passes at most one photo here (see relaySpreadSide).
    const t = templateOrThrow(photos.length ? 'title-photo' : 'title-text');
    return { elements: layoutPage(doc, t, 'right', photos.slice(0, 1), { title: doc.title, subtitle: ctx.subtitle }), layoutId: t.id };
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
  const [l, r] = distributeCounts(photos.length, 2, ctx.cap, ctx.rng, ctx.explore);
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
  /** Elements that stay where they are: locked ones, and photos the title layout cannot hold. */
  const stay = affected.filter((e) => e.locked);
  if (index === 0 && side !== 'left' && photos.length > 1) {
    // The title page keeps its title layout; photos it cannot hold stay in their frames.
    const pick = photos.find((a) => aspectOf(a) >= 1.1) ?? photos[0];
    const extra = new Set(photos.filter((a) => a !== pick).map((a) => a.id));
    stay.push(...affected.filter((e) => !e.locked && e.type === 'image' && e.assetId && extra.has(e.assetId)));
    photos = [pick];
  }
  const limit = side === 'spread' && index > 0 && !last ? 2 * ctx.cap : ctx.cap;
  if (photos.length > limit) {
    // No laid-out page holds more than the cap: the latest photos beyond it stay in their frames.
    const extra = new Set(photos.slice(limit).map((a) => a.id));
    stay.push(...affected.filter((e) => !e.locked && e.type === 'image' && e.assetId && extra.has(e.assetId)));
    photos = photos.slice(0, limit);
  }
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
  return { ...s, layout, elements: [...kept, ...elements, ...stay] };
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
  // Nothing to lay out: leave the page (and any text or shapes on it) alone.
  if (!photos.length) return doc;
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
  replaced: { removed: string; added: string; side: Side }[];
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

/** A page that can take added photos: auto, holding photos, not the title page or a panorama. */
const takesPhotos = (p: Page) => p.auto && !p.title && p.side !== 'spread' && p.photos.length > 0;

/** True when a spread holds something outside its drafted pages (e.g. text on a page the draft left blank). */
function hasUndraftedContent(doc: BookDocument, s: Spread): boolean {
  if (s.layout?.spread) return false;
  return (['left', 'right'] as const).some((k) => !s.layout?.[k] && pageElements(doc, s, k).length > 0);
}

export const NOTHING_STARRED_NOTE = 'Nothing is starred yet, so the book was left as it is.';

/** Note for photos whose star could not be read (their folder or its photoinfo.json is unreadable). */
export function unreadableNote(count: number): string {
  return `${count} photo${count === 1 ? ' was' : 's were'} left alone because their folder or photoinfo.json couldn't be read.`;
}

export function updateDraft(doc: BookDocument, assets: PhotoAsset[], settings: GenerationSettings): { doc: BookDocument; report: UpdateReport } {
  const ctx = makeCtx(doc, assets, settings);
  const { cap } = ctx;
  // Photos whose star is unknown (folder or photoinfo.json unreadable) are neither added nor removed,
  // and a photo whose file is missing is never removed: an offline drive must not empty the book.
  const unknown = new Set(assets.filter((a) => a.infoUnavailable).map((a) => a.id));
  const keep = new Set([...unknown, ...assets.filter((a) => a.missing).map((a) => a.id)]);
  const notes = unknown.size ? [unreadableNote(unknown.size)] : [];
  const wantedPhotos = curatePool(assets).pool.filter((a) => a.favorite && !unknown.has(a.id));
  if (!wantedPhotos.length) {
    // Nothing starred: unlike a first draft, an update does not fall back to every photo.
    return {
      doc,
      report: {
        added: [], removed: [], replaced: [], relaidPages: [], addedSpreads: [], removedSpreads: 0, emptiedFrames: [],
        pages: doc.spreads.length * 2 - 2, notes: [NOTHING_STARRED_NOTE, ...notes],
      },
    };
  }
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
    for (const el of imagesOf(w.spread)) {
      const id = el.assetId!;
      if (wanted.has(id) || keep.has(id) || !w.assetIds.has(id)) continue;
      if (!removedIds.includes(id)) removedIds.push(id);
      const side: Side = w.spread.layout?.spread ? 'spread' : el.xMm + el.widthMm / 2 < doc.settings.trimWidthMm ? 'left' : 'right';
      const page = w.pages.find((p) => p.side === side);
      const asset = ctx.byId.get(id);
      if (page?.auto && asset && !el.locked) removals.push({ w, page, el, asset });
      else {
        // Hand work wins (locked spreads and frames count as hand work): the frame is left
        // empty for the user to fill or remove, and nothing else on the page changes.
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
    // The newcomer must suit the frame's shape, so the page needs no re-layout.
    const shape = orientationOf(el.widthMm / el.heightMm);
    const k = pending.findIndex((a) => day !== null && dayKey(a) === day && orientationOf(aspectOf(a)) === shape);
    if (k < 0) {
      page.removal = true;
      continue;
    }
    const [a] = pending.splice(k, 1);
    // As a template would lay it out: a cutout is shown whole without a border; a photo replacing
    // a cutout gets the style's border unless the frame bleeds off the page.
    const { trimWidthMm: tw, trimHeightMm: th } = doc.settings;
    const bleed = el.xMm <= 0 || el.yMm <= 0 || el.xMm + el.widthMm >= tw * 2 || el.yMm + el.heightMm >= th;
    const borderMm = isCutout(a) ? 0 : isCutout(asset) ? (bleed ? 0 : doc.style.imageBorderMm) : el.borderMm;
    let frame: ImageElement = { ...el, assetId: a.id, crop: defaultCrop(a), fit: isCutout(a) ? 'contain' : 'cover', borderMm };
    delete frame.adjust;
    frame = keepSubjectOutOfGutter(frame, a, doc);
    w.spread = { ...w.spread, elements: w.spread.elements.map((e) => (e.id === el.id ? frame : e)) };
    w.assetIds.add(a.id);
    insertChronological(page.photos, a);
    w.replacedOn.add(page.side);
    w.replaced.push({ removed: asset.id, added: a.id, side: page.side });
  }

  const targets = () => works.flatMap((w) => w.pages.filter(takesPhotos).map((p) => ({ w, p })));
  const newWork = (after: Work, chapterId: string | undefined): Work => {
    const spread: Spread = { id: newId(), locked: false, chapterId, layout: {}, elements: [] };
    const blank = (side: PageSide): Page => ({ side, auto: true, photos: [], title: false, removal: false, addition: true });
    return { spread, isNew: true, pages: [blank('left'), blank('right')], assetIds: new Set(), overflowOf: after, changed: true, replacedOn: new Set(), replaced: [], emptied: [], hadPhotos: false };
  };
  /**
   * Share the photos of a run out again in date order, at most `cap` a page: the page, its facing
   * page if it takes photos, and the spreads already added after it, in book order. Spreads are
   * added after the run (never after the closing spread) while the photos do not fit.
   */
  const shareOut = (w: Work, p: Page, a?: PhotoAsset) => {
    const run: { w: Work; p: Page }[] = [
      ...w.pages.filter((q) => q === p || takesPhotos(q)).map((q) => ({ w, p: q })),
      ...works.filter((x) => x.overflowOf === w).flatMap((x) => x.pages.map((q) => ({ w: x, p: q }))),
    ];
    const photos = chronological([...run.flatMap((r) => r.p.photos), ...(a ? [a] : [])]);
    const drafted = new Set([...(a ? [a.id] : []), ...run.flatMap((r) => r.p.photos.filter((x) => r.w.assetIds.has(x.id)).map((x) => x.id))]);
    while (photos.length > run.length * cap) {
      const ow = newWork(w, w.spread.chapterId);
      const after = works.reduce((at, x, k) => (x === w || x.overflowOf === w ? k : at), -1);
      // Never after the closing spread: its right-hand side is the inside of the back cover.
      works.splice(Math.min(after + 1, works.length - 1), 0, ow);
      run.push(...ow.pages.map((q) => ({ w: ow, p: q })));
    }
    // Book order: spreads added before the closing spread come before its page.
    const order = (r: { w: Work; p: Page }) => works.indexOf(r.w) * 2 + r.w.pages.indexOf(r.p);
    run.sort((x, y) => order(x) - order(y));
    for (const r of run) for (const x of r.p.photos) r.w.assetIds.delete(x.id);
    const base = Math.floor(photos.length / run.length);
    const extra = photos.length % run.length;
    let cursor = 0;
    run.forEach((r, k) => {
      const n = base + (Math.floor(((k + 1) * extra) / run.length) - Math.floor((k * extra) / run.length));
      const share = photos.slice(cursor, cursor + n);
      cursor += n;
      if (share.map((x) => x.id).join() !== r.p.photos.map((x) => x.id).join()) {
        r.p.addition = true;
        r.w.changed = true;
      }
      r.p.photos = share;
      for (const x of share) if (drafted.has(x.id)) r.w.assetIds.add(x.id);
    });
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
    const { w, p } = target;
    if (p.photos.length < cap) {
      insertChronological(p.photos, a);
      w.assetIds.add(a.id);
      p.addition = true;
      w.changed = true;
      continue;
    }
    // The target is full: share out the photos of its run again in date order.
    shareOut(w, p, a);
  }

  // ---- no re-laid page holds more than the cap (a style may have drafted pages fuller than 7)
  for (const w of [...works]) {
    for (const p of w.pages) {
      if (p.auto && !p.title && p.side !== 'spread' && (p.removal || p.addition) && p.photos.length > cap) shareOut(w, p);
    }
  }

  // ---- spreads emptied of photos go (never the title or closing spread, nor one holding hand work)
  let removedSpreads = 0;
  const kept = works.filter((w, i) => {
    const empty = !w.isNew && w.hadPhotos && w.pages.length > 0 && w.pages.every((p) => p.auto && !p.photos.length)
      && !hasUndraftedContent(doc, w.spread)
      && !w.spread.elements.some((e) => e.locked || (e.type === 'image' && e.assetId && !removedIds.includes(e.assetId)));
    if (!empty || i === 0 || i === works.length - 1) return true;
    removedSpreads++;
    return false;
  });

  // ---- lay out what changed
  const now = new Date().toISOString();
  const report: UpdateReport = {
    added: added.map((a) => a.id), removed: removedIds, replaced: [], relaidPages: [], addedSpreads: [], removedSpreads,
    emptiedFrames: [], pages: kept.length * 2 - 2, notes,
  };
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
    // A replacement on a page that was then re-laid is simply part of that re-layout.
    for (const { side, ...r } of w.replaced) if (!relaid.includes(side) && !relaid.includes('spread')) report.replaced.push({ ...r, spreadIndex: i });
    for (const elementId of w.emptied) report.emptiedFrames.push({ spreadIndex: i, elementId });
  });

  const result = reconcileCover({ ...doc, spreads, generation: { settings, generatedAt: now } });
  return { doc: result, report };
}
