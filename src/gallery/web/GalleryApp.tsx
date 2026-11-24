import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { desktop } from '../../web/desktop';
import { Details } from './components/Details';
import { FilterBar } from './components/FilterBar';
import { FolderBar, RecentFolders } from './components/FolderBar';
import { Grid } from './components/Grid';
import { Preview } from './components/Preview';
import { Progress } from './components/Progress';
import { Splitter, saveWidth, savedWidth } from './components/Splitter';
import { TidyDialog } from './components/TidyDialog';
import { Toasts } from './components/Toasts';
import { Viewer } from './components/Viewer';
import { connectDesktop, useGallery, useVisibleItems } from './store';
import { useReviewKeys } from './useReviewKeys';

/** Double-click on a photo, or Enter or Space on the selected one. */
const openViewer = (path: string) => useGallery.getState().openViewer(path);
/** Right-click on a photo: the menu is wired in later; the browser's own menu shows meanwhile. */
const onPhotoMenu = () => undefined;

const GRID_KEY = 'gallery.gridWidth';
const DETAILS_KEY = 'gallery.detailsWidth';
const GRID = { fallback: 420, min: 200 };
const DETAILS = { fallback: 340, min: 260, max: 560 };
/** The preview always keeps this much (px); the two 6 px handles take the rest of the gaps. */
const PREVIEW_MIN = 300;
const HANDLES = 12;

// The gallery window: the start screen (recent folders) until a folder is open, then its photos.
// A folder can also arrive from outside the page: `--gallery <folder>`, a second launch, File > Open folder.
export function GalleryApp() {
  const root = useGallery((s) => s.root);
  const tidyOpen = useGallery((s) => s.tidyOpen);
  const empty = useGallery((s) => s.items.length === 0 && s.progress === null);

  useEffect(() => connectDesktop(desktop), []);
  useEffect(() => {
    void useGallery.getState().loadRecent();
  }, []);
  useReviewKeys(openViewer);

  return (
    <div className="gallery">
      <FolderBar />
      <Progress />
      {root && !empty && <FilterBar />}
      {!root ? <RecentFolders /> : empty ? <p className="muted pad">No photos in this folder.</p> : <ReviewScreen root={root} />}
      {root && !empty && <Viewer />}
      {root && tidyOpen && <TidyDialog />}
      <Toasts />
    </div>
  );
}

/** Thumbnails | handle | preview | handle | details. The two side columns keep the widths last dragged to. */
function ReviewScreen({ root }: { root: string }) {
  const noneShown = useVisibleItems().length === 0;
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [gridWidth, setGridWidth] = useState(() => savedWidth(GRID_KEY, GRID.fallback));
  const [detailsWidth, setDetailsWidth] = useState(() => savedWidth(DETAILS_KEY, DETAILS.fallback));

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
        {noneShown ? (
          <p className="muted pad">No photos match the filter</p>
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
    </div>
  );
}
