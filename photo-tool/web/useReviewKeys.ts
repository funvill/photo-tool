import { useEffect } from 'react';
import { gridStep } from '../core/galleryViewer';
import { canCopyPhotos, selectablePaths, selectFiltered, selectVisible, useGallery } from './store';
import { matchShortcut, type ShortcutPlace } from './shortcuts';

/** Where keys belong to what has focus (typing, a menu, a dialog), not to the review. */
const TYPING = 'input, textarea, select, [contenteditable="true"], [role="dialog"]';
/** Enter and Space also press a focused button or follow a link. */
const PRESSABLE = `${TYPING}, button, a`;

const inside = (e: KeyboardEvent, selector: string) => !!(e.target as HTMLElement | null)?.closest?.(selector);

/** Where the review keys are pressed: the timeline has a list of its own (it steps in date order), the grid and the map share the grid's. */
export const reviewPlace = (view: string): ShortcutPlace => (view === 'timeline' ? 'timeline' : 'grid');

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
 * The review keys, one window listener for the whole screen (it works whichever view shows the photos).
 * Which key does what is the shortcut table's (shortcuts.ts, place 'grid', or 'timeline' while the timeline
 * shows), the same table the ? list shows: Left/Right, Home and End move the selection through the shown
 * list (in date order in the timeline); Up and Down nudge the photo
 * score of the selected photo (every selected one when several are) by +1 / −1; F favourites (stars) and
 * H hides the same photos; Enter or Space opens the selected photo in the viewer; E opens edit mode on it;
 * [ and ] turn the selected photos a quarter anticlockwise or clockwise (an unsaved edit, as Done in edit
 * mode leaves one); Delete sends the selected photos to the Recycle Bin (after the desktop app's confirm);
 * Ctrl+A selects every shown photo and Ctrl+D none; Ctrl+C copies the selected photos (desktop app);
 * Ctrl+Z undoes the last change; ? shows the list of keys. Not while typing (Ctrl+Z there is the field's
 * own), while the viewer, the list of keys or a dialog is open, or while a photo is being edited (edit
 * mode has its own keys).
 */
export function useReviewKeys(onOpen: (path: string) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = useGallery.getState();
      if (s.viewing !== null || s.tidyOpen || s.settingsOpen || s.shortcutsOpen || s.leaving !== null || s.editing !== null) return;
      const id = matchShortcut(reviewPlace(s.view), e);
      if (id === null) return;
      if (id === 'undo') {
        if (inside(e, TYPING)) return;
        e.preventDefault();
        void s.undo();
        return;
      }
      // Ctrl+A selects every shown photo, Ctrl+D none. In a field they stay the field's own.
      if (id === 'select-all' || id === 'select-none') {
        if (inside(e, TYPING)) return;
        e.preventDefault();
        if (id === 'select-all') s.selectAll();
        else s.selectNone();
        return;
      }
      // Ctrl+C copies the selected photos (desktop app only). Selected text, or a field, keeps its own copy.
      if (id === 'copy') {
        if (inside(e, TYPING) || !canCopyPhotos() || (window.getSelection()?.toString() ?? '') !== '') return;
        e.preventDefault();
        if (!e.repeat) void s.copySelected();
        return;
      }

      if (id === 'open') {
        if (e.repeat || !s.selected || inside(e, PRESSABLE)) return;
        // On the map the selected photo may be folded into a stack: the viewer unfolds it.
        if (!selectablePaths(s).includes(s.selected)) return;
        e.preventDefault();
        onOpen(s.selected);
        return;
      }
      if (inside(e, TYPING)) return;

      switch (id) {
        case 'shortcuts':
          e.preventDefault();
          if (!e.repeat) s.toggleShortcuts();
          return;
        case 'edit': {
          // Only a photo the preview shows (one the scan has read, not filtered out).
          const path = s.selected;
          if (path === null || !selectFiltered(s).some((i) => i.path === path)) return;
          e.preventDefault();
          if (!e.repeat) s.startEdit(path);
          return;
        }
        // [ and ] turn the selected photos anticlockwise and clockwise, as an unsaved edit. One press, one turn.
        case 'rotate-left':
        case 'rotate-right':
          e.preventDefault();
          if (!e.repeat) s.turnSelected(id === 'rotate-left' ? 'left' : 'right');
          return;
        case 'delete':
          e.preventDefault();
          if (!e.repeat) void s.trashSelected();
          return;
        case 'favourite':
        case 'hide':
          e.preventDefault();
          if (!e.repeat) void s.toggleFlag(id === 'favourite' ? 'star' : 'hidden');
          return;
        case 'score':
          if (s.selected === null && s.selection.length === 0) return;
          e.preventDefault();
          // One press, one point: a held key does not repeat (each tap is its own write and undo step).
          if (!e.repeat) s.nudgeScore(e.key === 'ArrowUp' ? 1 : -1);
          return;
        // In the timeline the shown list is in date order (the store's), so the same steps go through it in that order.
        case 'move':
        case 'first-last':
        case 'timeline-move':
        case 'timeline-first-last':
          break;
        default:
          // \ (hold to see the original) is useOriginalKey's.
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

/** As TYPING, but a slider keeps no keys for itself: \ and ? work straight after moving one from the keyboard. */
const TYPING_TEXT = 'input:not([type="range"]), textarea, select, [contenteditable="true"], [role="dialog"]';

/**
 * Hold \ (backslash) to see the photo with no edit at all, in the preview and in edit mode (the store's
 * showOriginal). Let go, or leave the window, and the edit shows again; nothing changes. Not while typing,
 * nor in the viewer (it always shows the photo unedited) or a dialog. The key let go is matched by its
 * code, so pressing Shift while holding it cannot leave the original showing.
 */
export function useOriginalKey() {
  useEffect(() => {
    let held: string | null = null;
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = useGallery.getState();
      if (s.viewing !== null || s.tidyOpen || s.settingsOpen || s.shortcutsOpen || s.leaving !== null) return;
      if (matchShortcut(s.editing !== null ? 'edit' : reviewPlace(s.view), e) !== 'original' || inside(e, TYPING_TEXT)) return;
      e.preventDefault();
      held = e.code;
      s.setShowOriginal(true);
    };
    const up = (e: KeyboardEvent) => {
      if (held === null || (e.code !== held && e.key !== '\\')) return;
      held = null;
      useGallery.getState().setShowOriginal(false);
    };
    const leave = () => {
      held = null;
      useGallery.getState().setShowOriginal(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', leave);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', leave);
      leave();
    };
  }, []);
}
