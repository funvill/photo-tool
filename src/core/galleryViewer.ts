// The gallery's full-screen viewer and the grid's selection, free of any UI.

export interface ViewerStep {
  index: number;
  action?: 'star' | 'details' | 'close';
}

/** What a key does in the viewer showing photo `index` of `count`: Left/Right move (stopping at the ends), S stars, I shows details, Esc closes. */
export function viewerStep(index: number, count: number, key: string): ViewerStep {
  switch (key) {
    case 'ArrowRight':
      return { index: Math.max(0, Math.min(index + 1, count - 1)) };
    case 'ArrowLeft':
      return { index: Math.max(0, index - 1) };
    case 's':
    case 'S':
      return { index, action: 'star' };
    case 'i':
    case 'I':
      return { index, action: 'details' };
    case 'Escape':
      return { index, action: 'close' };
    default:
      return { index };
  }
}

/** The photos to load ahead of time: the next two, then the previous two, those that exist. */
export function viewerNeighbours(index: number, count: number): number[] {
  return [index + 1, index + 2, index - 1, index - 2].filter((i) => i >= 0 && i < count);
}

export interface GallerySelection {
  /** The photo the details panel shows. */
  selected: string | null;
  /** Every selected photo, in grid order (what a drag takes). */
  selection: string[];
  /** Where a Shift-click range starts: the last plain or Ctrl click. */
  anchor: string | null;
}

/**
 * A click on photo `path` of the grid (`visible`, in grid order): a plain click selects just it, Ctrl
 * toggles it in or out, Shift selects the range from the anchor to it (Ctrl+Shift adds that range).
 */
export function clickSelect(visible: readonly string[], s: GallerySelection, path: string, mods: { ctrl?: boolean; shift?: boolean }): GallerySelection {
  const inOrder = (paths: Set<string>) => visible.filter((p) => paths.has(p));
  const from = s.anchor === null ? -1 : visible.indexOf(s.anchor);
  const to = visible.indexOf(path);
  if (mods.shift && from >= 0 && to >= 0) {
    const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
    const selection = mods.ctrl ? inOrder(new Set([...s.selection, ...range])) : range;
    return { selected: path, selection, anchor: s.anchor };
  }
  if (mods.ctrl) {
    const set = new Set(s.selection);
    if (set.delete(path)) {
      const selection = inOrder(set);
      return { selected: s.selected === path ? (selection.at(-1) ?? null) : s.selected, selection, anchor: path };
    }
    set.add(path);
    return { selected: path, selection: inOrder(set), anchor: path };
  }
  return { selected: path, selection: [path], anchor: path };
}

/** What dragging photo `dragged` takes: every selected photo in grid order when it is one of them, else just it. */
export function dragPaths(visible: readonly string[], selection: readonly string[], dragged: string): string[] {
  if (!selection.includes(dragged)) return [dragged];
  const set = new Set(selection);
  return visible.filter((p) => set.has(p));
}
