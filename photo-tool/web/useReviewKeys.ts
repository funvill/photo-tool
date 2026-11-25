import { useEffect } from 'react';
import { gridStep } from '../core/galleryViewer';
import { selectablePaths, selectFiltered, selectVisible, useGallery } from './store';

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
 * Left/Right, Home and End move the selection through the shown list; Up and Down nudge the photo score
 * of the selected photo (every selected one when several are) by +1 / −1; F favourites (stars) and H
 * hides the same photos; Enter or Space opens the selected photo in the viewer; E opens edit mode on it;
 * Ctrl+Z undoes the last change. Not while typing (Ctrl+Z there is the field's own), while the viewer or a
 * dialog is open, or while a photo is being edited (edit mode has its own keys); no other key with Ctrl,
 * Alt or Meta held.
 */
export function useReviewKeys(onOpen: (path: string) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = useGallery.getState();
      if (s.viewing !== null || s.tidyOpen || s.settingsOpen || s.leaving !== null || s.editing !== null) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        if (inside(e, TYPING)) return;
        e.preventDefault();
        void s.undo();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      if (e.key === 'Enter' || e.key === ' ') {
        if (e.repeat || !s.selected || inside(e, PRESSABLE)) return;
        // On the map the selected photo may be folded into a stack: the viewer unfolds it.
        if (!selectablePaths(s).includes(s.selected)) return;
        e.preventDefault();
        onOpen(s.selected);
        return;
      }
      if (inside(e, TYPING)) return;

      if (e.key === 'e' || e.key === 'E') {
        // Only a photo the preview shows (one the scan has read, not filtered out).
        const path = s.selected;
        if (path === null || !selectFiltered(s).some((i) => i.path === path)) return;
        e.preventDefault();
        if (!e.repeat) s.startEdit(path);
        return;
      }

      const flag = e.key === 'f' || e.key === 'F' ? 'star' : e.key === 'h' || e.key === 'H' ? 'hidden' : null;
      if (flag) {
        e.preventDefault();
        if (!e.repeat) void s.toggleFlag(flag);
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (s.selected === null && s.selection.length === 0) return;
        e.preventDefault();
        // One press, one point: a held key does not repeat (each tap is its own write and undo step).
        if (!e.repeat) s.nudgeScore(e.key === 'ArrowUp' ? 1 : -1);
        return;
      }

      const list = selectVisible(s);
      const place = stepFrom(list, selectFiltered(s), s.selected);
      let at = place.at;
      if (place.before !== undefined) {
        // Between two shown photos: back lands on the one before, forward on the one after.
        const back = e.key === 'ArrowLeft';
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
