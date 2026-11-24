// The gallery viewer's keys, and how clicks build the grid's selection (which a drag then takes along).
import { describe, expect, it } from 'vitest';
import { clickSelect, dragPaths, viewerNeighbours, viewerStep } from '../src/core';

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

  it('preloads the next two and the previous two that exist', () => {
    expect(viewerNeighbours(2, 10)).toEqual([3, 4, 1, 0]);
    expect(viewerNeighbours(0, 2)).toEqual([1]);
    expect(viewerNeighbours(0, 1)).toEqual([]);
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
