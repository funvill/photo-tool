// Which photos the viewer and the preview load ahead of time, in what order (issue #5).
import { describe, expect, it } from 'vitest';
import { pathIndex, preloadOrder } from '../core/preloadWindow';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('preloadOrder', () => {
  it('stepping forward: the next three, the previous one, the rest of the next 20, the rest of the previous 5', () => {
    expect(preloadOrder(50, 100)).toEqual([51, 52, 53, 49, ...range(54, 70), 48, 47, 46, 45]);
  });

  it('loads 20 ahead and 5 behind by default, never the photo itself, never one twice', () => {
    const order = preloadOrder(50, 100);
    expect(order).toHaveLength(25);
    expect(new Set(order).size).toBe(25);
    expect(order).not.toContain(50);
  });

  it('stepping backward swaps the two: the previous three, the next one, the rest of the previous 20, the rest of the next 5', () => {
    expect(preloadOrder(50, 100, { direction: -1 })).toEqual([49, 48, 47, 51, ...range(30, 46).reverse(), 52, 53, 54, 55]);
  });

  it('takes other window sizes', () => {
    expect(preloadOrder(10, 100, { ahead: 4, behind: 2 })).toEqual([11, 12, 13, 9, 14, 8]);
    expect(preloadOrder(10, 100, { ahead: 2, behind: 0 })).toEqual([11, 12]);
    expect(preloadOrder(10, 100, { ahead: 0, behind: 0 })).toEqual([]);
  });

  it('at the start there is nothing behind', () => {
    expect(preloadOrder(0, 100)).toEqual(range(1, 20));
    expect(preloadOrder(0, 100, { direction: -1 })).toEqual([1, 2, 3, 4, 5]);
  });

  it('at the end there is nothing ahead', () => {
    expect(preloadOrder(99, 100)).toEqual([98, 97, 96, 95, 94]);
    expect(preloadOrder(99, 100, { direction: -1 })).toEqual(range(79, 98).reverse());
  });

  it('a short list loads what there is', () => {
    expect(preloadOrder(1, 4)).toEqual([2, 3, 0]);
    expect(preloadOrder(0, 2)).toEqual([1]);
    expect(preloadOrder(0, 1)).toEqual([]);
    expect(preloadOrder(0, 0)).toEqual([]);
  });

  it('an index outside the list loads nothing', () => {
    expect(preloadOrder(-1, 10)).toEqual([]);
    expect(preloadOrder(10, 10)).toEqual([]);
  });
});

describe('pathIndex', () => {
  it('maps each path to its place in the list', () => {
    const list = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    const at = pathIndex(list);
    expect(at.get('a')).toBe(0);
    expect(at.get('c')).toBe(2);
    expect(at.get('x')).toBeUndefined();
  });

  it('is built once per list', () => {
    const list = [{ path: 'a' }];
    expect(pathIndex(list)).toBe(pathIndex(list));
    expect(pathIndex([{ path: 'a' }])).not.toBe(pathIndex(list));
  });
});
