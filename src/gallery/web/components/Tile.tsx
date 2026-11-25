import { memo, type MouseEvent, type SyntheticEvent } from 'react';
import type { StackInfo } from '../../../core/galleryStacks';
import type { PhotoEdit } from '../../../core/photoEdit';
import { Icon } from '../../../web/components/Icon';
import { thumbUrl, type GalleryItem } from '../api';
import { EditedImage } from './EditedImage';

export interface TileProps {
  item: GalleryItem;
  /** Where the grid places it (px, inside the grid's content box) and its side. */
  x: number;
  y: number;
  size: number;
  /** The photo the details panel shows. */
  selected: boolean;
  /** One of the selected photos (Ctrl/Shift-click). */
  picked: boolean;
  /** Hidden (shown only because the Hidden filter says so): drawn dimmed, with a mark. */
  hidden: boolean;
  /** Its stack, when it is one of a stack's shown photos. */
  stack?: StackInfo;
  /** The edit shown on the thumbnail (unsaved, else saved), or null for the plain thumbnail. */
  edit: PhotoEdit | null;
  /** It has an edit not saved yet: a small dot says so. */
  unsaved: boolean;
  /** Its photo score, shown in the bottom-right corner; null (shown as "–") until the photo is analysed. */
  score: number | null;
  onSelect(path: string, mods: { ctrl: boolean; shift: boolean }): void;
  onStar(path: string, star: boolean): void;
  /** The "×N" badge of a stack's top: unfold or fold the stack. */
  onToggleStack(id: string): void;
  /** Double-click: open the photo in the viewer. */
  onOpen(path: string): void;
  /** The left button went down on the tile: a drag may follow, so the files are checked now. */
  onDragReady(path: string): void;
  /** The tile is being dragged: the desktop app drags the photo files out instead. */
  onDragOut(path: string): void;
  /** Right-click on the tile: the photo menu. */
  onContextMenu?(path: string, e: MouseEvent): void;
}

/** A click on one of the tile's own buttons is not a click on the photo. */
const onControls = (e: SyntheticEvent) => !!(e.target as HTMLElement).closest('.gallery-tile-actions, .gallery-stack-badge');

/** One photo in the grid: its thumbnail (edited, when it has an edit), star and hidden marks, a dot for an unsaved edit, its photo score, a stack's "×N" badge, and a star button on hover. */
export const Tile = memo(function Tile({ item, x, y, size, selected, picked, hidden, stack, edit, unsaved, score, onSelect, onStar, onToggleStack, onOpen, onDragReady, onDragOut, onContextMenu }: TileProps) {
  const starred = item.info.star === true;
  const classes = ['gallery-tile', selected && 'selected', picked && 'picked', starred && 'starred', hidden && 'hidden', stack && !stack.top && 'stack-member', stack?.top && stack.open && 'stack-open', edit && 'edited'];
  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      style={{ transform: `translate(${x}px, ${y}px)`, width: size, height: size }}
      title={item.relDir ? `${item.relDir}/${item.fileName}` : item.fileName}
      data-path={item.path}
      draggable
      onClick={(e) => !onControls(e) && onSelect(item.path, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      onDoubleClick={(e) => !onControls(e) && onOpen(item.path)}
      onPointerDown={(e) => e.button === 0 && !onControls(e) && onDragReady(item.path)}
      onDragStart={(e) => {
        // The page's own drag would carry a picture of the tile; the desktop app drags the files.
        e.preventDefault();
        onDragOut(item.path);
      }}
      onContextMenu={(e) => onContextMenu?.(item.path, e)}
    >
      {edit ? (
        <EditedImage src={thumbUrl(item.key, 's')} alt={item.fileName} edit={edit} box={{ w: size, h: size }} fit="cover" loading="lazy" />
      ) : (
        <img src={thumbUrl(item.key, 's')} alt={item.fileName} loading="lazy" decoding="async" draggable={false} />
      )}
      {unsaved && <span className="gallery-tile-unsaved" aria-label="Edited, not saved" title="Edited, not saved" />}
      <span className="gallery-tile-score" aria-label={score === null ? 'Score not worked out yet' : `Score ${score}`}>{score === null ? '–' : score}</span>
      {(starred || hidden) && (
        <span className="gallery-tile-marks">
          {starred && (
            <span className="gallery-star-badge" aria-label="Starred">
              <Icon name="star" size={12} />
            </span>
          )}
          {hidden && (
            <span className="gallery-hidden-badge" aria-label="Hidden">
              <Icon name="eye-off" size={12} />
            </span>
          )}
        </span>
      )}
      {stack?.top && (
        <button
          type="button"
          className={`gallery-stack-badge ${stack.open ? 'open' : ''}`}
          aria-label={`${stack.open ? 'Fold' : 'Show'} ${stack.size} similar photos`}
          title={`${stack.open ? 'Fold' : 'Show'} ${stack.size} similar photos`}
          onClick={() => onToggleStack(stack.id)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          ×{stack.size}
        </button>
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
