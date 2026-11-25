import { selectScores, useGallery } from '../store';

/**
 * The toast on the preview after Up or Down: "+1 · 74" in green, "−1 · 72" in red (the photo's new score),
 * or "+1 · 4 photos" when several were nudged. Each press starts it again; it fades by itself.
 */
export function ScoreToast() {
  const toast = useGallery((s) => s.scoreToast);
  const total = useGallery((s) => (s.scoreToast ? selectScores(s).get(s.scoreToast.path)?.total : undefined));
  if (!toast) return null;
  const change = toast.delta > 0 ? '+1' : '−1';
  const after = toast.count > 1 ? `${toast.count} photos` : total !== undefined ? String(total) : '';
  return (
    <div key={toast.id} className={`gallery-score-toast ${toast.delta > 0 ? 'up' : 'down'}`} role="status" aria-live="polite">
      {change}
      {after && <span> · {after}</span>}
    </div>
  );
}
