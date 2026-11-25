import { estimateRemaining, formatRemaining } from '../../../shared/web/eta';
import { useGallery } from '../store';

/** While a folder is being read: how far along it is, and roughly how long is left. */
export function Progress() {
  const progress = useGallery((s) => s.progress);
  if (!progress) return null;
  const { total, processed, startedAt } = progress;
  const left = estimateRemaining(processed, total, startedAt, Date.now());
  const label = total === 0 ? 'Looking for photos…' : `Reading photos ${processed} / ${total}${left === null ? '' : ` · ${formatRemaining(left)}`}`;
  return (
    <div className="gallery-progress" role="progressbar" aria-label="Reading photos" aria-valuemin={0} aria-valuemax={total} aria-valuenow={processed}>
      <div className="gallery-progress-bar"><span style={{ width: `${total ? (processed / total) * 100 : 0}%` }} /></div>
      <span className="muted small">{label}</span>
    </div>
  );
}

/** While photo tagging runs or is paused: "Tagging 120 of 2,140", with Pause or Resume. Nothing when done or off. */
export function TaggingProgress() {
  const t = useGallery((s) => s.tagging);
  if (!t || t.total === 0) return null;
  if (t.problem && !t.running) {
    return (
      <div className="gallery-progress gallery-tagging-progress" role="status" aria-label="Photo tagging">
        <span className="small gallery-note-error">Tagging stopped: {t.problem}</span>
        <button type="button" className="btn btn-small" onClick={() => void useGallery.getState().setTaggingPaused(false)}>
          Try again
        </button>
      </div>
    );
  }
  if (!(t.running || (t.paused && t.done + t.failed < t.total))) return null;
  const pause = () => void useGallery.getState().setTaggingPaused(!t.paused);
  return (
    <div className="gallery-progress gallery-tagging-progress" role="status" aria-label="Photo tagging">
      <div className="gallery-progress-bar"><span style={{ width: `${(t.done / t.total) * 100}%` }} /></div>
      <span className="muted small">
        Tagging {t.done.toLocaleString()} of {t.total.toLocaleString()}
        {t.paused ? ' · paused' : ''}
      </span>
      <button type="button" className="btn btn-small" onClick={pause}>
        {t.paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  );
}
