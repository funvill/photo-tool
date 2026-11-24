import { useEffect } from 'react';
import { gridStep } from '../../core/galleryViewer';
import { selectFiltered, selectVisible, useGallery } from './store';

/** Where keys belong to what has focus (typing, a menu, a dialog), not to the review. */
const TYPING = 'input, textarea, select, [contenteditable="true"], [role="dialog"]';
/** Enter and Space also press a focused button or follow a link. */
const PRESSABLE = `${TYPING}, button, a`;

const inside = (e: KeyboardEvent, selector: string) => !!(e.target as HTMLElement | null)?.closest?.(selector);

/**
 * Where in the shown list the keys step from: the selected photo's place, or -1 when it is not shown.
 * A photo folded into a stack (it can be picked on the map) sits just after the nearest shown photo
 * before it in the unfolded order: `before` is that photo's place (-1: none).
 */
function stepFrom(list: { path: string }[], unfolded: { path: string }[], selected: string | null): { at: number; before?: number } {
  if (selected === null) return { at: -1 };
  const at = list.findIndex((i) => i.path === selected);
  if (at >= 0) return { at };
  const k0 = unfolded.findIndex((i) => i.path === selected);
  if (k0 < 0) return { at: -1 };
  const shown = new Map(list.map((i, n) => [i.path, n]));
  for (let k = k0 - 1; k >= 0; k--) {
    const n = shown.get(unfolded[k].path);
    if (n !== undefined) return { at: -1, before: n };
  }
  return { at: -1, before: -1 };
}

/**
 * The review keys, one window listener for the whole screen (it works whichever view shows the photos):
 * arrows, Home and End move the selection through the shown list (Up/Down by a row of the grid);
 * F favourites (stars) and H hides the selected photo, every selected one when several are; Enter or
 * Space opens the selected photo in the viewer. Not while typing, while the viewer or the tidy dialog
 * is open, or with Ctrl, Alt or Meta held.
 */
export function useReviewKeys(onOpen: (path: string) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      const s = useGallery.getState();
      if (s.viewing !== null || s.tidyOpen) return;

      if (e.key === 'Enter' || e.key === ' ') {
        if (e.repeat || !s.selected || inside(e, PRESSABLE)) return;
        if (!selectVisible(s).some((i) => i.path === s.selected)) return;
        e.preventDefault();
        onOpen(s.selected);
        return;
      }
      if (inside(e, TYPING)) return;

      const flag = e.key === 'f' || e.key === 'F' ? 'star' : e.key === 'h' || e.key === 'H' ? 'hidden' : null;
      if (flag) {
        e.preventDefault();
        if (!e.repeat) void s.toggleFlag(flag);
        return;
      }

      const list = selectVisible(s);
      const place = stepFrom(list, selectFiltered(s), s.selected);
      let at = place.at;
      if (place.before !== undefined) {
        // Between two shown photos: back lands on the one before, forward on the one after.
        const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
        at = back ? place.before + 1 : place.before;
      }
      const to = gridStep(Math.max(0, at), list.length, s.gridCols, e.key);
      if (to === null) return;
      e.preventDefault();
      // Nothing (shown) selected yet: the first key lands on the first photo, End on the last.
      const index = at < 0 ? (e.key === 'End' ? list.length - 1 : 0) : to;
      if (list[index].path !== s.selected || s.selection.length !== 1) s.select(list[index].path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}
