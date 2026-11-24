import { useEffect } from 'react';
import { desktop } from '../../web/desktop';

// The gallery window's shell: a title bar and "Open folder". Opening a folder is wired up later;
// for now the chosen folder (or one handed over by a second `--gallery <folder>` launch) is logged.
export function GalleryApp() {
  useEffect(() => desktop?.onOpenFolder?.((folder) => console.info('gallery: open folder', folder)), []);

  const openFolder = async () => {
    const folder = await desktop?.pickFolder({ title: 'Open a folder of photos' });
    if (folder) console.info('gallery: open folder', folder);
  };

  return (
    <div className="gallery">
      <header className="topbar">
        <strong>Photobook Gallery</strong>
        <button type="button" className="btn btn-primary" onClick={() => void openFolder()} disabled={!desktop}>
          Open folder
        </button>
      </header>
    </div>
  );
}
