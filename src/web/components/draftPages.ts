import { evenPageCount } from '../../core/book';

/**
 * Page count for a draft of `count` photos: the target, or the smallest even number of pages above
 * it that fits every photo at `maxPerPage` per page plus the title page and the closing page.
 */
export function pagesForStarred(count: number, target: number, maxPerPage: number): number {
  const need = Math.ceil(count / Math.max(1, maxPerPage)) + 2;
  return Math.max(evenPageCount(target), evenPageCount(need));
}

/**
 * The printer's page-limit warning for the Draft panel: about the target page count, and — once a
 * Generate or Update has run (`resulting`, the book's page count now) — about the pages the draft
 * actually has, which can grow past the target so every starred photo fits.
 */
export function pageLimitWarning(
  printerName: string,
  bind: { name: string; minPages?: number; maxPages?: number },
  target: number,
  resulting?: number,
): string | null {
  if (bind.minPages && target < bind.minPages) return `${printerName} ${bind.name} needs at least ${bind.minPages} pages.`;
  if (!bind.maxPages) return null;
  const tooMany = `${printerName} ${bind.name} allows at most ${bind.maxPages} pages.`;
  if (target > bind.maxPages) return tooMany;
  if (resulting !== undefined && resulting > bind.maxPages) return `${tooMany} The draft now has ${resulting}.`;
  return null;
}
