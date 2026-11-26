import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { dragPaths } from '../../core/galleryViewer';
import { pathIndex } from '../../core/preloadWindow';
import { NO_DATE, rowOfItem, timelineLayout, timelineWindow, type TimelineGroup, type TimelineUnit } from '../../core/timeline';
import { desktop } from '../../../shared/web/desktop';
import { isIdentityEdit } from '../../../shared/core/photoEdit';
import { gridWindow } from '../virtualGrid';
import { selectScores, selectTimelineGroups, selectTimelineUnit, selectVisible, shownEdit, useGallery, useStackInfo, useVisibleItems } from '../store';
import { Tile } from './Tile';
import { usePreviewPreload } from './usePreviewPreload';

const GAP = 6;
/** Room either side of the tiles (px), as the grid's padding. */
const PAD = 12;
/** A heading's height (px), matching .gallery-timeline-heading in gallery.css. */
const HEADER = 34;
/** The month rail's width (px), matching .gallery-timeline-rail. */
const RAIL = 64;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const scoreOf = (s: { total: number; analysed: boolean } | undefined) => (s?.analysed ? s.total : null);
const photos = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'photo' : 'photos'}`;

/** What dragging this tile takes: every selected photo (in timeline order) when it is selected, else just it. */
function dragList(path: string): string[] {
  const s = useGallery.getState();
  return dragPaths(selectVisible(s).map((i) => i.path), s.selection, path);
}

/** The months that have photos, by year, each with the first group of that month (the rail's buttons). */
function railOf(groups: TimelineGroup[]): { year: string; months: { key: string; label: string; group: number }[] }[] {
  const years: { year: string; months: { key: string; label: string; group: number }[] }[] = [];
  groups.forEach((g, n) => {
    if (g.key === NO_DATE) return;
    const month = g.key.slice(0, 7);
    const year = month.slice(0, 4);
    let y = years.at(-1);
    if (y?.year !== year) years.push((y = { year, months: [] }));
    if (y.months.at(-1)?.key !== month) y.months.push({ key: month, label: MONTHS[Number(month.slice(5, 7)) - 1], group: n });
  });
  return years;
}

/**
 * The photos in date order under a heading per day or per month (Day / Month at the top), "No date" last.
 * Like the grid, only the rows on screen (and a couple either side) are drawn. A heading stays at the top
 * while its group scrolls under it, and a click on it selects the group's photos. The month rail down the
 * right edge jumps to a month. Selection, keys, stacks and filters are the grid's own (the store's list
 * is in date order while the timeline shows).
 */
export function Timeline({ onOpen, onContextMenu }: { onOpen: (path: string) => void; onContextMenu?: (path: string, e: MouseEvent) => void }) {
  const items = useVisibleItems();
  const groups = useGallery(selectTimelineGroups);
  const unit = useGallery(selectTimelineUnit);
  const stacks = useStackInfo();
  const thumbSize = useGallery((s) => s.thumbSize);
  const selected = useGallery((s) => s.selected);
  const selection = useGallery((s) => s.selection);
  const viewing = useGallery((s) => s.viewing);
  const pendingEdits = useGallery((s) => s.pendingEdits);
  const editTarget = useGallery((s) => s.editTarget);
  const scores = useGallery(selectScores);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef(0);

  const rail = useMemo(() => railOf(groups), [groups]);
  const railWidth = rail.length ? RAIL : 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // As many tiles to a row as the grid would fit in the same width, from the same thumbnail size.
  const width = Math.max(0, box.width - 2 * PAD - railWidth);
  const { cols, rowHeight } = gridWindow({ count: 0, width, tile: thumbSize, gap: GAP, scrollTop: 0, viewport: 0 });
  const stride = rowHeight + GAP;
  const layout = useMemo(() => timelineLayout(groups, cols, stride, HEADER), [groups, cols, stride]);
  const win = timelineWindow(layout, scrollTop, box.height);

  // The keys (outside the timeline) read how many tiles a row holds now, as they do the grid's.
  useEffect(() => useGallery.getState().setGridCols(cols), [cols]);
  useEffect(() => () => useGallery.getState().setGridCols(1), []);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(ref.current?.scrollTop ?? 0));
  };
  const scrollTo = (top: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = Math.max(0, top);
    setScrollTop(el.scrollTop);
  };

  // A new filter starts at the top, as in the grid (a star or an info refresh changes nothing here).
  const filter = useGallery((s) => s.filter);
  const shownFilter = useRef(filter);
  useLayoutEffect(() => {
    if (shownFilter.current === filter) return;
    shownFilter.current = filter;
    scrollTo(0);
  }, [filter]);

  /** Scroll just enough to show the selected photo's row below its heading (nothing when it is in view already). */
  const scrollToSelected = () => {
    const el = ref.current;
    const now = useGallery.getState().selected;
    const i = now === null ? undefined : pathIndex(items).get(now);
    if (!el || i === undefined) return;
    const row = rowOfItem(layout, i);
    if (row < 0) return;
    const top = layout.tops[row];
    const bottom = top + rowHeight + GAP;
    if (top - HEADER < el.scrollTop) scrollTo(top - HEADER);
    else if (bottom > el.scrollTop + el.clientHeight) scrollTo(bottom - el.clientHeight);
  };
  // Another photo selected, the viewer closed, the rows reflowed, Day / Month switched: keep the selected photo in view.
  useLayoutEffect(() => {
    if (viewing === null) scrollToSelected();
  }, [selected, viewing, cols, unit]);

  // The preview pane steps through the timeline: the photos around the selected one, in date order, are loaded ahead.
  usePreviewPreload(items, selected, viewing);

  const onSelect = useCallback((path: string, mods: { ctrl: boolean; shift: boolean }) => useGallery.getState().clickSelect(path, mods), []);
  const onStar = useCallback((path: string, star: boolean) => void useGallery.getState().setStar(path, star), []);
  const onToggleStack = useCallback((id: string) => useGallery.getState().toggleStack(id), []);
  const onDragReady = useCallback((path: string) => desktop?.prepareDrag?.(dragList(path)), []);
  const onDragOut = useCallback((path: string) => desktop?.startDrag?.(dragList(path)), []);

  const picked = useMemo(() => new Set(selection), [selection]);
  // The group whose rows are at the top now: the rail marks its month.
  const topGroup = layout.rows.length ? layout.rows[Math.max(0, timelineWindow(layout, scrollTop, 0, 0).first)].group : -1;

  // Each group in view is one block as tall as all its rows, so its heading can stick inside it while it scrolls.
  const blocks = [];
  if (win.last >= win.first) {
    for (let g = layout.rows[win.first].group; g <= layout.rows[win.last].group; g++) {
      const group = groups[g];
      const head = layout.headerRow[g];
      const blockTop = layout.tops[head];
      const blockEnd = g + 1 < groups.length ? layout.tops[layout.headerRow[g + 1]] : layout.height;
      const lastRow = g + 1 < groups.length ? layout.headerRow[g + 1] - 1 : layout.rows.length - 1;
      const tiles = [];
      for (let r = Math.max(win.first, head + 1); r <= Math.min(win.last, lastRow); r++) {
        const row = layout.rows[r];
        if (row.kind !== 'tiles') continue;
        for (let i = row.from; i < row.to; i++) {
          const item = items[i];
          const edit = shownEdit({ pendingEdits, editTarget }, item);
          tiles.push(
            <Tile
              key={item.path}
              item={item}
              x={(i - row.from) * stride}
              y={layout.tops[r] - blockTop}
              size={rowHeight}
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
      }
      blocks.push(
        <section key={group.key} className="gallery-timeline-group" style={{ top: blockTop, height: blockEnd - blockTop }} aria-label={group.label}>
          <button type="button" className="gallery-timeline-heading" title="Select these photos" onClick={() => useGallery.getState().selectGroup(group.key)}>
            {group.label} · {photos(group.count)}
          </button>
          {tiles}
        </section>,
      );
    }
  }

  return (
    <div className="gallery-timeline">
      <div className="gallery-timeline-body">
        <div className="gallery-timeline-scroll" ref={ref} onScroll={onScroll}>
          <div className="gallery-timeline-inner" style={{ height: layout.height, marginLeft: PAD, marginRight: PAD + railWidth }}>
            {blocks}
          </div>
        </div>
        {rail.length > 0 && (
          <nav className="gallery-timeline-rail" aria-label="Months">
            {rail.map((y) => (
              <div key={y.year} className="gallery-timeline-year">
                <span className="gallery-timeline-year-label">{y.year}</span>
                {y.months.map((m) => {
                  const current = topGroup >= 0 && groups[topGroup]?.key.startsWith(m.key);
                  return (
                    <button
                      key={m.key}
                      type="button"
                      className={current ? 'on' : ''}
                      aria-current={current ? 'true' : undefined}
                      aria-label={`${m.label} ${y.year}`}
                      onClick={() => scrollTo(layout.tops[layout.headerRow[m.group]])}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

/** Day | Month, at the top of the timeline (beside Grid | Timeline | Map). Picking one keeps it from then on. */
export function TimelineUnitSwitch() {
  const unit = useGallery(selectTimelineUnit);
  const pick = (u: TimelineUnit) => useGallery.getState().setTimelineUnit(u);
  return (
    <div className="gallery-timeline-unit">
      <div className="seg seg-compact" role="group" aria-label="Group the photos by">
        <button type="button" className={unit === 'day' ? 'on' : ''} aria-pressed={unit === 'day'} onClick={() => pick('day')}>
          Day
        </button>
        <button type="button" className={unit === 'month' ? 'on' : ''} aria-pressed={unit === 'month'} onClick={() => pick('month')}>
          Month
        </button>
      </div>
    </div>
  );
}
