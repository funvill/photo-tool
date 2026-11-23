import type { PhotoAsset } from '../../core';
import { thumbUrl } from '../api';

export function formatTaken(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Large preview fixed to the right of the library. It ignores the pointer so it never blocks a drag or click. */
export function HoverPreview({ asset, left }: { asset: PhotoAsset; left: number }) {
  return (
    <div className="hover-preview" style={{ left: left + 24 }} aria-hidden="true">
      <div className={`hover-preview-img ${asset.analysis?.transparent ? 'checker' : ''}`}>
        <img src={thumbUrl(asset.id, 'm')} alt="" draggable={false} />
      </div>
      <div className="hover-preview-meta">
        <strong className="ellipsis">{asset.fileName}</strong>
        <span>{asset.capturedAt ? formatTaken(asset.capturedAt) : 'No capture date'}</span>
        <span>{asset.widthPx} × {asset.heightPx} · {formatSize(asset.fileSizeBytes)}</span>
        {asset.people && asset.people.length > 0 && <span>{asset.people.join(', ')}</span>}
      </div>
    </div>
  );
}
