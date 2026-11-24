import { useState, type MouseEvent } from 'react';
import { thumbUrl, type GalleryItem } from '../api';
import { useGallery, useStackInfo, useVisibleItems } from '../store';

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
  const items = useVisibleItems();
  const stacks = useStackInfo();
  const selected = useGallery((s) => s.selected);
  const item = selected === null ? undefined : items.find((i) => i.path === selected);
  const stack = item ? stacks.get(item.path) : undefined;
  // Its place in the stack: the top is first, the open members follow it in the shown order.
  const place = stack ? items.filter((i) => stacks.get(i.path)?.id === stack.id).findIndex((i) => i.path === item!.path) + 1 : 0;

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
            {stack && <span className="badge">{place} of {stack.size} in stack</span>}
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
