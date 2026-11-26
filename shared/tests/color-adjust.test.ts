// Light and colour: four sliders become one colour matrix plus an offset, the same numbers for the page
// (an SVG feColorMatrix) and the server (sharp recomb + linear), so the saved photo matches the preview.
import { describe, expect, it } from 'vitest';
import { applyMatrix, autoAdjust, colorMatrix, isNoAdjust, NO_ADJUST, svgMatrixValues, type Adjust } from '../core/colorAdjust';

const LUMA = [0.2126, 0.7152, 0.0722];
const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('colorMatrix', () => {
  it('no adjustment is the identity with no offset', () => {
    const c = colorMatrix(NO_ADJUST);
    close(c.m, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    close(c.offset, [0, 0, 0]);
  });

  it('brightness +50 is an offset of 0.2 on every channel', () => {
    const c = colorMatrix({ ...NO_ADJUST, brightness: 50 });
    close(c.m, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    close(c.offset, [0.2, 0.2, 0.2]);
  });

  it('saturation -100 makes every row the Rec. 709 luma weights (grey)', () => {
    const c = colorMatrix({ ...NO_ADJUST, saturation: -100 });
    for (let r = 0; r < 3; r++) close(c.m.slice(r * 3, r * 3 + 3), LUMA);
  });

  it('contrast -100 scales to nothing: every pixel is mid grey', () => {
    const c = colorMatrix({ ...NO_ADJUST, contrast: -100 });
    close(c.m, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    close(c.offset, [0.5, 0.5, 0.5]);
  });

  it('warmth +100 raises red and lowers blue by 0.15', () => {
    const c = colorMatrix({ ...NO_ADJUST, warmth: 100 });
    close(c.m, [1.15, 0, 0, 0, 1, 0, 0, 0, 0.85]);
  });

  it('applyMatrix works the matrix on a 0-255 colour, clamped', () => {
    expect(applyMatrix([100, 100, 100], colorMatrix({ ...NO_ADJUST, brightness: 50 }))).toEqual([151, 151, 151]);
    expect(applyMatrix([250, 10, 10], colorMatrix({ ...NO_ADJUST, brightness: 100 }))).toEqual([255, 112, 112]);
    const grey = applyMatrix([200, 40, 40], colorMatrix({ ...NO_ADJUST, saturation: -100 }));
    expect(grey[0]).toBe(grey[1]);
    expect(grey[1]).toBe(grey[2]);
  });

  it('svgMatrixValues is the 4 x 5 matrix feColorMatrix takes, alpha unchanged', () => {
    const v = svgMatrixValues(colorMatrix({ ...NO_ADJUST, brightness: 50 })).split(' ').map(Number);
    expect(v).toHaveLength(20);
    close(v, [1, 0, 0, 0, 0.2, 0, 1, 0, 0, 0.2, 0, 0, 1, 0, 0.2, 0, 0, 0, 1, 0]);
  });

  it('isNoAdjust', () => {
    expect(isNoAdjust(NO_ADJUST)).toBe(true);
    expect(isNoAdjust(undefined)).toBe(true);
    expect(isNoAdjust({ ...NO_ADJUST, contrast: 1 })).toBe(false);
  });
});

describe('autoAdjust', () => {
  const stats = (mean: number[], stdev: number[]) => ({ mean: mean as [number, number, number], stdev: stdev as [number, number, number] });
  const limited = (a: Adjust, max = 100) => {
    for (const v of Object.values(a)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(max);
    }
  };

  it('brightens a dark photo', () => {
    expect(autoAdjust(stats([40, 42, 45], [55, 55, 55])).brightness).toBeGreaterThan(0);
  });

  it('adds contrast to a flat photo', () => {
    expect(autoAdjust(stats([118, 118, 118], [10, 10, 10])).contrast).toBeGreaterThan(0);
  });

  it('warms a blue cast', () => {
    expect(autoAdjust(stats([100, 118, 150], [55, 55, 55])).warmth).toBeGreaterThan(0);
  });

  it('a black or white photo gives finite numbers, each change at most 60', () => {
    limited(autoAdjust(stats([0, 0, 0], [0, 0, 0])), 60);
    limited(autoAdjust(stats([255, 255, 255], [0, 0, 0])), 60);
  });

  it('a balanced photo needs nothing', () => {
    expect(autoAdjust(stats([118, 118, 118], [55, 55, 55]))).toEqual({ brightness: 0, contrast: 0, saturation: 0, warmth: 0 });
  });
});
