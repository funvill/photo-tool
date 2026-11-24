import { useEffect } from 'react';
import { gridStep } from '../../core/galleryViewer';
import { selectVisible, useGallery } from './store';

/** Where keys belong to what has focus (typing, a menu, a dialog), not to the review. */
const TYPING = 'input, textarea, select, [contenteditable="true"], [role="dialog"]';
/** Enter and Space also press a focused button or follow a link. */
const PRESSABLE = `${TYPING}, button, a`;

const inside = (e: KeyboardEvent, selector: string) => !!(e.target as HTMLElement | null)?.closest?.(selector);

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
      const at = s.selected === null ? -1 : list.findIndex((i) => i.path === s.selected);
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
