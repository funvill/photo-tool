import { useEffect, useRef, useState } from 'react';
import { api, isBrowserBackend, type FolderListing } from '../api';
import { desktop } from '../../../shared/web/desktop';
import { BrowserFolderPicker } from './BrowserFolderPicker';
import { Icon } from '../../../shared/web/components/Icon';
import { Modal } from '../../../shared/web/components/Modal';

export interface FolderPickerProps {
  title: string;
  action: string;
  /** Offer "keep linked" (sync the folder with the library from now on). */
  offerLink?: boolean;
  onChoose: (path: string, link: boolean) => void;
  onCancel: () => void;
}

/** Choose a folder: through the local server, or (web version) with the browser's own picker. */
export const FolderPicker = isBrowserBackend ? BrowserFolderPicker : ServerFolderPicker;

/** Browse local folders through the local server (the browser cannot expose real paths itself). */
function ServerFolderPicker({ title, action, offerLink, onChoose, onCancel }: FolderPickerProps) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [link, setLink] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Listings can arrive out of order (the first one, of the home folder, may be slow): only the
  // answer to the latest request is shown, and the first one never replaces a path typed meanwhile.
  const latest = useRef(0);
  const typed = useRef(false);

  const open = async (p?: string, first = false): Promise<boolean> => {
    const request = ++latest.current;
    try {
      const l = await api.listFolder(p);
      if (request !== latest.current) return true;
      setListing(l);
      if (!(first && typed.current)) setPath(l.label ?? l.path);
      setError(null);
      return true;
    } catch (e) {
      if (request !== latest.current) return true;
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  useEffect(() => {
    let last: string | undefined;
    try {
      last = localStorage.getItem('photobook:lastFolder') ?? undefined;
    } catch {
      // storage unavailable
    }
    void open(last, true).then((ok) => (ok ? undefined : open(undefined, true)));
  }, []);

  // Desktop app: the system's own folder dialog fills in the path; the list below still works.
  const browse = async () => {
    const picked = await desktop?.pickFolder({ title, defaultPath: path || undefined });
    if (picked) void open(picked);
  };

  // Windows: the list of drives is not a folder. Nothing can be chosen until a drive is opened
  // (or a real path typed over the label).
  const atDrives = !!listing?.drives && (path.trim() === (listing.label ?? listing.path) || /^[\\/]*$/.test(path.trim()));

  const choose = () => {
    if (atDrives) return;
    try {
      localStorage.setItem('photobook:lastFolder', path);
    } catch {
      // storage unavailable
    }
    onChoose(path, offerLink ? link : false);
  };

  return (
    <Modal title={title} onClose={onCancel} wide>
      <form
        className="path-row"
        onSubmit={(e) => {
          e.preventDefault();
          void open(path);
        }}
      >
        <input
          value={path}
          onChange={(e) => {
            typed.current = true;
            setPath(e.target.value);
          }}
          spellCheck={false}
          aria-label="Folder path"
        />
        <button className="btn btn-small" type="submit">Go</button>
        {desktop && <button className="btn btn-small" type="button" onClick={() => void browse()}>Browse…</button>}
      </form>
      {error && <div className="notice notice-error">{error}</div>}
      {listing && (
        <div className="folder-list">
          {listing.parent && (
            <button className="folder" onClick={() => open(listing.parent!)}>
              <Icon name="up" /> ..
            </button>
          )}
          {listing.folders.map((f) => (
            <button key={f} className="folder" onDoubleClick={() => open(`${listing.path}/${f}`)} onClick={() => open(`${listing.path}/${f}`)}>
              <Icon name="folder" /> {f}
            </button>
          ))}
          {listing.folders.length === 0 && <p className="muted pad">{listing.drives ? 'No drives found.' : 'No subfolders.'}</p>}
        </div>
      )}
      {offerLink && (
        <label className="field check folder-link">
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
          <span>Keep linked: photos added to this folder later join the library, and deleted ones leave it</span>
        </label>
      )}
      <div className="modal-foot">
        <span className="muted">
          {!listing ? '' : listing.drives ? 'Open a drive to choose a folder on it' : `${listing.photos} photo${listing.photos === 1 ? '' : 's'} directly in this folder · subfolders included`}
        </span>
        <div className="row">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={choose} disabled={!listing || atDrives}>{action}</button>
        </div>
      </div>
    </Modal>
  );
}
