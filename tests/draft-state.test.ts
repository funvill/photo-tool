import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPhotoAt, applyPageAddon, applyStylePreset, createBook, generateDraft, handPlacedAssetIds, isPageEdited, removeElements, setFramePhoto, updateElement, updateStyle,
  withFingerprints,
  type BookDocument, type ImageElement, type PhotoAsset, type Spread, type TextElement,
} from '../src/core';
import { fakeAsset, resetFakeAssets } from './helpers';

beforeEach(() => resetFakeAssets());

const assets = (): PhotoAsset[] => Array.from({ length: 40 }, (_, i) => fakeAsset({ day: 1 + Math.floor(i / 20), minute: (i % 20) * 25, widthPx: 6000, heightPx: 4000 }));
const draft = (a: PhotoAsset[]) =>
  generateDraft(createBook({ title: 'T', pages: 16 }), a, { targetPages: 16, stylePresetId: 'editorial', ordering: 'chronological', includeCaptions: true, seed: 1 }).doc;
const sides = (s: Spread) => (['left', 'right', 'spread'] as const).filter((k) => s.layout?.[k]);
const photoSpread = (doc: BookDocument) => doc.spreads.find((s) => s.provenance && s.elements.some((e) => e.type === 'image' && e.assetId) && s.layout?.left && s.layout?.right)!;
const firstPhoto = (s: Spread) => s.elements.find((e): e is ImageElement => e.type === 'image' && !!e.assetId)!;
const sideOf = (doc: BookDocument, e: ImageElement) => (e.xMm + e.widthMm / 2 < doc.settings.trimWidthMm ? 'left' : 'right');
const edited = (doc: BookDocument, id: string) => {
  const s = doc.spreads.find((x) => x.id === id)!;
  return sides(s).filter((k) => isPageEdited(doc, s, k));
};

describe('draft state', () => {
  it('a fresh draft is unedited on every page', () => {
    const doc = draft(assets());
    for (const s of doc.spreads) {
      expect(s.provenance?.fingerprints).toBeTruthy();
      for (const k of sides(s)) expect(isPageEdited(doc, s, k)).toBe(false);
    }
  });

  it('moving, re-cropping, swapping or removing a photo marks only that page edited', () => {
    const a = assets();
    const doc = draft(a);
    const s = photoSpread(doc);
    const ph = firstPhoto(s);
    const side = sideOf(doc, ph);
    const edits: BookDocument[] = [
      updateElement(doc, s.id, ph.id, { xMm: ph.xMm + 3 }),
      updateElement(doc, s.id, ph.id, { crop: { ...ph.crop, zoom: ph.crop.zoom + 0.5 } }),
      setFramePhoto(doc, s.id, ph.id, a.find((x) => x.id !== ph.assetId && !s.provenance!.assetIds.includes(x.id))!),
      removeElements(doc, s.id, [ph.id]),
    ];
    for (const next of edits) {
      const ns = next.spreads.find((x) => x.id === s.id)!;
      expect(sides(ns).filter((k) => isPageEdited(next, ns, k))).toEqual([side]);
      for (const other of next.spreads.filter((x) => x.id !== s.id)) for (const k of sides(other)) expect(isPageEdited(next, other, k)).toBe(false);
    }
  });

  it('restyling does not mark pages edited', () => {
    const doc = draft(assets());
    let next = applyStylePreset(doc, 'scrapbook');
    next = updateStyle(next, { textColor: '#ff0000', background: '#223344' });
    const s = photoSpread(doc);
    next = updateElement(next, s.id, firstPhoto(s).id, { borderColor: '#00ff00', borderMm: 2 });
    for (const sp of next.spreads) for (const k of sides(sp)) expect(isPageEdited(next, sp, k)).toBe(false);
  });

  it('auto-filled text does not count', () => {
    const doc0 = draft(assets());
    const doc = withFp(applyPageAddon(doc0, 2, 'right', 'contents'));
    const s = doc.spreads[2];
    const toc = s.elements.find((e): e is TextElement => e.type === 'text' && e.auto === 'toc')!;
    expect(toc).toBeTruthy();
    const next = updateElement(doc, s.id, toc.id, { text: 'Something else entirely' });
    expect(isPageEdited(next, next.spreads[2], 'right')).toBe(false);
    function withFp(d: BookDocument): BookDocument {
      return { ...d, spreads: d.spreads.map((sp, i) => (i === 2 ? withFingerprints(d, { ...sp, layout: { ...sp.layout, right: sp.layout?.right ?? 'x' } }) : sp)) };
    }
  });

  it('old drafts without fingerprints count as unedited', () => {
    const doc = draft(assets());
    const s = photoSpread(doc);
    const ph = firstPhoto(s);
    let next = updateElement(doc, s.id, ph.id, { xMm: ph.xMm + 5 });
    next = { ...next, spreads: next.spreads.map((x) => (x.id === s.id ? { ...x, provenance: { ...x.provenance!, fingerprints: undefined } } : x)) };
    const ns = next.spreads.find((x) => x.id === s.id)!;
    for (const k of sides(ns)) expect(isPageEdited(next, ns, k)).toBe(false);
  });

  it('something added to a page the draft left blank counts as edited; a blank page does not', () => {
    const a = assets();
    const doc = draft(a);
    const title = doc.spreads[0];
    expect(title.layout?.left).toBeUndefined();
    expect(isPageEdited(doc, title, 'left')).toBe(false);
    const placed = new Set(doc.spreads.flatMap((s) => s.elements.map((e) => (e.type === 'image' ? e.assetId : null))));
    const extra = a.find((x) => !placed.has(x.id)) ?? a[0];
    const next = addPhotoAt(doc, title.id, extra, doc.settings.trimWidthMm / 2, doc.settings.trimHeightMm / 2).doc;
    expect(isPageEdited(next, next.spreads[0], 'left')).toBe(true);
    expect(isPageEdited(next, next.spreads[0], 'right')).toBe(false);
    // Without any fingerprints (old books) the same addition still counts as unedited.
    const old = { ...next, spreads: next.spreads.map((s, i) => (i === 0 ? { ...s, provenance: { ...s.provenance!, fingerprints: undefined } } : s)) };
    expect(isPageEdited(old, old.spreads[0], 'left')).toBe(false);
  });

  it('locked or provenance-less spreads count as edited', () => {
    const doc = draft(assets());
    const s = photoSpread(doc);
    expect(isPageEdited(doc, { ...s, locked: true }, 'left')).toBe(true);
    expect(isPageEdited(doc, { ...s, provenance: undefined }, 'left')).toBe(true);
  });

  it('handPlacedAssetIds finds a photo dragged onto an auto page', () => {
    const a = assets();
    const doc = draft(a);
    const s = photoSpread(doc);
    expect(handPlacedAssetIds(s).size).toBe(0);
    const extra = a.find((x) => !s.provenance!.assetIds.includes(x.id))!;
    const ph = firstPhoto(s);
    const next = updateElement(doc, s.id, ph.id, { assetId: extra.id });
    expect([...handPlacedAssetIds(next.spreads.find((x) => x.id === s.id)!)]).toEqual([extra.id]);
    expect(handPlacedAssetIds({ ...s, provenance: undefined }).size).toBeGreaterThan(0);
  });
});
