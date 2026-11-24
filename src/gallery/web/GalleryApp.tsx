import { useEffect } from 'react';
import { desktop } from '../../web/desktop';
import { Details } from './components/Details';
import { FolderBar, RecentFolders } from './components/FolderBar';
import { Grid } from './components/Grid';
import { Progress } from './components/Progress';
import { TidyDialog } from './components/TidyDialog';
import { Toasts } from './components/Toasts';
import { connectDesktop, useGallery } from './store';

/** Double-click on a photo. The viewer arrives with Task 7; until then this does nothing. */
const openViewer = (_path: string) => undefined;

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

  return (
    <div className="gallery">
      <FolderBar />
      <Progress />
      {!root ? (
        <RecentFolders />
      ) : empty ? (
        <p className="muted pad">No photos in this folder.</p>
      ) : (
        // The details panel takes its width from the grid. A new folder starts at the top.
        <div className="gallery-main">
          <Grid key={root} onOpen={openViewer} />
          <Details />
        </div>
      )}
      {root && tidyOpen && <TidyDialog />}
      <Toasts />
    </div>
  );
}
