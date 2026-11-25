export function formatTaken(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export interface HoverPreviewProps {
  /** The large (1600 px) image. */
  src: string;
  title: string;
  /** ISO date taken, or null when unknown. */
  takenAt: string | null;
  /** Further lines under the date (size, people…). */
  details?: string[];
  /** Show a checkerboard behind it (a photo with transparency). */
  checker?: boolean;
  /** Its left edge sits 24 px right of this. */
  left: number;
  /** When set, its right edge sits 24 px left of this distance from the window's right edge. */
  right?: number;
}

/** Large preview fixed beside a grid of photos. It ignores the pointer so it never blocks a drag or click. */
export function HoverPreview({ src, title, takenAt, details = [], checker, left, right }: HoverPreviewProps) {
  return (
    <div className="hover-preview" style={{ left: left + 24, ...(right !== undefined ? { right: right + 24 } : {}) }} aria-hidden="true">
      <div className={`hover-preview-img ${checker ? 'checker' : ''}`}>
        <img src={src} alt="" draggable={false} />
      </div>
      <div className="hover-preview-meta">
        <strong className="ellipsis">{title}</strong>
        <span>{takenAt ? formatTaken(takenAt) : 'No capture date'}</span>
        {details.map((d, i) => <span key={i}>{d}</span>)}
      </div>
    </div>
  );
}
