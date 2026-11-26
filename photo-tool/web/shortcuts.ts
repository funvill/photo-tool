// Photo Tool's keyboard shortcuts: one table that the key handlers (useReviewKeys, the viewer, edit
// mode, the hold-to-see-the-original key) and the ? overlay all read, so a key that changes cannot leave
// the overlay wrong. A handler asks `matchShortcut(place, e)` and acts on the id it gets back; it never
// looks at a key name of its own.

/** Where the keys are pressed: the grid or the timeline with the preview, the full-screen viewer, or edit mode. */
export type ShortcutPlace = 'grid' | 'timeline' | 'viewer' | 'edit';

/** The parts of a KeyboardEvent a shortcut looks at. */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface Shortcut {
  id: string;
  /** The keys as shown, one string per alternative (['←', '→']), a combination joined by + ('Ctrl+Z'). */
  keys: string[];
  /** What it does, in a few words. */
  does: string;
  places: readonly ShortcutPlace[];
  matches(e: KeyLike): boolean;
  /** Only in the desktop app (it needs the app: the Recycle Bin, the clipboard, a menu). */
  desktop?: boolean;
  /** A menu item's accelerator (the desktop app's menu acts on it, no page handler): listed, never matched. */
  menu?: boolean;
}

const noMods = (e: KeyLike) => !e.ctrlKey && !e.metaKey && !e.altKey;
/** One of these keys, with no Ctrl, Alt or Meta (Shift may be held: F and Shift+F both favourite). */
const plain = (...keys: string[]) => (e: KeyLike) => noMods(e) && keys.includes(e.key);
/** Ctrl (Cmd on a Mac) and this letter, nothing else held. */
const ctrl = (letter: string) => (e: KeyLike) => (!!e.ctrlKey || !!e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === letter;
const never = () => false;

const TABLE = [
  // Everywhere.
  { id: 'shortcuts', keys: ['?'], does: 'Show or hide this list of keys', places: ['grid', 'timeline', 'viewer', 'edit'], matches: (e: KeyLike) => noMods(e) && e.key === '?' },
  { id: 'about', keys: ['F1'], does: 'About Photo Tool', places: ['grid', 'timeline', 'viewer', 'edit'], matches: never, desktop: true, menu: true },
  { id: 'feedback', keys: ['F2'], does: 'Send feedback on GitHub', places: ['grid', 'timeline', 'viewer', 'edit'], matches: never, desktop: true, menu: true },

  // The grid (or the timeline) and the preview. The timeline steps through the photos in date order.
  { id: 'move', keys: ['←', '→'], does: 'Previous or next photo', places: ['grid', 'viewer'], matches: plain('ArrowLeft', 'ArrowRight') },
  { id: 'timeline-move', keys: ['←', '→'], does: 'Previous or next photo, in date order', places: ['timeline'], matches: plain('ArrowLeft', 'ArrowRight') },
  { id: 'first-last', keys: ['Home', 'End'], does: 'First or last photo', places: ['grid'], matches: plain('Home', 'End') },
  { id: 'timeline-first-last', keys: ['Home', 'End'], does: 'Oldest or newest photo', places: ['timeline'], matches: plain('Home', 'End') },
  { id: 'score', keys: ['↑', '↓'], does: 'Photo score up or down', places: ['grid', 'timeline'], matches: plain('ArrowUp', 'ArrowDown') },
  { id: 'favourite', keys: ['F'], does: 'Favourite or unfavourite', places: ['grid', 'timeline'], matches: plain('f', 'F') },
  { id: 'hide', keys: ['H'], does: 'Hide or unhide', places: ['grid', 'timeline', 'viewer'], matches: plain('h', 'H') },
  { id: 'open', keys: ['Enter', 'Space'], does: 'Open in the full-screen viewer', places: ['grid', 'timeline'], matches: plain('Enter', ' ') },
  { id: 'edit', keys: ['E'], does: 'Edit: crop, rotate, light and colour', places: ['grid', 'timeline'], matches: plain('e', 'E') },
  { id: 'rotate-left', keys: ['['], does: 'Rotate anticlockwise', places: ['grid', 'timeline'], matches: plain('[') },
  { id: 'rotate-right', keys: [']'], does: 'Rotate clockwise', places: ['grid', 'timeline'], matches: plain(']') },
  { id: 'original', keys: ['\\'], does: 'Hold to see the original', places: ['grid', 'timeline', 'edit'], matches: plain('\\') },
  { id: 'delete', keys: ['Delete'], does: 'Move to the Recycle Bin', places: ['grid', 'timeline'], matches: (e: KeyLike) => noMods(e) && !e.shiftKey && e.key === 'Delete', desktop: true },
  { id: 'select-all', keys: ['Ctrl+A'], does: 'Select every shown photo', places: ['grid', 'timeline'], matches: ctrl('a') },
  { id: 'select-none', keys: ['Ctrl+D'], does: 'Select none', places: ['grid', 'timeline'], matches: ctrl('d') },
  { id: 'copy', keys: ['Ctrl+C'], does: 'Copy: one photo as a picture, several as files', places: ['grid', 'timeline'], matches: ctrl('c'), desktop: true },
  { id: 'undo', keys: ['Ctrl+Z'], does: 'Undo', places: ['grid', 'timeline'], matches: ctrl('z') },
  { id: 'open-folder', keys: ['Ctrl+O'], does: 'Open a folder', places: ['grid', 'timeline'], matches: never, desktop: true, menu: true },

  // The full-screen viewer.
  { id: 'viewer-favourite', keys: ['F', 'S'], does: 'Favourite or unfavourite', places: ['viewer'], matches: plain('f', 'F', 's', 'S') },
  { id: 'details', keys: ['I'], does: 'Show or hide details', places: ['viewer'], matches: plain('i', 'I') },
  { id: 'close', keys: ['Esc'], does: 'Close the viewer', places: ['viewer'], matches: plain('Escape') },

  // Edit mode.
  { id: 'edit-rotate', keys: ['R'], does: 'Rotate a quarter turn', places: ['edit'], matches: plain('r', 'R') },
  { id: 'edit-done', keys: ['Enter'], does: 'Done (keeps the edit, not saved yet)', places: ['edit'], matches: plain('Enter') },
  { id: 'edit-cancel', keys: ['Esc'], does: 'Cancel the edit', places: ['edit'], matches: plain('Escape') },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof TABLE)[number]['id'];

export const SHORTCUTS: readonly (Shortcut & { id: ShortcutId })[] = TABLE;

/** The rows for one place, in the table's order. Without the desktop app, its own rows are left out. */
export function shortcutsFor(place: ShortcutPlace, o: { desktop?: boolean } = {}): (Shortcut & { id: ShortcutId })[] {
  return SHORTCUTS.filter((s) => s.places.includes(place) && (o.desktop !== false || !s.desktop));
}

/** The shortcut this key press is in this place, or null. Menu accelerators are the menu's, never matched here. */
export function matchShortcut(place: ShortcutPlace, e: KeyLike): ShortcutId | null {
  for (const s of SHORTCUTS) if (!s.menu && s.places.includes(place) && s.matches(e)) return s.id;
  return null;
}

/** A shortcut's key as a menu shows it beside the item: its first alternative. */
export function keyHint(id: ShortcutId): string {
  return SHORTCUTS.find((s) => s.id === id)!.keys[0];
}

/** Each place's title in the overlay. */
export const PLACE_TITLES: Record<ShortcutPlace, string> = { grid: 'Grid and preview', timeline: 'Timeline and preview', viewer: 'Full-screen viewer', edit: 'Edit mode' };
