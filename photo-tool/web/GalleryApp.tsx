import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { desktop } from '../../shared/web/desktop';
import { Details } from './components/Details';
import { FilterBar } from './components/FilterBar';
import { FolderBar, RecentFolders } from './components/FolderBar';
import { Grid } from './components/Grid';
import { MapView } from './components/MapView';
import { PhotoMenu } from './components/PhotoMenu';
import { Preview } from './components/Preview';
import { Progress, TaggingProgress } from './components/Progress';
import { LeaveDialog } from './components/LeaveDialog';
import { Splitter, saveWidth, savedWidth } from './components/Splitter';
import { TidyDialog } from './components/TidyDialog';
import { Timeline, TimelineUnitSwitch } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { Viewer } from './components/Viewer';
import { connectDesktop, useGallery, useVisibleItems, type GalleryView } from './store';
import { useOriginalKey, useReviewKeys } from './useReviewKeys';
import { Shortcuts } from './components/Shortcuts';

/** Double-click on a photo, or Enter or Space on the selected one. */
const openViewer = (path: string) => useGallery.getState().openViewer(path);

const GRID_KEY = 'gallery.gridWidth';
const DETAILS_KEY = 'gallery.detailsWidth';
const GRID = { fallback: 420, min: 200 };
const DETAILS = { fallback: 340, min: 260, max: 560 };
/** The preview always keeps this much (px); the two 6 px handles take the rest of the gaps. */
const PREVIEW_MIN = 300;
const HANDLES = 12;

// The gallery window: the start screen (recent folders) until a folder is open, then its photos.
// A folder can also arrive from outside the page: a folder given at start, a second launch, File > Open folder.
export function GalleryApp() {
  const root = useGallery((s) => s.root);
  const tidyOpen = useGallery((s) => s.tidyOpen);
  const empty = useGallery((s) => s.items.length === 0 && s.progress === null);

  useEffect(() => connectDesktop(desktop), []);
  useEffect(() => {
    void useGallery.getState().loadRecent();
    // Where edits are saved (Settings), once connectDesktop above has handed the store the desktop app.
    void useGallery.getState().loadEditTarget();
  }, []);
  useReviewKeys(openViewer);
  useOriginalKey();

  return (
    <div className="gallery">
      <FolderBar />
      <Progress />
      {root && <TaggingProgress />}
      {root && !empty && <FilterBar />}
      {!root ? <RecentFolders /> : empty ? <p className="muted pad">No photos in this folder.</p> : <ReviewScreen root={root} />}
      {root && !empty && <Viewer />}
      {root && tidyOpen && <TidyDialog />}
      <LeaveDialog />
      <Shortcuts />
      <Toasts />
    </div>
  );
}

const VIEWS: { view: GalleryView; label: string }[] = [
  { view: 'grid', label: 'Grid' },
  { view: 'timeline', label: 'Timeline' },
  { view: 'map', label: 'Map' },
];

/**
 * Grid | Timeline | Map, at the top of the thumbnail column: the timeline and the map replace only the
 * thumbnails. In the timeline, its Day | Month sits at the other end of the row.
 */
function ViewSwitch() {
  const view = useGallery((s) => s.view);
  const setView = useGallery((s) => s.setView);
  return (
    <div className="gallery-view-switch">
      <div className="seg" role="group" aria-label="Show the photos as">
        {VIEWS.map((v) => (
          <button key={v.view} type="button" className={view === v.view ? 'on' : ''} aria-pressed={view === v.view} onClick={() => setView(v.view)}>
            {v.label}
          </button>
        ))}
      </div>
      {view === 'timeline' && <TimelineUnitSwitch />}
    </div>
  );
}

/** Thumbnails | handle | preview | handle | details. The two side columns keep the widths last dragged to. */
function ReviewScreen({ root }: { root: string }) {
  const noneShown = useVisibleItems().length === 0;
  const view = useGallery((s) => s.view);
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [gridWidth, setGridWidth] = useState(() => savedWidth(GRID_KEY, GRID.fallback));
  const [detailsWidth, setDetailsWidth] = useState(() => savedWidth(DETAILS_KEY, DETAILS.fallback));
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  // Right-click on a tile or the preview: a photo not selected is selected first; one of the selected
  // photos keeps the selection (so the menu's Copy path and Delete take them all).
  const onPhotoMenu = useCallback((path: string, e: MouseEvent) => {
    e.preventDefault();
    const s = useGallery.getState();
    if (!s.selection.includes(path)) s.select(path);
    setMenu({ x: e.clientX, y: e.clientY, path });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setRoom(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // What fits now: the details panel within its range, the grid within what the preview leaves over.
  const free = room > 0 ? room - PREVIEW_MIN - HANDLES : Infinity;
  const detailsMax = Math.max(DETAILS.min, Math.min(DETAILS.max, free - GRID.min));
  const details = Math.max(DETAILS.min, Math.min(detailsWidth, detailsMax));
  const gridMax = Math.max(GRID.min, free - details);
  const grid = Math.max(GRID.min, Math.min(gridWidth, gridMax));

  return (
    <div className="gallery-main" ref={ref}>
      <div className="gallery-grid-col" style={{ width: grid }}>
        <ViewSwitch />
        {noneShown ? (
          <p className="muted pad">No photos match the filter</p>
        ) : view === 'map' ? (
          // A new folder opens fitted to its own markers.
          <MapView key={root} />
        ) : view === 'timeline' ? (
          // A new folder starts at the top.
          <Timeline key={root} onOpen={openViewer} onContextMenu={onPhotoMenu} />
        ) : (
          // A new folder starts at the top.
          <Grid key={root} onOpen={openViewer} onContextMenu={onPhotoMenu} />
        )}
      </div>
      <Splitter label="Resize thumbnail column" value={grid} min={GRID.min} max={gridMax} dir={1} onChange={setGridWidth} onCommit={(px) => saveWidth(GRID_KEY, px)} />
      <Preview onOpen={openViewer} onContextMenu={onPhotoMenu} />
      <Splitter label="Resize details panel" value={details} min={DETAILS.min} max={detailsMax} dir={-1} onChange={setDetailsWidth} onCommit={(px) => saveWidth(DETAILS_KEY, px)} />
      <div className="gallery-details-col" style={{ width: details }}>
        <Details />
      </div>
      {menu && <PhotoMenu key={`${menu.path}@${menu.x},${menu.y}`} x={menu.x} y={menu.y} path={menu.path} onClose={closeMenu} />}
    </div>
  );
}
