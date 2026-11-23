import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPhotoAt, createBook, dayKey, generateDraft, isPageEdited, relayPage, starredPool, updateDraft, updateElement,
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
    const extra = Array.from({ length: 8 }, (_, k) => fakeAsset({ day: 2, minute: 35 + k * 40, favorite: true, ...(k % 2 ? PORT : LAND) }));
    const { doc: next, report } = updateDraft(doc, [...starred, ...extra], SETTINGS);
    const all = byId([...starred, ...extra]);
    for (const a of extra) expect(placedIds(next)).toContain(a.id);
    expect(report.addedSpreads.length).toBeGreaterThanOrEqual(1);
    expect(report.pages).toBe(doc.spreads.length * 2 - 2 + 2 * report.addedSpreads.length);
    expect(next.spreads).toHaveLength(doc.spreads.length + report.addedSpreads.length);
    const day2 = dayKey(extra[0]);
    for (const k of report.addedSpreads) {
      const s = next.spreads[k];
      expect(images(s).length).toBeGreaterThan(0);
      for (const e of images(s)) expect(dayKey(all.get(e.assetId!)!)).toBe(day2);
      expect(images(next.spreads[k - 1]).some((e) => dayKey(all.get(e.assetId!)!) === day2)).toBe(true);
      expect(s.provenance?.fingerprints).toBeTruthy();
      for (const side of ['left', 'right'] as const) expect(isPageEdited(next, s, side)).toBe(false);
      expect(s.chapterId).toBe(next.spreads[k - 1].chapterId);
    }
    // Pages never grow beyond the density cap.
    for (const s of next.spreads) for (const side of ['left', 'right'] as const) expect(onPage(next, s, side).length).toBeLessThanOrEqual(3);
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

  it('falls back to every photo when nothing is starred, and says so', () => {
    const { starred, doc } = book();
    const none = starred.map((a) => ({ ...a, favorite: false }));
    const { report } = updateDraft(doc, none, SETTINGS);
    expect(report.removed).toEqual([]);
    expect(report.notes.length).toBe(1);
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
