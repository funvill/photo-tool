// The gallery viewer's keys, and how clicks build the grid's selection (which a drag then takes along).
import { describe, expect, it } from 'vitest';
import { clickSelect, dragPaths, flagTargets, gridStep, nextAfterRemoval, viewerStep } from '../core/galleryViewer';

describe('viewerStep', () => {
  it('moves with the arrow keys and stops at the ends', () => {
    expect(viewerStep(0, 3, 'ArrowRight')).toEqual({ index: 1 });
    expect(viewerStep(2, 3, 'ArrowRight')).toEqual({ index: 2 });
    expect(viewerStep(1, 3, 'ArrowLeft')).toEqual({ index: 0 });
    expect(viewerStep(0, 3, 'ArrowLeft')).toEqual({ index: 0 });
  });

  it('S stars, I shows details, Esc closes, other keys do nothing', () => {
    expect(viewerStep(1, 3, 's')).toEqual({ index: 1, action: 'star' });
    expect(viewerStep(1, 3, 'S')).toEqual({ index: 1, action: 'star' });
    expect(viewerStep(1, 3, 'i')).toEqual({ index: 1, action: 'details' });
    expect(viewerStep(1, 3, 'I')).toEqual({ index: 1, action: 'details' });
    expect(viewerStep(1, 3, 'Escape')).toEqual({ index: 1, action: 'close' });
    for (const key of ['a', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'Shift']) expect(viewerStep(1, 3, key)).toEqual({ index: 1 });
  });

  it('F favourites (the same star as S) and H hides', () => {
    expect(viewerStep(1, 3, 'f')).toEqual({ index: 1, action: 'star' });
    expect(viewerStep(1, 3, 'F')).toEqual({ index: 1, action: 'star' });
    expect(viewerStep(1, 3, 'h')).toEqual({ index: 1, action: 'hide' });
    expect(viewerStep(1, 3, 'H')).toEqual({ index: 1, action: 'hide' });
  });
});

describe('grid selection', () => {
  const visible = ['a', 'b', 'c', 'd', 'e'];
  const none = { selected: null, selection: [], anchor: null };

  it('a plain click selects that one photo', () => {
    const s = clickSelect(visible, { selected: 'a', selection: ['a', 'b'], anchor: 'a' }, 'c', {});
    expect(s).toEqual({ selected: 'c', selection: ['c'], anchor: 'c' });
  });

  it('Ctrl-click toggles a photo in and out, keeping the grid order', () => {
    let s = clickSelect(visible, none, 'd', {});
    s = clickSelect(visible, s, 'b', { ctrl: true });
    expect(s).toEqual({ selected: 'b', selection: ['b', 'd'], anchor: 'b' });
    s = clickSelect(visible, s, 'd', { ctrl: true });
    expect(s).toEqual({ selected: 'b', selection: ['b'], anchor: 'd' });
    s = clickSelect(visible, s, 'b', { ctrl: true });
    expect(s).toEqual({ selected: null, selection: [], anchor: 'b' });
  });

  it('Shift-click selects the range from the last plain or Ctrl click, in either direction', () => {
    let s = clickSelect(visible, none, 'b', {});
    s = clickSelect(visible, s, 'd', { shift: true });
    expect(s).toEqual({ selected: 'd', selection: ['b', 'c', 'd'], anchor: 'b' });
    // The anchor stays: a second Shift-click replaces the range.
    s = clickSelect(visible, s, 'a', { shift: true });
    expect(s).toEqual({ selected: 'a', selection: ['a', 'b'], anchor: 'b' });
    // Ctrl-click moves the anchor.
    s = clickSelect(visible, s, 'e', { ctrl: true });
    s = clickSelect(visible, s, 'c', { shift: true });
    expect(s.selection).toEqual(['c', 'd', 'e']);
  });

  it('Shift-click with no anchor in the grid acts as a plain click', () => {
    expect(clickSelect(visible, { selected: 'x', selection: ['x'], anchor: 'x' }, 'c', { shift: true })).toEqual({ selected: 'c', selection: ['c'], anchor: 'c' });
  });

  it('dragging a selected photo takes every selected one in grid order; an unselected one goes alone', () => {
    expect(dragPaths(visible, ['d', 'b'], 'd')).toEqual(['b', 'd']);
    expect(dragPaths(visible, ['d', 'b'], 'a')).toEqual(['a']);
    expect(dragPaths(visible, [], 'c')).toEqual(['c']);
  });
});

describe('gridStep', () => {
  it('moves by one with Left/Right and by a row with Up/Down', () => {
    expect(gridStep(3, 10, 4, 'ArrowRight')).toBe(4);
    expect(gridStep(3, 10, 4, 'ArrowLeft')).toBe(2);
    expect(gridStep(1, 10, 4, 'ArrowDown')).toBe(5);
    expect(gridStep(5, 10, 4, 'ArrowUp')).toBe(1);
  });
  it('clamps to the list', () => {
    expect(gridStep(9, 10, 4, 'ArrowRight')).toBe(9);
    expect(gridStep(0, 10, 4, 'ArrowLeft')).toBe(0);
    expect(gridStep(8, 10, 4, 'ArrowDown')).toBe(9);
    expect(gridStep(2, 10, 4, 'ArrowUp')).toBe(0);
  });
  it('Home and End jump to the ends', () => {
    expect(gridStep(5, 10, 4, 'Home')).toBe(0);
    expect(gridStep(5, 10, 4, 'End')).toBe(9);
  });
  it('ignores other keys and an empty list', () => {
    expect(gridStep(1, 10, 4, 'x')).toBeNull();
    expect(gridStep(0, 0, 4, 'ArrowRight')).toBeNull();
  });
});

describe('flagTargets', () => {
  const current = (path: string) => path === 'b';
  it('is null when nothing is selected', () => {
    expect(flagTargets([], null, current)).toBeNull();
  });
  it('flags just the selected photo and flips its current value', () => {
    expect(flagTargets(['a'], 'a', current)).toEqual({ paths: ['a'], value: true });
    expect(flagTargets(['b'], 'b', current)).toEqual({ paths: ['b'], value: false });
  });
  it('flags the whole selection when the selected photo is in it', () => {
    expect(flagTargets(['a', 'b', 'c'], 'b', current)).toEqual({ paths: ['a', 'b', 'c'], value: false });
  });
  it('flags only the selected photo when it is outside a multi-selection', () => {
    expect(flagTargets(['a', 'c'], 'd', current)).toEqual({ paths: ['d'], value: true });
  });
});

describe('nextAfterRemoval', () => {
  const before = ['a', 'b', 'c', 'd'];
  it('keeps the selected photo when it is still there', () => {
    expect(nextAfterRemoval(before, ['a', 'b', 'd'], 'b')).toBe('b');
  });
  it('moves to the next remaining photo', () => {
    expect(nextAfterRemoval(before, ['a', 'd'], 'b')).toBe('d');
  });
  it('moves to the previous one when the last was removed', () => {
    expect(nextAfterRemoval(before, ['a', 'b', 'c'], 'd')).toBe('c');
  });
  it('takes the photo that came into its place (a stack whose face was hidden shows its next member there)', () => {
    // A (a stack's face) hidden: B, folded under it until now, is the new face in the same place.
    expect(nextAfterRemoval(['x', 'A', 'z'], ['x', 'B', 'z'], 'A')).toBe('B');
    expect(nextAfterRemoval(['A', 'z'], ['B', 'z'], 'A')).toBe('B');
    // Several gone around it: the place counts only the photos before it that stayed.
    expect(nextAfterRemoval(['a', 'b', 'c', 'd'], ['c', 'd'], 'b')).toBe('c');
  });
  it('is null when everything is gone or nothing was selected', () => {
    expect(nextAfterRemoval(before, [], 'b')).toBeNull();
    expect(nextAfterRemoval(before, ['a'], null)).toBeNull();
  });
});
