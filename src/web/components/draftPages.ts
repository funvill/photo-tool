import { evenPageCount } from '../../core/book';

/**
 * Page count for a draft of `count` photos: the target, or the smallest even number of pages above
 * it that fits every photo at `maxPerPage` per page plus the title page and the closing page.
 */
export function pagesForStarred(count: number, target: number, maxPerPage: number): number {
  const need = Math.ceil(count / Math.max(1, maxPerPage)) + 2;
  return Math.max(evenPageCount(target), evenPageCount(need));
}
