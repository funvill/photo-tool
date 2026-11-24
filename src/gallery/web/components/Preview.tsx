import { useState, type MouseEvent } from 'react';
import { thumbUrl, type GalleryItem } from '../api';
import { selectStackPlace, useFilteredItems, useGallery } from '../store';

export interface PreviewProps {
  /** Double-click: open the photo in the full-screen viewer. */
  onOpen(path: string): void;
  /** Right-click on the photo: the photo menu. */
  onContextMenu?(path: string, e: MouseEvent): void;
}

/**
 * The selected photo, large (the 1600 px picture fitted to the pane, never cropped), with its file name
 * and what is special about it: favourite, hidden, its place in a stack. Empty when nothing shown is selected.
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
          <div className="gallery-preview-stage" onDoubleClick={() => onOpen(item.path)} onContextMenu={(e) => onContextMenu?.(item.path, e)}>
            <PreviewImage key={item.key} item={item} />
          </div>
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

/** The 1600 px picture; the 400 px one when that is missing. */
function PreviewImage({ item }: { item: GalleryItem }) {
  const [small, setSmall] = useState(false);
  return <img src={thumbUrl(item.key, small ? 's' : 'm')} alt={item.fileName} draggable={false} onError={() => setSmall(true)} />;
}
