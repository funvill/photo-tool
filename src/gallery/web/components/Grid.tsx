import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { dragPaths } from '../../../core/galleryViewer';
import { HoverPreview, formatSize } from '../../../web/components/HoverPreview';
import { desktop } from '../../../web/desktop';
import { gridWindow } from '../../../web/virtualGrid';
import { thumbUrl, type GalleryItem } from '../api';
import { selectVisible, useGallery, useVisibleItems } from '../store';
import { Tile } from './Tile';

const GAP = 6;
/** The grid's padding (px), matching .gallery-grid in gallery.css. */
const PAD = 12;
const HOVER_DELAY_MS = 400;

/**
 * The photos of the open folder. Only the rows on screen (and a couple either side) are drawn, so a
 * folder of thousands of photos scrolls smoothly.
 */
export function Grid({ onOpen }: { onOpen: (path: string) => void }) {
  const items = useVisibleItems();
  const thumbSize = useGallery((s) => s.thumbSize);
  const selected = useGallery((s) => s.selected);
  const selection = useGallery((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef(0);
  const hover = useHoverPreview();

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
    hover.hide();
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(Math.max(0, (ref.current?.scrollTop ?? 0) - PAD)));
  };

  const onSelect = useCallback((path: string, mods: { ctrl: boolean; shift: boolean }) => useGallery.getState().clickSelect(path, mods), []);
  const onStar = useCallback((path: string, star: boolean) => void useGallery.getState().setStar(path, star), []);
  // A selected tile drags every selected photo (in grid order); any other tile drags just itself.
  const onDragOut = useCallback((path: string) => {
    const s = useGallery.getState();
    desktop?.startDrag?.(dragPaths(selectVisible(s).map((i) => i.path), s.selection, path));
  }, []);

  // Enter or Space opens the selected photo in the viewer (not while typing, or while the viewer is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Enter' && e.key !== ' ') || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      const s = useGallery.getState();
      if (s.viewing !== null || s.tidyOpen || !s.selected) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]')) return;
      if (!selectVisible(s).some((i) => i.path === s.selected)) return;
      e.preventDefault();
      onOpen(s.selected);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);

  const w = gridWindow({ count: items.length, width: box.width, tile: thumbSize, gap: GAP, scrollTop, viewport: box.height });
  const stride = w.rowHeight + GAP;

  // Closing the viewer selects the last photo it showed: scroll the grid so that photo is in view.
  const viewing = useGallery((s) => s.viewing);
  const wasViewing = useRef(viewing);
  useLayoutEffect(() => {
    const was = wasViewing.current;
    wasViewing.current = viewing;
    const el = ref.current;
    if (was === null || viewing !== null || !el) return;
    const i = items.findIndex((item) => item.path === useGallery.getState().selected);
    if (i < 0) return;
    const top = PAD + Math.floor(i / w.cols) * stride;
    const bottom = top + w.rowHeight + PAD;
    if (top - PAD < el.scrollTop) el.scrollTop = top - PAD;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    else return;
    setScrollTop(Math.max(0, el.scrollTop - PAD));
  }, [viewing]);

  const picked = useMemo(() => new Set(selection), [selection]);
  const tiles = [];
  for (let i = w.firstIndex; i <= w.lastIndex; i++) {
    const item = items[i];
    tiles.push(
      <Tile
        key={item.path}
        item={item}
        x={(i % w.cols) * stride}
        y={Math.floor(i / w.cols) * stride}
        size={w.rowHeight}
        selected={item.path === selected}
        picked={picked.has(item.path)}
        onSelect={onSelect}
        onStar={onStar}
        onOpen={onOpen}
        onDragOut={onDragOut}
        onHoverStart={hover.start}
        onHoverEnd={hover.hide}
      />,
    );
  }

  return (
    <div className="gallery-grid" ref={ref} onScroll={onScroll}>
      <div className="gallery-grid-inner" style={{ height: w.totalHeight }}>{tiles}</div>
      {hover.shown && <HoverPreview {...previewOf(hover.shown.item)} left={hover.shown.left} right={hover.shown.right} />}
    </div>
  );
}

function previewOf(item: GalleryItem) {
  const people = Array.isArray(item.info.people) ? item.info.people.filter((p) => typeof p === 'string') : [];
  return {
    src: thumbUrl(item.key, 'm'),
    title: item.relDir ? `${item.relDir}/${item.fileName}` : item.fileName,
    takenAt: item.effectiveDate,
    details: [`${item.width} × ${item.height} · ${formatSize(item.size)}`, ...(people.length ? [people.join(', ')] : [])],
  };
}

/**
 * Rest the pointer on a tile for a moment and the large (1600 px) preview opens over the half of the
 * window the pointer is not in. It closes when the pointer leaves, a button is pressed, the grid
 * scrolls or Esc is pressed.
 */
function useHoverPreview() {
  const timer = useRef<number | undefined>(undefined);
  const [shown, setShown] = useState<{ item: GalleryItem; left: number; right?: number } | null>(null);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setShown(null);
  }, []);
  const start = useCallback((path: string, el: HTMLElement) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const item = useGallery.getState().items.find((i) => i.path === path);
      if (!item || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      const half = window.innerWidth / 2;
      // HoverPreview adds 24 px on each side it is given.
      setShown(r.left + r.width / 2 < half ? { item, left: half - 24 } : { item, left: 0, right: half - 24 });
    }, HOVER_DELAY_MS);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', hide, true);
      window.clearTimeout(timer.current);
    };
  }, [hide]);

  return { shown, start, hide };
}
