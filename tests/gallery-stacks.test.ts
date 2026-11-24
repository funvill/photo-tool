// Stacks: the near-identical shots of a burst folded into one tile (its top), opened on demand.
import { describe, expect, it } from 'vitest';
import type { GalleryFacts, GalleryItemLike } from '../src/core/gallerySort';
import { stackItems } from '../src/core/galleryStacks';

const photo = (name: string, star = false): GalleryItemLike => ({
  path: name,
  fileName: name,
  relDir: '',
  width: 4000,
  height: 3000,
  size: 1,
  effectiveDate: null,
  effectiveLat: null,
  info: star ? { star: true } : {},
  analysis: null,
});
const fact = (groupId: string | null, isKeeper = groupId === null): GalleryFacts => ({
  interesting: 0,
  colour: { bucket: 'neutral', lightness: 0 },
  flags: { blurry: false, dark: false, bright: false, lowRes: false },
  groupId,
  isKeeper,
});
const names = (items: GalleryItemLike[]) => items.map((i) => i.path);

describe('stackItems', () => {
  it("folded stack shows only its keeper, at the keeper's sort position, with size = members", () => {
    const sorted = ['a', 'b', 'c', 'd', 'e'].map((n) => photo(n));
    const facts = new Map([
      ['a', fact(null)],
      ['b', fact('g', false)],
      ['c', fact('g', true)],
      ['d', fact('g', false)],
      ['e', fact(null)],
    ]);
    const { items, stackOf } = stackItems(sorted, facts, new Set());
    expect(names(items)).toEqual(['a', 'c', 'e']);
    expect(stackOf.get('c')).toEqual({ id: 'g', size: 3, open: false, top: true });
    expect(stackOf.size).toBe(1);
  });

  it('a starred member becomes the top over the keeper', () => {
    const sorted = [photo('a'), photo('b', true), photo('c')];
    const facts = new Map([
      ['a', fact('g', true)],
      ['b', fact('g', false)],
      ['c', fact('g', false)],
    ]);
    const { items, stackOf } = stackItems(sorted, facts, new Set());
    expect(names(items)).toEqual(['b']);
    expect(stackOf.get('b')?.top).toBe(true);
  });

  it('open stack lists the other members right after the top, in sort order', () => {
    const sorted = ['a', 'b', 'c', 'd', 'e'].map((n) => photo(n));
    const facts = new Map([
      ['a', fact('g', false)],
      ['b', fact(null)],
      ['c', fact('g', true)],
      ['d', fact('g', false)],
      ['e', fact(null)],
    ]);
    const { items, stackOf } = stackItems(sorted, facts, new Set(['g']));
    expect(names(items)).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(stackOf.get('c')).toEqual({ id: 'g', size: 3, open: true, top: true });
    expect(stackOf.get('a')).toEqual({ id: 'g', size: 3, open: true, top: false });
    expect(stackOf.get('d')).toEqual({ id: 'g', size: 3, open: true, top: false });
  });

  it('when the filter left out the keeper, the first shown member is the top', () => {
    // The keeper is not in the list; b and c remain.
    const sorted = [photo('b'), photo('c')];
    const facts = new Map([
      ['b', fact('g', false)],
      ['c', fact('g', false)],
    ]);
    const { items, stackOf } = stackItems(sorted, facts, new Set());
    expect(names(items)).toEqual(['b']);
    expect(stackOf.get('b')).toEqual({ id: 'g', size: 2, open: false, top: true });
  });

  it('a group with one shown member is a plain item with no stackOf entry', () => {
    const sorted = [photo('a'), photo('b')];
    const facts = new Map([
      ['a', fact('g', true)],
      ['b', fact(null)],
    ]);
    const { items, stackOf } = stackItems(sorted, facts, new Set(['g']));
    expect(names(items)).toEqual(['a', 'b']);
    expect(stackOf.size).toBe(0);
  });

  it('photos in no group pass through unchanged', () => {
    const sorted = ['a', 'b', 'c'].map((n) => photo(n));
    const facts = new Map(sorted.map((p) => [p.path, fact(null)] as const));
    const { items, stackOf } = stackItems(sorted, facts, new Set());
    expect(items).toEqual(sorted);
    expect(stackOf.size).toBe(0);
  });
});
