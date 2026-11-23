import { describe, expect, it } from 'vitest';
import { pagesForStarred } from '../src/web/components/draftPages';

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
