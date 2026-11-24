import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPhotoAt, addTextAt, aspectOf, createBook, dayKey, generateDraft, isPageEdited, pageElements, relayPage, removeElements, setSpreadLocked,
  distributeCounts, mulberry32, starredPool, updateDraft, updateElement, withFingerprints,
  type BookDocument, type GenerationSettings, type ImageElement, type PhotoAsset, type Spread,
} from '../src/core';
import { fakeAsset, resetFakeAssets } from './helpers';

beforeEach(() => resetFakeAssets());

const SETTINGS: GenerationSettings = { targetPages: 24, stylePresetId: 'editorial', ordering: 'chronological', includeCaptions: true, seed: 1 };
const LAND = { widthPx: 4500, heightPx: 3000 };
const PORT = { widthPx: 3000, heightPx: 4500 };

/** 40 starred photos over 4 days (10 a day, 8:30–14:30), two landscapes to every portrait. */
function book() {
  const starred = Array.from({ length: 40 }, (_, i) =>
    fakeAsset({ day: 1 + Math.floor(i / 10), minute: 30 + (i % 10) * 40, favorite: true, ...(i % 3 === 2 ? PORT : LAND) }));
  const doc = generateDraft(createBook({ title: 'T', pages: 24 }), starred, SETTINGS).doc;
  return { starred, doc };
}

const images = (s: Spread) => s.elements.filter((e): e is ImageElement => e.type === 'image' && !!e.assetId);
const placedIds = (doc: BookDocument) => doc.spreads.flatMap((s) => images(s).map((e) => e.assetId!));
const sideOf = (doc: BookDocument, s: Spread, e: ImageElement) =>
  s.layout?.spread ? 'spread' : e.xMm + e.widthMm / 2 < doc.settings.trimWidthMm ? 'left' : 'right';
const onPage = (doc: BookDocument, s: Spread, side: string) => images(s).filter((e) => sideOf(doc, s, e) === side);
const unstar = (assets: PhotoAsset[], ids: string[]) => assets.map((a) => (ids.includes(a.id) ? { ...a, favorite: false } : a));
const byId = (assets: PhotoAsset[]) => new Map(assets.map((a) => [a.id, a]));
const noGen = (doc: BookDocument) => ({ ...doc, generation: undefined });

/** A spread in the middle of the book with two photo pages, the chosen page holding at least `min` photos. */
function pagePick(doc: BookDocument, min = 2, landscape?: Map<string, PhotoAsset>) {
  for (let i = 1; i < doc.spreads.length - 1; i++) {
    const s = doc.spreads[i];
    if (!s.layout?.left || !s.layout?.right) continue;
    for (const side of ['left', 'right'] as const) {
      const els = onPage(doc, s, side);
      if (els.length < min) continue;
      const el = landscape ? els.find((e) => landscape.get(e.assetId!)!.widthPx > landscape.get(e.assetId!)!.heightPx) : els[0];
      if (el) return { i, s, side, els, el };
    }
  }
  throw new Error('no suitable page');
}

/** Replace uuids by their order of appearance so two runs can be compared. */
function normalise(doc: BookDocument): string {
  const ids = new Map<string, number>();
  return JSON.stringify(noGen(doc), (k, v) =>
    k === 'generatedAt' ? null : typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? `id${ids.get(v) ?? (ids.set(v, ids.size), ids.size - 1)}` : v);
}

describe('updateDraft', () => {
  it('no change → identical document, empty report', () => {
    const { starred, doc } = book();
    expect(new Set(placedIds(doc)).size).toBe(40);
    const { doc: next, report } = updateDraft(doc, starred, SETTINGS);
    expect(noGen(next)).toEqual(noGen(doc));
    expect(report).toEqual({
      added: [], removed: [], replaced: [], relaidPages: [], addedSpreads: [], removedSpreads: 0, emptiedFrames: [],
      pages: doc.spreads.length * 2 - 2, notes: [],
    });
    expect(next.generation?.generatedAt).toBeTruthy();
  });

  it('unstarring a photo on an auto page removes it, re-laying only that page or spread', () => {
    const { starred, doc } = book();
    const { i, el } = pagePick(doc, 2);
    const { doc: next, report } = updateDraft(doc, unstar(starred, [el.assetId!]), SETTINGS);
    expect(placedIds(next)).not.toContain(el.assetId);
    expect(report.removed).toEqual([el.assetId]);
    expect(report.relaidPages).toHaveLength(1);
    expect(report.relaidPages[0].spreadIndex).toBe(i);
    expect(next.spreads).toHaveLength(doc.spreads.length);
    // Untouched pages keep their crops: every other spread is exactly as it was.
    next.spreads.forEach((s, k) => k !== i && expect(s).toEqual(doc.spreads[k]));
    for (const k of ['left', 'right', 'spread'] as const) if (next.spreads[i].layout?.[k]) expect(isPageEdited(next, next.spreads[i], k)).toBe(false);
  });

  it('same-day same-orientation replacement takes the same frame without re-laying', () => {
    const { starred, doc } = book();
    const { i, el } = pagePick(doc, 1, byId(starred));
    const old = starred.find((a) => a.id === el.assetId)!;
    const fresh = fakeAsset({ day: 1 + starred.indexOf(old) / 10 | 0, minute: 31, favorite: true, ...LAND });
    expect(dayKey(fresh)).toBe(dayKey(old));
    const { doc: next, report } = updateDraft(doc, [...unstar(starred, [old.id]), fresh], SETTINGS);
    const frame = images(next.spreads[i]).find((e) => e.assetId === fresh.id)!;
    expect(frame).toBeTruthy();
    expect([frame.xMm, frame.yMm, frame.widthMm, frame.heightMm]).toEqual([el.xMm, el.yMm, el.widthMm, el.heightMm]);
    expect(report.replaced).toEqual([{ removed: old.id, added: fresh.id, spreadIndex: i }]);
    expect(report.relaidPages).toEqual([]);
    expect(report.added).toEqual([fresh.id]);
    expect(placedIds(next)).not.toContain(old.id);
    expect(next.spreads[i].provenance!.assetIds).toContain(fresh.id);
    expect(isPageEdited(next, next.spreads[i], sideOf(next, next.spreads[i], frame))).toBe(false);
  });

  it('a replacement on a page that is then re-laid is reported only as the re-layout', () => {
    const { starred, doc } = book();
    const all = byId(starred);
    const { i, els } = pagePick(doc, 2);
    const shapeOf = (e: ImageElement) => (e.widthMm / e.heightMm >= 1.1 ? LAND : e.widthMm / e.heightMm <= 0.9 ? PORT : { widthPx: 4000, heightPx: 4000 });
    const [swap, drop] = els;
    const day = Number(dayKey(all.get(swap.assetId!)!)!.slice(8)) - 13;
    const fresh = fakeAsset({ day, minute: 1, favorite: true, ...shapeOf(swap) });
    const { doc: next, report } = updateDraft(doc, [...unstar(starred, [swap.assetId!, drop.assetId!]), fresh], SETTINGS);
    expect(report.replaced).toEqual([]);
    expect(report.relaidPages.map((p) => p.spreadIndex)).toEqual([i]);
    expect(placedIds(next)).toContain(fresh.id);
  });

  it('a newly starred photo lands on the pages for its date', () => {
    const { starred, doc } = book();
    const fresh = fakeAsset({ day: 3, minute: 205, favorite: true, ...LAND });
    const { doc: next, report } = updateDraft(doc, [...starred, fresh], SETTINGS);
    expect(report.added).toEqual([fresh.id]);
    const s = next.spreads.find((x) => images(x).some((e) => e.assetId === fresh.id))!;
    const frame = images(s).find((e) => e.assetId === fresh.id)!;
    const mates = onPage(next, s, sideOf(next, s, frame)).filter((e) => e !== frame).map((e) => byId(starred).get(e.assetId!)!);
    expect(mates.length).toBeGreaterThan(0);
    for (const m of mates) expect(dayKey(m)).toBe(dayKey(fresh));
    expect(placedIds(next).filter((id) => id === fresh.id)).toHaveLength(1);
  });

  it('a full page overflows to a new spread right after it', () => {
    const { starred, doc } = book();
    // Late on day 2, after every day-2 photo already in the book.
    const extra = Array.from({ length: 8 }, (_, k) => fakeAsset({ day: 2, minute: 395 + k * 5, favorite: true, ...(k % 2 ? PORT : LAND) }));
    const { doc: next, report } = updateDraft(doc, [...starred, ...extra], SETTINGS);
    const all = byId([...starred, ...extra]);
    for (const a of extra) expect(placedIds(next)).toContain(a.id);
    expect(report.addedSpreads.length).toBeGreaterThanOrEqual(1);
    expect(report.pages).toBe(doc.spreads.length * 2 - 2 + 2 * report.addedSpreads.length);
    expect(next.spreads).toHaveLength(doc.spreads.length + report.addedSpreads.length);
    const day2 = dayKey(extra[0]);
    const hasDay2 = (s: Spread) => images(s).some((e) => dayKey(all.get(e.assetId!)!) === day2);
    const first = Math.min(...report.addedSpreads);
    const last = Math.max(...report.addedSpreads);
    expect(hasDay2(next.spreads[first - 1])).toBe(true);
    // The new spreads come after every other day-2 spread.
    next.spreads.forEach((s, k) => k > last && expect(hasDay2(s)).toBe(false));
    for (const k of report.addedSpreads) {
      const s = next.spreads[k];
      expect(hasDay2(s)).toBe(true);
      expect(s.provenance?.fingerprints).toBeTruthy();
      for (const side of ['left', 'right'] as const) expect(isPageEdited(next, s, side)).toBe(false);
      expect(s.chapterId).toBe(next.spreads[first - 1].chapterId);
    }
    // Pages never grow beyond the density cap.
    for (const s of next.spreads) for (const side of ['left', 'right'] as const) expect(onPage(next, s, side).length).toBeLessThanOrEqual(3);
  });

  it('overflowing a full page keeps date order across its page, the facing page and the new spread', () => {
    const { starred, doc } = book();
    const all = byId(starred);
    const i = doc.spreads.findIndex((s, k) => k > 0 && s.layout?.left && s.layout?.right && onPage(doc, s, 'left').length === 3 && onPage(doc, s, 'right').length > 0);
    expect(i).toBeGreaterThan(0);
    const times = onPage(doc, doc.spreads[i], 'left').map((e) => Date.parse(all.get(e.assetId!)!.capturedAt!));
    const [lo, hi] = [Math.min(...times), Math.max(...times)];
    const extra = [1, 2, 3, 4].map((k) => {
      const minutesFromDay1 = (lo + ((hi - lo) * k) / 5 - Date.parse('2026-03-14T08:00:00')) / 60_000;
      return fakeAsset({ day: 1, minute: Math.round(minutesFromDay1), favorite: true, ...LAND });
    });
    extra.forEach((a) => all.set(a.id, a));
    const { doc: next, report } = updateDraft(doc, [...starred, ...extra], SETTINGS);
    expect(report.addedSpreads[0]).toBe(i + 1);
    const pages = [i, ...report.addedSpreads].flatMap((k) => (['left', 'right'] as const).map((side) => onPage(next, next.spreads[k], side)));
    const t = (e: ImageElement) => Date.parse(all.get(e.assetId!)!.capturedAt!);
    for (let k = 1; k < pages.length; k++) {
      if (!pages[k - 1].length || !pages[k].length) continue;
      expect(Math.max(...pages[k - 1].map(t))).toBeLessThanOrEqual(Math.min(...pages[k].map(t)));
    }
    for (const a of extra) expect(pages.flat().map((e) => e.assetId)).toContain(a.id);
  });

  it('re-lays the auto page of a half-edited spread and leaves the edited page byte-identical', () => {
    const { starred, doc } = book();
    const i = doc.spreads.findIndex((s, k) => k > 0 && s.layout?.left && s.layout?.right && onPage(doc, s, 'left').length > 0 && onPage(doc, s, 'right').length >= 2);
    const s = doc.spreads[i];
    const moved = onPage(doc, s, 'left')[0];
    const edited = updateElement(doc, s.id, moved.id, { xMm: moved.xMm + 2 });
    const leftBefore = pageElements(edited, edited.spreads[i], 'left');
    const gone = onPage(doc, s, 'right')[0].assetId!;
    const { doc: next, report } = updateDraft(edited, unstar(starred, [gone]), SETTINGS);
    const ns = next.spreads[i];
    expect(report.relaidPages).toEqual([{ spreadIndex: i, side: 'right' }]);
    expect(pageElements(next, ns, 'left')).toEqual(leftBefore);
    expect(images(ns).map((e) => e.assetId)).not.toContain(gone);
    expect(isPageEdited(next, ns, 'left')).toBe(true);
    expect(isPageEdited(next, ns, 'right')).toBe(false);
  });

  it('an unstarred photo in a locked spread leaves an empty frame and changes nothing else', () => {
    const { starred, doc } = book();
    const { i, s, el } = pagePick(doc, 1);
    const locked = setSpreadLocked(doc, s.id, true);
    const { doc: next, report } = updateDraft(locked, unstar(starred, [el.assetId!]), SETTINGS);
    const ns = next.spreads[i];
    expect(ns.locked).toBe(true);
    expect(ns.layout).toEqual(s.layout);
    expect(ns.elements).toEqual(s.elements.map((e) => (e.id === el.id ? { ...e, assetId: null } : e)));
    expect(report.emptiedFrames).toEqual([{ spreadIndex: i, elementId: el.id }]);
    expect(report.removed).toEqual([el.assetId]);
    expect(report.relaidPages).toEqual([]);
  });

  it('an unstarred photo in a locked frame leaves the frame empty instead of re-laying', () => {
    const { starred, doc } = book();
    const { i, s, el } = pagePick(doc, 2);
    const locked = updateElement(doc, s.id, el.id, { locked: true });
    const before = locked.spreads[i];
    const { doc: next, report } = updateDraft(locked, unstar(starred, [el.assetId!]), SETTINGS);
    expect(next.spreads[i].elements).toEqual(before.elements.map((e) => (e.id === el.id ? { ...e, assetId: null } : e)));
    expect(report.emptiedFrames).toEqual([{ spreadIndex: i, elementId: el.id }]);
    expect(report.removed).toEqual([el.assetId]);
    expect(report.relaidPages).toEqual([]);
  });

  it('never removes a spread holding something on a page the draft left blank', () => {
    const { starred, doc } = book();
    const { i, s } = pagePick(doc, 1);
    // Make a spread drafted on its left page only, with hand-typed text on the right.
    let d = removeElements(doc, s.id, pageElements(doc, s, 'right').map((e) => e.id));
    d = { ...d, spreads: d.spreads.map((x, k) => (k === i ? withFingerprints(d, { ...x, layout: { left: x.layout!.left } }) : x)) };
    d = addTextAt(d, s.id, d.settings.trimWidthMm * 1.5, 50, 'Our notes').doc;
    // Unstar every photo that was on this spread, so its left page empties and nothing comes back.
    const gone = images(s).map((e) => e.assetId!);
    const { doc: next, report } = updateDraft(d, unstar(starred, gone), SETTINGS);
    expect(report.added).toEqual([]);
    expect(report.removedSpreads).toBe(0);
    const ns = next.spreads.find((x) => x.id === s.id)!;
    expect(ns.elements.some((e) => e.type === 'text' && e.text === 'Our notes')).toBe(true);
  });

  it('a replacement must fit the frame’s shape, not the removed photo’s', () => {
    const { starred, doc } = book();
    const all = byId(starred);
    const cls = (r: number) => (r >= 1.1 ? 'l' : r <= 0.9 ? 'p' : 's');
    let hit: { i: number; el: ImageElement } | undefined;
    doc.spreads.forEach((s, i) => {
      if (hit || i === 0 || !s.layout?.left || !s.layout?.right) return;
      const el = images(s).find((e) => cls(e.widthMm / e.heightMm) !== cls(aspectOf(all.get(e.assetId!)!)));
      if (el) hit = { i, el };
    });
    expect(hit).toBeTruthy();
    const { i, el } = hit!;
    const old = all.get(el.assetId!)!;
    const shape = cls(el.widthMm / el.heightMm);
    const dims = shape === 'l' ? LAND : shape === 'p' ? PORT : { widthPx: 4000, heightPx: 4000 };
    const wrongDims = cls(aspectOf(old)) === 'l' ? LAND : cls(aspectOf(old)) === 'p' ? PORT : { widthPx: 4000, heightPx: 4000 };
    const day = Number(dayKey(old)!.slice(8)) - 13;
    const wrong = fakeAsset({ day, minute: 1, favorite: true, ...wrongDims });
    const right = fakeAsset({ day, minute: 2, favorite: true, ...dims });
    const { report } = updateDraft(doc, [...unstar(starred, [old.id]), wrong, right], SETTINGS);
    expect(report.replaced).toEqual([{ removed: old.id, added: right.id, spreadIndex: i }]);
  });

  it('a page re-laid with a cap of 7 even when the style allows more (collage)', () => {
    const settings = { ...SETTINGS, stylePresetId: 'collage', targetPages: 8 };
    const starred = Array.from({ length: 50 }, (_, i) => fakeAsset({ day: 1 + Math.floor(i / 30), minute: i * 7, favorite: true, ...(i % 3 === 2 ? PORT : LAND) }));
    const doc = generateDraft(createBook({ title: 'T', pages: 8 }), starred, settings).doc;
    const all = (s: Spread) => (['left', 'right'] as const).map((k) => onPage(doc, s, k).length);
    const i = doc.spreads.findIndex((s, k) => k > 0 && s.layout?.left && s.layout?.right && all(s)[0] + all(s)[1] === 15);
    expect(i).toBeGreaterThan(0);
    // With seed 2 the style's own limit (9) would split the 14 remaining photos 6/8.
    expect(distributeCounts(14, 2, 9, mulberry32(2), true)).toEqual([6, 8]);
    const gone = images(doc.spreads[i])[0].assetId!;
    const { doc: next, report } = updateDraft(doc, unstar(starred, [gone]), { ...settings, seed: 2 });
    expect(report.relaidPages).toEqual([{ spreadIndex: i, side: 'spread' }]);
    expect((['left', 'right'] as const).map((k) => onPage(next, next.spreads[i], k).length)).toEqual([7, 7]);
  });

  it('a single re-laid page never exceeds the cap; the rest overflows to a new spread', () => {
    const settings = { ...SETTINGS, stylePresetId: 'collage', targetPages: 8 };
    const starred = Array.from({ length: 60 }, (_, i) => fakeAsset({ day: 1 + Math.floor(i / 30), minute: i * 7, favorite: true, ...(i % 3 === 2 ? PORT : LAND) }));
    const doc = generateDraft(createBook({ title: 'T', pages: 8 }), starred, settings).doc;
    const i = doc.spreads.findIndex((s, k) => k > 0 && s.layout?.left && s.layout?.right && onPage(doc, s, 'left').length === 9);
    expect(i).toBeGreaterThan(0);
    const s = doc.spreads[i];
    const moved = onPage(doc, s, 'right')[0];
    const edited = updateElement(doc, s.id, moved.id, { xMm: moved.xMm + 2 });
    const rightBefore = pageElements(edited, edited.spreads[i], 'right');
    const gone = onPage(doc, s, 'left')[0].assetId!;
    const { doc: next, report } = updateDraft(edited, unstar(starred, [gone]), settings);
    expect(report.relaidPages).toEqual([{ spreadIndex: i, side: 'left' }]);
    expect(report.addedSpreads).toEqual([i + 1]);
    expect(onPage(next, next.spreads[i], 'left').length).toBeLessThanOrEqual(7);
    expect(pageElements(next, next.spreads[i], 'right')).toEqual(rightBefore);
    expect(new Set(placedIds(next))).toEqual(new Set(starred.map((a) => a.id).filter((id) => id !== gone)));
    for (const sp of report.addedSpreads.map((k) => next.spreads[k])) for (const k of ['left', 'right'] as const) expect(onPage(next, sp, k).length).toBeLessThanOrEqual(7);
  });

  it('overflowing the closing page keeps date order in book order', () => {
    const { starred, doc } = book();
    const last = doc.spreads.length - 1;
    expect(onPage(doc, doc.spreads[last], 'left').length).toBe(3);
    // Later than everything in the book: they all target the closing page.
    const late = [0, 1, 2, 3].map((k) => fakeAsset({ day: 5, minute: 30 + k * 40, favorite: true, ...LAND }));
    const all = byId([...starred, ...late]);
    const { doc: next, report } = updateDraft(doc, [...starred, ...late], SETTINGS);
    expect(report.addedSpreads.length).toBeGreaterThanOrEqual(1);
    const closing = next.spreads.length - 1;
    const runIdx = [...report.addedSpreads, closing].sort((a, b) => a - b);
    expect(runIdx[runIdx.length - 2]).toBe(closing - 1);
    const t = (e: ImageElement) => Date.parse(all.get(e.assetId!)!.capturedAt!);
    const pages = runIdx.flatMap((k) => (k === closing ? (['left'] as const) : (['left', 'right'] as const)).map((side) => onPage(next, next.spreads[k], side)));
    const seq = pages.flat().length;
    expect(seq).toBe(7);
    for (let k = 1; k < pages.length; k++) {
      if (!pages[k - 1].length || !pages[k].length) continue;
      expect(Math.max(...pages[k - 1].map(t))).toBeLessThanOrEqual(Math.min(...pages[k].map(t)));
    }
    expect(onPage(next, next.spreads[closing], 'left').map((e) => e.assetId)).toContain(late[3].id);
  });

  it('a hand-edited page is never re-laid; an unstarred photo on it leaves an empty frame', () => {
    const { starred, doc } = book();
    const { s, side, els } = pagePick(doc, 2);
    const [moved, gone] = els;
    const edited = updateElement(doc, s.id, moved.id, { xMm: moved.xMm + 3 });
    const before = edited.spreads.find((x) => x.id === s.id)!;
    const { doc: next, report } = updateDraft(edited, unstar(starred, [gone.assetId!]), SETTINGS);
    const i = next.spreads.findIndex((x) => x.id === s.id);
    const after = next.spreads[i];
    expect(after.elements).toEqual(before.elements.map((e) => (e.id === gone.id ? { ...e, assetId: null } : e)));
    expect(report.emptiedFrames).toEqual([{ spreadIndex: i, elementId: gone.id }]);
    expect(report.relaidPages).toEqual([]);
    expect(isPageEdited(next, after, side)).toBe(true);
  });

  it('a hand-placed photo stays even when it is not starred', () => {
    const { starred, doc } = book();
    const loose = fakeAsset({ day: 2, minute: 100, favorite: false, ...LAND });
    const { s } = pagePick(doc, 1);
    const placed = addPhotoAt(doc, s.id, loose, 40, 40).doc;
    const { doc: next, report } = updateDraft(placed, [...starred, loose], SETTINGS);
    expect(placedIds(next)).toContain(loose.id);
    expect(report.removed).toEqual([]);
  });

  it('a starred photo already placed by hand is not added twice', () => {
    const { starred, doc } = book();
    const loose = fakeAsset({ day: 2, minute: 100, favorite: false, ...LAND });
    const { s } = pagePick(doc, 1);
    const placed = addPhotoAt(doc, s.id, loose, 40, 40).doc;
    const { doc: next, report } = updateDraft(placed, [...starred, { ...loose, favorite: true }], SETTINGS);
    expect(placedIds(next).filter((id) => id === loose.id)).toHaveLength(1);
    expect(report.added).toEqual([]);
  });

  it('a spread emptied of photos is removed and the page count drops by 2', () => {
    const { starred, doc } = book();
    const { i, s } = pagePick(doc, 1);
    const gone = images(s).map((e) => e.assetId!);
    const { doc: next, report } = updateDraft(doc, unstar(starred, gone), SETTINGS);
    expect(next.spreads).toHaveLength(doc.spreads.length - 1);
    expect(next.spreads.some((x) => x.id === s.id)).toBe(false);
    expect(report.removedSpreads).toBe(1);
    expect(report.pages).toBe(doc.spreads.length * 2 - 4);
    expect(report.notes).toEqual([`Removed 2 pages, now ${report.pages}.`]);
    expect(report.removed.sort()).toEqual([...gone].sort());
    // The neighbours are untouched.
    expect(next.spreads[i - 1]).toEqual(doc.spreads[i - 1]);
    expect(next.spreads[i]).toEqual(doc.spreads[i + 1]);
  });

  it('untouched pages keep their crops after a mixed update', () => {
    const { starred, doc } = book();
    const { el } = pagePick(doc, 2);
    const fresh = fakeAsset({ day: 4, minute: 205, favorite: true, ...PORT });
    const { doc: next, report } = updateDraft(doc, [...unstar(starred, [el.assetId!]), fresh], SETTINGS);
    const named = new Set([
      ...report.relaidPages.map((p) => p.spreadIndex), ...report.replaced.map((p) => p.spreadIndex),
      ...report.emptiedFrames.map((p) => p.spreadIndex), ...report.addedSpreads,
    ]);
    expect(named.size).toBeGreaterThan(0);
    const old = new Map(doc.spreads.map((s) => [s.id, s]));
    next.spreads.forEach((s, k) => !named.has(k) && expect(s).toEqual(old.get(s.id)));
  });

  it('is deterministic', () => {
    const { starred, doc } = book();
    const extra = Array.from({ length: 8 }, (_, k) => fakeAsset({ day: 2, minute: 35 + k * 40, favorite: true, ...(k % 2 ? PORT : LAND) }));
    const input = [...unstar(starred, [starred[5].id, starred[33].id]), ...extra];
    const a = updateDraft(doc, input, SETTINGS);
    const b = updateDraft(doc, input, SETTINGS);
    expect(normalise(a.doc)).toBe(normalise(b.doc));
    expect(a.report).toEqual(b.report);
  });

  it('leaves the book as it is when nothing is starred, and says so', () => {
    const { starred, doc } = book();
    const none = starred.map((a) => ({ ...a, favorite: false }));
    const { doc: next, report } = updateDraft(doc, none, SETTINGS);
    expect(noGen(next)).toEqual(noGen(doc));
    expect(report).toEqual({
      added: [], removed: [], replaced: [], relaidPages: [], addedSpreads: [], removedSpreads: 0, emptiedFrames: [],
      pages: doc.spreads.length * 2 - 2, notes: ['Nothing is starred yet, so the book was left as it is.'],
    });
  });

  it('with nothing starred, unplaced library photos are not added', () => {
    const { starred, doc } = book();
    const loose = Array.from({ length: 6 }, (_, k) => fakeAsset({ day: 2, minute: 45 + k * 30, favorite: false, ...LAND }));
    const none = [...starred.map((a) => ({ ...a, favorite: false })), ...loose];
    const { doc: next, report } = updateDraft(doc, none, SETTINGS);
    expect(noGen(next)).toEqual(noGen(doc));
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.notes).toEqual(['Nothing is starred yet, so the book was left as it is.']);
  });

  it('never removes a photo whose file is missing', () => {
    const { starred, doc } = book();
    const { s } = pagePick(doc, 2);
    const [gone, unstarred] = images(s).map((e) => e.assetId!);
    // The file of one is gone (its star still reads); another is unstarred as usual.
    const assets = unstar(starred, [unstarred]).map((a) => (a.id === gone ? { ...a, missing: true } : a));
    const { doc: next, report } = updateDraft(doc, assets, SETTINGS);
    expect(placedIds(next)).toContain(gone);
    expect(placedIds(next)).not.toContain(unstarred);
    expect(report.removed).toEqual([unstarred]);
  });

  it('an offline folder (every photo missing, stars unreadable) leaves the book unchanged', () => {
    const { starred, doc } = book();
    const offline = starred.map((a) => ({ ...a, favorite: false, missing: true, infoUnavailable: true }));
    const { doc: next, report } = updateDraft(doc, offline, SETTINGS);
    expect(noGen(next)).toEqual(noGen(doc));
    expect(new Set(placedIds(next)).size).toBe(40);
    expect(report.removed).toEqual([]);
    expect(report.notes).toContain("40 photos were left alone because their folder or photoinfo.json couldn't be read.");
  });

  it('one of two folders unreadable: nothing is removed from it, the other folder updates as usual', () => {
    const { starred, doc } = book();
    // Days 1–2 live in a folder whose photoinfo.json can't be read; days 3–4 are readable.
    const unreadable = new Set(starred.slice(0, 20).map((a) => a.id));
    const dropped = starred[25].id;
    const fresh = fakeAsset({ day: 1, minute: 50, favorite: false, infoUnavailable: true, ...LAND });
    const assets = [
      ...starred.map((a) => (unreadable.has(a.id) ? { ...a, favorite: false, infoUnavailable: true } : a.id === dropped ? { ...a, favorite: false } : a)),
      fresh,
    ];
    const { doc: next, report } = updateDraft(doc, assets, SETTINGS);
    const ids = placedIds(next);
    for (const id of unreadable) expect(ids).toContain(id);
    expect(ids).not.toContain(dropped);
    expect(ids).not.toContain(fresh.id);
    expect(report.removed).toEqual([dropped]);
    expect(report.added).toEqual([]);
    expect(report.notes).toContain("21 photos were left alone because their folder or photoinfo.json couldn't be read.");
  });
});

describe('relayPage', () => {
  it('makes a hand-edited page auto again', () => {
    const { starred, doc } = book();
    const { i, s, side, el } = pagePick(doc, 1);
    const loose = fakeAsset({ day: 2, minute: 100, favorite: false, ...LAND });
    let edited = updateElement(doc, s.id, el.id, { xMm: el.xMm + 4 });
    const cx = side === 'left' ? doc.settings.trimWidthMm / 2 : doc.settings.trimWidthMm * 1.5;
    edited = addPhotoAt(edited, s.id, loose, cx, doc.settings.trimHeightMm / 2).doc;
    expect(isPageEdited(edited, edited.spreads[i], side)).toBe(true);
    const next = relayPage(edited, [...starred, loose], i, side, SETTINGS);
    const ns = next.spreads[i];
    expect(isPageEdited(next, ns, side)).toBe(false);
    const ids = onPage(next, ns, side).map((e) => e.assetId!);
    expect(ids).toContain(loose.id);
    for (const id of ids) expect(ns.provenance!.assetIds).toContain(id);
    // The other page is left as it was.
    const other = side === 'left' ? 'right' : 'left';
    expect(onPage(next, ns, other)).toEqual(onPage(edited, edited.spreads[i], other));
  });
});

describe('relayPage on a spread the user made', () => {
  it('lays out a page that has no provenance and records provenance and fingerprints for it', () => {
    const { starred, doc } = book();
    const a = starred[0];
    const b = starred[1];
    const s0 = doc.spreads.findIndex((s, i) => i > 0 && i < doc.spreads.length - 1);
    let hand = doc.spreads.map((s, i) => (i === s0 ? { ...s, elements: [], layout: undefined, provenance: undefined } : s));
    let d: BookDocument = { ...doc, spreads: hand };
    const sid = d.spreads[s0].id;
    const cx = d.settings.trimWidthMm / 2;
    d = addPhotoAt(d, sid, a, cx, d.settings.trimHeightMm / 2).doc;
    d = addPhotoAt(d, sid, b, cx, d.settings.trimHeightMm / 4).doc;
    const spread = d.spreads[s0];
    expect(spread.provenance).toBeUndefined();
    expect(isPageEdited(d, spread, 'left')).toBe(true);
    const next = relayPage(d, starred, s0, 'left', SETTINGS);
    const ns = next.spreads[s0];
    expect(ns.provenance).toBeTruthy();
    expect(ns.provenance!.assetIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ns.provenance!.fingerprints?.left).toBeTruthy();
    expect(isPageEdited(next, ns, 'left')).toBe(false);
    expect(onPage(next, ns, 'left').map((e) => e.assetId).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('relayPage on a page without photos', () => {
  it('returns the document unchanged for a text-only page that has no provenance', () => {
    const { starred, doc } = book();
    const s0 = 1;
    const base: BookDocument = { ...doc, spreads: doc.spreads.map((s, i) => (i === s0 ? { ...s, elements: [], layout: undefined, provenance: undefined } : s)) };
    const d = addTextAt(base, base.spreads[s0].id, 20, 20, 'Hello').doc;
    expect(d.spreads[s0].elements).toHaveLength(1);
    expect(relayPage(d, starred, s0, 'left', SETTINGS)).toBe(d);
  });
});

describe('relayPage on the title page', () => {
  it('keeps the title layout', () => {
    const { starred, doc } = book();
    const t = doc.spreads[0];
    expect(t.layout?.right).toBe('title-photo');
    const photo = images(t)[0];
    const loose = fakeAsset({ day: 2, minute: 100, favorite: false, ...LAND });
    let edited = updateElement(doc, t.id, photo.id, { xMm: photo.xMm + 5 });
    edited = addPhotoAt(edited, t.id, loose, doc.settings.trimWidthMm * 1.5, 40).doc;
    const next = relayPage(edited, [...starred, loose], 0, 'right', SETTINGS);
    const ns = next.spreads[0];
    expect(ns.layout?.right).toBe('title-photo');
    expect(ns.elements.some((e) => e.type === 'text' && e.text === doc.title)).toBe(true);
    expect(images(ns).map((e) => e.assetId).sort()).toEqual([photo.assetId, loose.id].sort());
    expect(isPageEdited(next, ns, 'right')).toBe(false);
  });
});

describe('starredPool', () => {
  it('returns usable starred photos, or every usable photo when none is starred', () => {
    const a = fakeAsset({ favorite: true });
    const b = fakeAsset({ favorite: false });
    const hidden = fakeAsset({ favorite: true, excluded: true });
    const gone = fakeAsset({ favorite: true, missing: true });
    const dup = fakeAsset({ favorite: true, exactDuplicateOf: a.id });
    expect(starredPool([a, b, hidden, gone, dup])).toEqual({ photos: [a], fellBack: false });
    const unstarred = [a, b, hidden, gone, dup].map((x) => ({ ...x, favorite: false }));
    const r = starredPool(unstarred);
    expect(r.fellBack).toBe(true);
    expect(r.photos.map((x) => x.id)).toEqual([a.id, b.id]);
  });
});
