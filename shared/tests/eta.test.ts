import { describe, expect, it } from 'vitest';
import { estimateRemaining, formatRemaining } from '../web/eta';

describe('estimateRemaining', () => {
  it('is null before 5 photos', () => expect(estimateRemaining(4, 400, 0, 60_000)).toBeNull());
  it('is null before 2 seconds', () => expect(estimateRemaining(10, 400, 0, 1_500)).toBeNull());
  it('extrapolates the pace so far', () => expect(estimateRemaining(100, 400, 0, 50_000)).toBe(150));
  it('is 0 when done', () => expect(estimateRemaining(400, 400, 0, 50_000)).toBe(0));
});

describe('formatRemaining', () => {
  it('under a minute', () => expect(formatRemaining(30)).toBe('less than a minute left'));
  it('exactly a minute', () => expect(formatRemaining(60)).toBe('about 1 minute left'));
  it('rounds minutes up', () => expect(formatRemaining(61)).toBe('about 2 minutes left'));
  it('hours and minutes from 90 minutes', () => expect(formatRemaining(5400)).toBe('about 1 hour 30 minutes left'));
  it('pluralises hours', () => expect(formatRemaining(7200)).toBe('about 2 hours 0 minutes left'));
});
