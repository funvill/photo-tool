import { estimateRemaining, formatRemaining } from '../../../web/eta';
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
