import { Modal } from '../../../shared/web/components/Modal';
import { useGallery } from '../store';

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
