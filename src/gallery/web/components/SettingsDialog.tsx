import { Modal } from '../../../web/components/Modal';
import { desktop } from '../../../web/desktop';
import { useGallery } from '../store';

/**
 * Settings (the ⚙ in the top bar): "When I save an edit", change only the photo's info file or the photo
 * file itself. One choice of two, since both at once would apply the crop twice. A change is kept at once.
 * Changing the photo file needs the desktop app: greyed out in a plain browser.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const target = useGallery((s) => s.editTarget);
  const canFile = !!desktop?.saveEditToFile;
  const pick = (t: 'info' | 'file') => void useGallery.getState().setEditTarget(t);
  return (
    <Modal title="Settings" onClose={onClose}>
      <fieldset className="gallery-settings-group">
        <legend>When I save an edit</legend>
        <label className="gallery-settings-option">
          <input type="radio" name="editTarget" value="info" checked={target === 'info'} onChange={() => pick('info')} autoFocus={target === 'info'} />
          <span>
            <strong>Change only the photo's info file</strong>
            <span className="muted small">The photo stays as it is. The crop and rotation are kept in photoinfo.json, and the photobook applies them when it brings the photo in.</span>
          </span>
        </label>
        <label className={`gallery-settings-option${canFile ? '' : ' disabled'}`}>
          <input type="radio" name="editTarget" value="file" checked={target === 'file'} disabled={!canFile} onChange={() => pick('file')} autoFocus={target === 'file'} />
          <span>
            <strong>Change the photo file itself</strong>
            <span className="muted small">The photo is rewritten. The original goes to the Recycle Bin.</span>
            {!canFile && <span className="small gallery-settings-note">Needs the desktop app</span>}
          </span>
        </label>
      </fieldset>
      <div className="modal-foot">
        <span />
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** "You have unsaved edits to N photos. Open another folder without saving?" Cancel keeps the folder open. */
export function LeaveDialog() {
  const leaving = useGallery((s) => s.leaving);
  const count = useGallery((s) => Object.keys(s.pendingEdits).length);
  if (!leaving) return null;
  const closing = leaving === 'close';
  const { cancelLeave, confirmLeave } = useGallery.getState();
  return (
    <Modal title="Unsaved edits" onClose={cancelLeave}>
      <p>
        You have unsaved edits to {count} {count === 1 ? 'photo' : 'photos'}. {closing ? 'Close the folder without saving?' : 'Open another folder without saving?'}
      </p>
      <div className="modal-foot">
        <span />
        <div className="row">
          <button type="button" className="btn" onClick={cancelLeave} autoFocus>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void confirmLeave()}>
            {closing ? 'Close without saving' : 'Open without saving'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
