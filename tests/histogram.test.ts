import { describe, expect, it } from 'vitest';
import { histogram } from '../src/core/histogram';

describe('histogram', () => {
  it('counts channels and luminance per bin, ignoring alpha', () => {
    // pure red, pure white
    const h = histogram([255, 0, 0, 0, 255, 255, 255, 255], 4);
    expect(h.r).toEqual([0, 0, 0, 2]);
    expect(h.g).toEqual([1, 0, 0, 1]);
    expect(h.b).toEqual([1, 0, 0, 1]);
    // red luminance 0.2126*255 = 54 -> bin 0; white 255 -> bin 3
    expect(h.l).toEqual([1, 0, 0, 1]);
  });
  it('defaults to 64 bins', () => {
    expect(histogram([0, 0, 0, 255]).l).toHaveLength(64);
  });
});
