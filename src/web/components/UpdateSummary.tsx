import { spreadPagesLabel, type UpdateReport } from '../../core';
import { useEditor } from '../store';

/** What the last "Update from stars" did, with a link to each page it touched. */
export function UpdateSummary({ report }: { report: UpdateReport }) {
  const n = useEditor((s) => s.doc?.spreads.length ?? 0);
  const goToSpread = useEditor((s) => s.goToSpread);
  const parts: string[] = [];
  if (report.added.length) parts.push(`${report.added.length} added`);
  if (report.removed.length) parts.push(`${report.removed.length} removed`);
  if (report.replaced.length) parts.push(`${report.replaced.length} replaced`);
  if (report.relaidPages.length) parts.push(`${report.relaidPages.length} page${report.relaidPages.length > 1 ? 's' : ''} re-laid`);
  if (report.addedSpreads.length) parts.push(`added ${report.addedSpreads.length * 2} pages, now ${report.pages}`);
  if (report.removedSpreads) parts.push(`removed ${report.removedSpreads * 2} pages, now ${report.pages}`);
  if (report.emptiedFrames.length) parts.push(`${report.emptiedFrames.length} empty frame${report.emptiedFrames.length > 1 ? 's' : ''}`);

  const changed = [...new Set([
    ...report.replaced.map((r) => r.spreadIndex),
    ...report.relaidPages.map((r) => r.spreadIndex),
    ...report.addedSpreads,
    ...report.emptiedFrames.map((f) => f.spreadIndex),
  ])].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);

  return (
    <div className="update-summary small" data-testid="update-summary">
      <p className="muted small">{parts.length ? parts.join(' · ') : 'The draft already matches your stars.'}</p>
      {report.notes.length > 0 && <p className="muted small">{report.notes.join(' ')}</p>}
      {changed.length > 0 && (
        <p className="small">
          Changed:{' '}
          {changed.map((i, k) => (
            <span key={i}>
              {k > 0 && ', '}
              <button className="link" onClick={() => goToSpread(i)}>{spreadPagesLabel(i, n)}</button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
