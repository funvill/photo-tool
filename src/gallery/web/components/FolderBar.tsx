import { desktop } from '../../../web/desktop';
import { Icon } from '../../../web/components/Icon';
import { THUMB_MAX, THUMB_MIN, useGallery } from '../store';
import { SettingsDialog } from './SettingsDialog';

// Another folder, or closing this one, asks first while there are unsaved edits (requestOpen / requestClose).
const pickAndOpen = async () => {
  const folder = await desktop?.pickFolder({ title: 'Open a folder of photos' });
  if (folder) await useGallery.getState().requestOpen(folder, useGallery.getState().recursive);
};

function IncludeSubfolders() {
  const recursive = useGallery((s) => s.recursive);
  return (
    <label className="row gallery-check">
      <input type="checkbox" checked={recursive} onChange={(e) => useGallery.getState().setRecursive(e.target.checked)} />
      Include subfolders
    </label>
  );
}

/** The bar along the top: open a folder, the folder that is open, the thumbnail size and Settings. */
export function FolderBar() {
  const settings = useGallery((s) => s.settingsOpen);
  const root = useGallery((s) => s.root);
  const thumbSize = useGallery((s) => s.thumbSize);
  // A read-only folder's stars are kept in Photobook Studio's data folder (so the editor still sees them).
  const elsewhere = useGallery((s) => s.items.some((i) => i.infoSource === 'fallback'));
  return (
    <header className="topbar gallery-bar">
      <div className="row gallery-bar-title">
        <strong>Photobook Gallery</strong>
        {root && (
          <span className="muted ellipsis" title={root}>
            {root}
          </span>
        )}
        {elsewhere && (
          <span className="badge" title="This folder can't be written to, so stars and notes are kept in Photobook Studio's data folder instead. The editor still sees them.">
            Read-only folder: stars kept in Photobook Studio
          </span>
        )}
      </div>
      <div className="row">
        {root && (
          <label className="row gallery-size" title="Thumbnail size">
            <Icon name="grid" size={14} />
            <input type="range" min={THUMB_MIN} max={THUMB_MAX} step={8} value={thumbSize} aria-label="Thumbnail size" onChange={(e) => useGallery.getState().setThumbSize(Number(e.target.value))} />
          </label>
        )}
        {root && (
          <>
            <button type="button" className="btn" onClick={() => useGallery.getState().setTidyOpen(true)} title="Remove info saved for photos that are no longer in the folder">
              Tidy photo info…
            </button>
            <button type="button" className="btn" onClick={() => useGallery.getState().requestClose()}>
              Close folder
            </button>
            <IncludeSubfolders />
            <button type="button" className="btn btn-primary" onClick={() => void pickAndOpen()} disabled={!desktop}>
              <Icon name="folder" /> Open folder
            </button>
          </>
        )}
        <button type="button" className="icon-btn gallery-settings-btn" aria-label="Settings" title="Settings" onClick={() => useGallery.getState().setSettingsOpen(true)}>
          ⚙
        </button>
      </div>
      {settings && <SettingsDialog onClose={() => useGallery.getState().setSettingsOpen(false)} />}
    </header>
  );
}

/** The start screen: the folders opened lately. One that can't be found is greyed out. */
export function RecentFolders() {
  const recent = useGallery((s) => s.recent);
  return (
    <div className="gallery-start">
      <h1>Open a folder of photos</h1>
      <p className="muted">Look through your photos, star the best ones and drag them into other programs. Nothing leaves this computer.</p>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => void pickAndOpen()} disabled={!desktop}>
          <Icon name="folder" /> Open folder
        </button>
        <IncludeSubfolders />
      </div>
      {recent.length > 0 && (
        <section className="gallery-recent">
          <h2>Recent folders</h2>
          <ul>
            {recent.map((r) => (
              <li key={r.folder}>
                <button
                  type="button"
                  className="gallery-recent-item"
                  disabled={!r.exists}
                  title={r.exists ? r.folder : 'Not found — is the drive connected?'}
                  onClick={() => void useGallery.getState().requestOpen(r.folder, r.recursive)}
                >
                  <Icon name="folder" />
                  <span className="ellipsis">{r.folder}</span>
                  {!r.exists && <span className="small">Not found — is the drive connected?</span>}
                  {r.exists && r.recursive && <span className="small muted">with subfolders</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
