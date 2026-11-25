import { describe, expect, it } from 'vitest';
import { pageLimitWarning, pagesForStarred } from '../web/components/draftPages';

describe('pageLimitWarning', () => {
  const bind = { name: 'Hardcover', minPages: 24, maxPages: 240 };
  it('warns about the target', () => {
    expect(pageLimitWarning('Lulu', bind, 20)).toBe('Lulu Hardcover needs at least 24 pages.');
    expect(pageLimitWarning('Lulu', bind, 250)).toBe('Lulu Hardcover allows at most 240 pages.');
    expect(pageLimitWarning('Lulu', bind, 100)).toBeNull();
  });
  it('warns when a draft grew the book past the maximum, even with a smaller target', () => {
    expect(pageLimitWarning('Lulu', bind, 100, 260)).toBe('Lulu Hardcover allows at most 240 pages. The draft now has 260.');
    expect(pageLimitWarning('Lulu', bind, 100, 200)).toBeNull();
  });
  it('without limits, never warns', () => expect(pageLimitWarning('Custom', { name: 'Any' }, 900, 900)).toBeNull());
});

describe('pagesForStarred', () => {
  it('keeps the target when the photos fit', () => expect(pagesForStarred(40, 20, 7)).toBe(20));
  it('grows to the smallest even page count that fits, plus title and closing pages', () => {
    const need = Math.ceil(200 / 7) + 2;
    const want = need % 2 ? need + 1 : need;
    expect(pagesForStarred(200, 20, 7)).toBe(want);
  });
  it('keeps the target with no photos', () => expect(pagesForStarred(0, 20, 7)).toBe(20));
  it('never goes below the target', () => expect(pagesForStarred(3, 20, 2)).toBe(20));
});
