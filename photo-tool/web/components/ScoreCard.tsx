import { selectScores, useGallery } from '../store';

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/**
 * The photo score at the top of the details panel. Hovering it (or focusing it with Tab) shows what made
 * the score: each line that added or took away points, and the total.
 */
export function ScoreCard({ path }: { path: string }) {
  const score = useGallery((s) => selectScores(s).get(path));
  if (!score) return null;
  return (
    <div className="gallery-score" tabIndex={0} aria-describedby="gallery-score-why">
      <span className="gallery-score-label">Photo score</span>
      <span className="gallery-score-total" aria-label={`Photo score ${score.total}`}>{score.total}</span>
      {!score.analysed && <span className="muted small">still reading the photo</span>}
      <div className="gallery-score-pop" role="tooltip" id="gallery-score-why">
        <strong>What made this score</strong>
        <table>
          <tbody>
            {score.lines.map((l) => (
              <tr key={l.label}>
                <th scope="row">{l.label}</th>
                <td className="muted">{l.why}</td>
                <td className={`gallery-score-points ${l.points > 0 ? 'up' : 'down'}`}>{signed(l.points)}</td>
              </tr>
            ))}
            {!score.analysed && (
              <tr>
                <td colSpan={3} className="muted">Focus, exposure and colour are added once the photo has been read.</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>Total</th>
              <td className="gallery-score-points">{score.total}</td>
            </tr>
          </tfoot>
        </table>
        <p className="muted small">Up and Down nudge it by 1. Favourite +50, hidden −50.</p>
      </div>
    </div>
  );
}
