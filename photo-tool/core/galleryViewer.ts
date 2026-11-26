// The gallery's full-screen viewer and the grid's selection, free of any UI.

export interface ViewerStep {
  index: number;
  action?: 'star' | 'hide' | 'details' | 'close';
}

/** What a key does in the viewer showing photo `index` of `count`: Left/Right move (stopping at the ends), S or F stars (favourite), H hides, I shows details, Esc closes. */
export function viewerStep(index: number, count: number, key: string): ViewerStep {
  switch (key) {
    case 'ArrowRight':
      return { index: Math.max(0, Math.min(index + 1, count - 1)) };
    case 'ArrowLeft':
      return { index: Math.max(0, index - 1) };
    case 's':
    case 'S':
    case 'f':
    case 'F':
      return { index, action: 'star' };
    case 'h':
    case 'H':
      return { index, action: 'hide' };
    case 'i':
    case 'I':
      return { index, action: 'details' };
    case 'Escape':
      return { index, action: 'close' };
    default:
      return { index };
  }
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

/** Where a key moves the grid's selection from `index` (Left/Right by one, Up/Down by a row of `cols`, Home/End to the ends), kept inside the list; null for other keys or an empty list. */
export function gridStep(index: number, count: number, cols: number, key: string): number | null {
  if (count <= 0) return null;
  const to = (i: number) => Math.max(0, Math.min(i, count - 1));
  switch (key) {
    case 'ArrowLeft':
      return to(index - 1);
    case 'ArrowRight':
      return to(index + 1);
    case 'ArrowUp':
      return to(index - cols);
    case 'ArrowDown':
      return to(index + cols);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** The photos a flag key (star, hide) changes and the value to give them: the whole selection when the selected photo is one of several, else just it; null when nothing is selected. */
export function flagTargets(selection: readonly string[], selected: string | null, current: (path: string) => boolean): { paths: string[]; value: boolean } | null {
  if (selected === null) return null;
  const paths = selection.length >= 2 && selection.includes(selected) ? [...selection] : [selected];
  return { paths, value: !current(selected) };
}

/**
 * The photo to select once some photos are gone (deleted, hidden, folded away): the same one if it is
 * still there, else the photo now in its place (the photos before it that stayed keep their places, so
 * that is `after[k]`, k = how many of them stayed), else the last one, else none. By place rather than
 * by "the next photo of `before`": a photo can come in as another leaves (a stack's new face), and it
 * belongs in the gap.
 */
export function nextAfterRemoval(before: readonly string[], after: readonly string[], selected: string | null): string | null {
  if (selected === null || after.length === 0) return null;
  const left = new Set(after);
  if (left.has(selected)) return selected;
  const at = before.indexOf(selected);
  if (at < 0) return null;
  let k = 0;
  for (let i = 0; i < at; i++) if (left.has(before[i])) k++;
  return after[Math.min(k, after.length - 1)];
}
