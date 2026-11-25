import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { dragPaths } from '../../../core/galleryViewer';
import { desktop } from '../../../web/desktop';
import { gridWindow } from '../../../web/virtualGrid';
import { isIdentityEdit } from '../../../core/photoEdit';
import { selectMeaningStart, selectScores, selectVisible, shownEdit, useGallery, useStackInfo, useVisibleItems } from '../store';
import { Tile } from './Tile';

const GAP = 6;

const scoreOf = (s: { total: number; analysed: boolean } | undefined) => (s?.analysed ? s.total : null);
/** The grid's padding (px), matching .gallery-grid in gallery.css. */
const PAD = 12;

/** What dragging this tile takes: every selected photo (in grid order) when it is selected, else just it. */
function dragList(path: string): string[] {
  const s = useGallery.getState();
  return dragPaths(selectVisible(s).map((i) => i.path), s.selection, path);
}

/**
 * The photos of the open folder. Only the rows on screen (and a couple either side) are drawn, so a
 * folder of thousands of photos scrolls smoothly. The review keys live in useReviewKeys; the grid tells
 * the store how many tiles fit in a row (for Up/Down) and keeps the selected photo in view.
 */
export function Grid({ onOpen, onContextMenu }: { onOpen: (path: string) => void; onContextMenu?: (path: string, e: MouseEvent) => void }) {
  const items = useVisibleItems();
  const stacks = useStackInfo();
  const thumbSize = useGallery((s) => s.thumbSize);
  const selected = useGallery((s) => s.selected);
  const selection = useGallery((s) => s.selection);
  // Edits shown on the tiles (unsaved, else saved): a photo without one keeps the plain thumbnail.
  const pendingEdits = useGallery((s) => s.pendingEdits);
  const editTarget = useGallery((s) => s.editTarget);
  // Each tile shows its photo score (a whole number; null until the photo is analysed).
  const scores = useGallery(selectScores);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ width: Math.max(0, el.clientWidth - 2 * PAD), height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // A new order or filter starts at the top (a star or an info refresh changes neither).
  const sort = useGallery((s) => s.sort);
  const filter = useGallery((s) => s.filter);
  const shownOrder = useRef({ sort, filter });
  useLayoutEffect(() => {
    if (shownOrder.current.sort === sort && shownOrder.current.filter === filter) return;
    shownOrder.current = { sort, filter };
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [sort, filter]);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(Math.max(0, (ref.current?.scrollTop ?? 0) - PAD)));
  };

  const onSelect = useCallback((path: string, mods: { ctrl: boolean; shift: boolean }) => useGallery.getState().clickSelect(path, mods), []);
  const onStar = useCallback((path: string, star: boolean) => void useGallery.getState().setStar(path, star), []);
  const onToggleStack = useCallback((id: string) => useGallery.getState().toggleStack(id), []);
  // The files are worked out when the button goes down (so the desktop app can check them before the
  // drag) and again on dragstart: the same rule, so the same list unless the selection changed.
  const onDragReady = useCallback((path: string) => desktop?.prepareDrag?.(dragList(path)), []);
  const onDragOut = useCallback((path: string) => desktop?.startDrag?.(dragList(path)), []);

  // The photos found only by meaning start on a new row, after a row with a note: their slots are moved on by `pad`.
  const meaningStart = useGallery(selectMeaningStart);
  const view = { width: box.width, tile: thumbSize, gap: GAP, scrollTop, viewport: box.height };
  const cols = gridWindow({ ...view, count: items.length }).cols;
  const pad = meaningStart === null ? 0 : ((cols - (meaningStart % cols)) % cols) + cols;
  const slotOf = (i: number) => (meaningStart !== null && i >= meaningStart ? i + pad : i);
  const w = gridWindow({ ...view, count: items.length + pad });
  const stride = w.rowHeight + GAP;

  // Up/Down step by a row: the keys (outside the grid) read how many tiles a row holds now.
  useEffect(() => useGallery.getState().setGridCols(w.cols), [w.cols]);
  // Without the grid (the map shows instead) Up/Down step one photo, like Left/Right.
  useEffect(() => () => useGallery.getState().setGridCols(1), []);

  /** Scroll the grid just enough to show the selected photo's row (nothing when it is in view already). */
  const scrollToSelected = () => {
    const el = ref.current;
    if (!el) return;
    const i = items.findIndex((item) => item.path === useGallery.getState().selected);
    if (i < 0) return;
    const top = PAD + Math.floor(slotOf(i) / w.cols) * stride;
    const bottom = top + w.rowHeight + PAD;
    if (top - PAD < el.scrollTop) el.scrollTop = top - PAD;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    else return;
    setScrollTop(Math.max(0, el.scrollTop - PAD));
  };

  // Another photo selected (a key, the viewer closing on the last photo it showed, H moving on) or the
  // viewer closed, or the rows reflowed: keep the selected photo in view.
  const viewing = useGallery((s) => s.viewing);
  useLayoutEffect(() => {
    if (viewing === null) scrollToSelected();
  }, [selected, viewing, w.cols]);

  const picked = useMemo(() => new Set(selection), [selection]);
  const tiles = [];
  for (let slot = w.firstIndex; slot <= w.lastIndex; slot++) {
    if (meaningStart !== null && slot >= meaningStart && slot < meaningStart + pad) continue;
    const i = meaningStart !== null && slot >= meaningStart ? slot - pad : slot;
    const item = items[i];
    const edit = shownEdit({ pendingEdits, editTarget }, item);
    tiles.push(
      <Tile
        key={item.path}
        item={item}
        x={(slot % w.cols) * stride}
        y={Math.floor(slot / w.cols) * stride}
        size={w.rowHeight}
        selected={item.path === selected}
        picked={picked.has(item.path)}
        hidden={item.info.hidden === true}
        stack={stacks.get(item.path)}
        edit={edit && !isIdentityEdit(edit) ? edit : null}
        unsaved={item.path in pendingEdits}
        score={scoreOf(scores.get(item.path))}
        onSelect={onSelect}
        onStar={onStar}
        onToggleStack={onToggleStack}
        onOpen={onOpen}
        onDragReady={onDragReady}
        onDragOut={onDragOut}
        onContextMenu={onContextMenu}
      />,
    );
  }

  return (
    <div className="gallery-grid" ref={ref} onScroll={onScroll}>
      <div className="gallery-grid-inner" style={{ height: w.totalHeight }}>
        {tiles}
        {meaningStart !== null && (
          <div className="gallery-grid-note muted" role="note" style={{ top: ((meaningStart + pad) / w.cols - 1) * stride, height: w.rowHeight }}>
            Also matching by meaning
          </div>
        )}
      </div>
    </div>
  );
}
