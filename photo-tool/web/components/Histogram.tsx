import { useEffect, useState } from 'react';
import { histogram, type Histogram as Bins } from '../../core/histogram';
import { thumbUrl, type GalleryItem } from '../api';

const W = 256;
const H = 80;
const FLAG = 0.02;

function areaPath(counts: number[], peak: number): string {
  if (peak <= 0) return '';
  const step = W / (counts.length - 1);
  let d = `M0,${H}`;
  counts.forEach((c, i) => (d += ` L${+(i * step).toFixed(2)},${+(H - (c / peak) * H).toFixed(2)}`));
  return `${d} L${W},${H} Z`;
}

const pct = (v: number) => `${(v * 100).toFixed(1)} %`;

/** Red, green, blue and luminance of the photo, worked out in the page from its 1600 px thumbnail. */
export function Histogram({ item }: { item: GalleryItem }) {
  const [bins, setBins] = useState<Bins | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setBins(null);
    setFailed(false);
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      try {
        const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no canvas');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const result = histogram(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
        if (live) setBins(result);
      } catch {
        if (live) setFailed(true);
      }
    };
    img.onerror = () => live && setFailed(true);
    img.src = thumbUrl(item.key, 'm');
    return () => void (live = false);
  }, [item.key]);

  const peak = bins ? Math.max(...bins.r, ...bins.g, ...bins.b, ...bins.l) : 0;
  const a = item.analysis;
  return (
    <div className="gallery-histogram">
      {failed ? (
        <p className="muted small">The histogram could not be drawn.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Histogram of red, green, blue and brightness">
          {bins && (
            <>
              <path d={areaPath(bins.l, peak)} fill="currentColor" fillOpacity={0.35} />
              <path d={areaPath(bins.r, peak)} fill="#e5483d" fillOpacity={0.45} />
              <path d={areaPath(bins.g, peak)} fill="#3aa655" fillOpacity={0.45} />
              <path d={areaPath(bins.b, peak)} fill="#3b82f6" fillOpacity={0.45} />
            </>
          )}
        </svg>
      )}
      {a && (
        <div className="gallery-clipping small">
          <span className={a.clippedShadows >= FLAG ? 'gallery-clip-flag' : 'muted'}>Shadows clipped {pct(a.clippedShadows)}</span>
          <span className={a.clippedHighlights >= FLAG ? 'gallery-clip-flag' : 'muted'}>Highlights clipped {pct(a.clippedHighlights)}</span>
        </div>
      )}
    </div>
  );
}
