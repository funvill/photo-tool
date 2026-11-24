import { describe, expect, it } from 'vitest';
import { aspectRatio, formatAperture, formatBias, formatFocal, formatShutter, megapixels } from '../src/core';

describe('photo fact formatters', () => {
  it('formats shutter speeds', () => {
    expect(formatShutter(0.004)).toBe('1/250 s');
    expect(formatShutter(0.5)).toBe('1/2 s');
    expect(formatShutter(2)).toBe('2 s');
    expect(formatShutter(1.3)).toBe('1.3 s');
  });
  it('formats apertures', () => {
    expect(formatAperture(2.8)).toBe('f/2.8');
    expect(formatAperture(8)).toBe('f/8');
  });
  it('formats focal lengths', () => {
    expect(formatFocal(35)).toBe('35 mm');
    expect(formatFocal(35, 35.4)).toBe('35 mm');
    expect(formatFocal(35, 52)).toBe('35 mm (52 mm in 35 mm terms)');
  });
  it('formats exposure bias', () => {
    expect(formatBias(0.7)).toBe('+0.7 EV');
    expect(formatBias(-1)).toBe('\u22121 EV');
    expect(formatBias(0)).toBe('0 EV');
  });
  it('formats megapixels', () => {
    expect(megapixels(4000, 3000)).toBe('12.0 MP');
    expect(megapixels(4032, 3024)).toBe('12.2 MP');
  });
  it('names the aspect ratio, long side first', () => {
    expect(aspectRatio(4000, 3000)).toBe('4:3');
    expect(aspectRatio(3000, 4000)).toBe('4:3');
    expect(aspectRatio(1000, 1000)).toBe('1:1');
    expect(aspectRatio(1920, 1080)).toBe('16:9');
    expect(aspectRatio(1000, 618)).toBe('1.62:1');
  });
});
