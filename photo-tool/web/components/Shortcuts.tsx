import { ShortcutOverlay } from '../../../shared/web/components/ShortcutOverlay';
import { desktop } from '../../../shared/web/desktop';
import { PLACE_TITLES, shortcutsFor, type ShortcutPlace } from '../shortcuts';
import { useGallery } from '../store';

/** The ? list of keys, for where you are: the viewer, edit mode, or the grid and preview (shortcuts.ts). */
export function Shortcuts() {
  const open = useGallery((s) => s.shortcutsOpen);
  const place: ShortcutPlace = useGallery((s) => (s.viewing !== null ? 'viewer' : s.editing !== null ? 'edit' : 'grid'));
  if (!open) return null;
  // The desktop app's own keys (Delete, Ctrl+C, F1, F2, Ctrl+O) only where they work.
  const rows = shortcutsFor(place, { desktop: !!desktop });
  return <ShortcutOverlay groups={[{ title: PLACE_TITLES[place], rows }]} onClose={() => useGallery.getState().toggleShortcuts(false)} />;
}
