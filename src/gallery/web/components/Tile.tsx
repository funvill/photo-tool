import { memo, type SyntheticEvent } from 'react';
import { Icon } from '../../../web/components/Icon';
import { thumbUrl, type GalleryItem } from '../api';

export interface TileProps {
  item: GalleryItem;
  /** Where the grid places it (px, inside the grid's content box) and its side. */
  x: number;
  y: number;
  size: number;
  selected: boolean;
  onSelect(path: string): void;
  onStar(path: string, star: boolean): void;
  /** Double-click: open the photo in the viewer. */
  onOpen(path: string): void;
  onHoverStart(path: string, el: HTMLElement): void;
  onHoverEnd(): void;
}

const onActions = (e: SyntheticEvent) => !!(e.target as HTMLElement).closest('.gallery-tile-actions');

/** One photo in the grid: its thumbnail, a star badge when starred, and a star button on hover. */
export const Tile = memo(function Tile({ item, x, y, size, selected, onSelect, onStar, onOpen, onHoverStart, onHoverEnd }: TileProps) {
  const starred = item.info.star === true;
  return (
    <div
      className={`gallery-tile ${selected ? 'selected' : ''} ${starred ? 'starred' : ''}`}
      style={{ transform: `translate(${x}px, ${y}px)`, width: size, height: size }}
      title={item.relDir ? `${item.relDir}/${item.fileName}` : item.fileName}
      data-path={item.path}
      onClick={(e) => !onActions(e) && onSelect(item.path)}
      onDoubleClick={(e) => !onActions(e) && onOpen(item.path)}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onHoverStart(item.path, e.currentTarget)}
      onPointerLeave={onHoverEnd}
    >
      <img src={thumbUrl(item.key, 's')} alt={item.fileName} loading="lazy" decoding="async" draggable={false} />
      {starred && (
        <span className="gallery-star-badge" aria-label="Starred">
          <Icon name="star" size={12} />
        </span>
      )}
      <div className="gallery-tile-actions">
        <button
          type="button"
          className={`icon-btn ${starred ? 'on' : ''}`}
          aria-label={starred ? 'Unstar' : 'Star'}
          title={starred ? 'Unstar' : 'Star'}
          onClick={() => onStar(item.path, !starred)}
        >
          <Icon name="star" />
        </button>
      </div>
    </div>
  );
});
