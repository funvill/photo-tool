import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HoverPreview, formatSize } from '../../../web/components/HoverPreview';
import { gridWindow } from '../../../web/virtualGrid';
import { thumbUrl, type GalleryItem } from '../api';
import { useGallery, useVisibleItems } from '../store';
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

  const onScroll = () => {
    hover.hide();
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(Math.max(0, (ref.current?.scrollTop ?? 0) - PAD)));
  };

  const onSelect = useCallback((path: string) => useGallery.getState().select(path), []);
  const onStar = useCallback((path: string, star: boolean) => void useGallery.getState().setStar(path, star), []);

  const w = gridWindow({ count: items.length, width: box.width, tile: thumbSize, gap: GAP, scrollTop, viewport: box.height });
  const stride = w.rowHeight + GAP;
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
        onSelect={onSelect}
        onStar={onStar}
        onOpen={onOpen}
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
