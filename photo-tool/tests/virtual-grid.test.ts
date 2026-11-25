// The gallery's grid draws only the rows on screen (plus a few above and below), so a folder of
// thousands of photos scrolls smoothly.
import { describe, expect, it } from 'vitest';
import { gridWindow } from '../web/virtualGrid';

const base = { count: 3000, width: 1000, tile: 160, gap: 6, scrollTop: 0, viewport: 800 };

describe('gridWindow', () => {
  it('fits as many tiles across as the width allows', () => {
    expect(gridWindow(base).cols).toBe(6);
  });

  it('keeps the drawn range to the visible rows plus overscan', () => {
    for (const scrollTop of [0, 1234, 25_000, 40_000]) {
      const w = gridWindow({ ...base, scrollTop });
      expect(w.firstIndex).toBeGreaterThanOrEqual(0);
      expect(w.lastIndex - w.firstIndex).toBeLessThanOrEqual(60);
      expect(w.lastIndex).toBeGreaterThanOrEqual(w.firstIndex);
    }
  });

  it('is as tall as every row and the gaps between them', () => {
    const w = gridWindow(base);
    const rows = Math.ceil(3000 / w.cols);
    expect(w.totalHeight).toBeCloseTo(rows * (w.rowHeight + 6) - 6, 6);
  });

  it('reaches the last photo when scrolled to the bottom', () => {
    const { totalHeight } = gridWindow(base);
    const w = gridWindow({ ...base, scrollTop: totalHeight - 800 });
    expect(w.lastIndex).toBe(2999);
    expect(w.offsetTop).toBeCloseTo(Math.floor(w.firstIndex / w.cols) * (w.rowHeight + 6), 6);
  });

  it('uses one column when the width is narrower than one tile', () => {
    const w = gridWindow({ ...base, width: 100 });
    expect(w.cols).toBe(1);
    expect(w.lastIndex).toBeGreaterThanOrEqual(w.firstIndex);
  });

  it('draws nothing for an empty folder', () => {
    const w = gridWindow({ ...base, count: 0 });
    expect(w.totalHeight).toBe(0);
    expect(w.lastIndex).toBeLessThan(w.firstIndex);
  });
});
