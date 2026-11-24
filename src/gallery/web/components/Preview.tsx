import { useEffect, useState, type MouseEvent } from 'react';
import { fullUrl, thumbUrl, type GalleryItem } from '../api';
import { selectStackPlace, useFilteredItems, useGallery } from '../store';
import { MiniMap } from './MiniMap';
import { usePreviewZoom } from './usePreviewZoom';

export interface PreviewProps {
  /** Double-click: open the photo in the full-screen viewer. */
  onOpen(path: string): void;
  /** Right-click on the photo: the photo menu. */
  onContextMenu?(path: string, e: MouseEvent): void;
}

/**
 * The selected photo, large (the 1600 px picture fitted to the pane, never cropped; the wheel zooms, a drag pans),
 * with its file name and what is special about it: favourite, hidden, its place in a stack. Empty when nothing shown is selected.
 */
export function Preview({ onOpen, onContextMenu }: PreviewProps) {
  // A photo folded into a stack can be selected too (a marker on the map): it is looked for among every shown photo.
  const filtered = useFilteredItems();
  const selected = useGallery((s) => s.selected);
  const item = selected === null ? undefined : filtered.find((i) => i.path === selected);
  // Its place in the stack, folded or not: the face is first, the other members follow it in the shown order.
  const stack = useGallery((s) => {
    const p = item ? selectStackPlace(s, item.path) : null;
    return p ? `${p.place} of ${p.size} in stack` : null;
  });

  return (
    <section className="gallery-preview" aria-label="Preview">
      {item && (
        <>
          <PreviewStage key={item.key} item={item} onOpen={onOpen} onContextMenu={onContextMenu} />
          <div className="gallery-preview-caption">
            <strong className="ellipsis" title={item.path}>{item.relDir ? `${item.relDir}/${item.fileName}` : item.fileName}</strong>
            {item.info.star === true && <span className="badge gallery-badge-fav">Favourite</span>}
            {item.info.hidden === true && <span className="badge">Hidden</span>}
            {stack && <span className="badge">{stack}</span>}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The picture in its stage. The stage is measured and the picture placed by a transform, so it always fits
 * (a grid row that grew to the picture's height used to crop it). Zoomed in, the full-size picture is swapped
 * in once it is needed, and a mini map shows where the view is. A new photo is a new stage (keyed), so it starts fitted.
 */
function PreviewStage({ item, onOpen, onContextMenu }: { item: GalleryItem } & PreviewProps) {
  const [small, setSmall] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [full, setFull] = useState(false);
  const z = usePreviewZoom(natural);

  // Past the 1600 px picture's own detail: load the full picture, and swap it in when it has arrived.
  // The picture is always drawn at its fitted size and scaled, so the swap does not move the view.
  const needFull = z.view !== null && z.fit !== null && natural !== null && z.fit.w * z.view.zoom > natural.w;
  useEffect(() => {
    if (!needFull || full) return;
    const probe = new Image();
    probe.onload = () => setFull(true);
    probe.src = fullUrl(item.path);
    return () => {
      probe.onload = null;
    };
  }, [needFull, full, item.path]);

  const src = full ? fullUrl(item.path) : thumbUrl(item.key, small ? 's' : 'm');
  const v = z.view;
  const zoomedIn = v !== null && v.zoom > 1;
  return (
    <div
      className={`gallery-preview-stage${zoomedIn ? ' zoomed' : ''}`}
      ref={z.stageRef}
      {...z.handlers}
      onDoubleClick={() => (zoomedIn ? z.reset() : onOpen(item.path))}
      onContextMenu={(e) => onContextMenu?.(item.path, e)}
    >
      <img
        className="gallery-preview-img"
        src={src}
        alt={item.fileName}
        draggable={false}
        onLoad={(e) => {
          // The shape comes from the 1600 px picture only: the full one is the same shape.
          if (!full) setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
        }}
        onError={() => !full && setSmall(true)}
        style={v && z.fit ? { width: z.fit.w, height: z.fit.h, transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` } : { visibility: 'hidden' }}
      />
      {zoomedIn && natural && z.visible && <MiniMap itemKey={item.key} img={natural} visible={z.visible} onCentre={z.centre} />}
    </div>
  );
}
