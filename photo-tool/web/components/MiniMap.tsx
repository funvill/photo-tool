import type { PointerEvent } from 'react';
import { thumbUrl } from '../api';
import type { Size } from '../../core/previewZoom';
import type { CropRect, PhotoEdit } from '../../../shared/core/photoEdit';
import { EditedImage } from './EditedImage';

/** The long side of the mini map, in pixels. */
const LONG_SIDE = 160;

export interface MiniMapProps {
  itemKey: string;
  /** The picture's shape (its natural size is enough; for an edited photo, the edited result's). */
  img: Size;
  /** The part of the picture in the pane, as fractions. */
  visible: CropRect;
  /** The photo's edit, shown on the small picture too. */
  edit?: PhotoEdit | null;
  /** Click or drag: the view moves to centre on this point (fractions of the picture). */
  onCentre(fx: number, fy: number): void;
}

/** A small picture of the whole photo, with a rectangle for what the preview shows; clicking or dragging on it moves the view. */
export function MiniMap({ itemKey, img, edit, visible, onCentre }: MiniMapProps) {
  const scale = LONG_SIDE / Math.max(img.w, img.h);
  const w = Math.round(img.w * scale);
  const h = Math.round(img.h * scale);
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCentre(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  return (
    <div
      className="gallery-minimap"
      style={{ width: w, height: h }}
      // Its own pointer work: the stage behind must not start a pan, or open the viewer on a double-click.
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        point(e);
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        if (e.currentTarget.hasPointerCapture(e.pointerId)) point(e);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {edit ? <EditedImage src={thumbUrl(itemKey, 's')} alt="" edit={edit} box={{ w, h }} fit="cover" /> : <img src={thumbUrl(itemKey, 's')} alt="" draggable={false} />}
      <div
        className="gallery-minimap-view"
        style={{ left: `${visible.x * 100}%`, top: `${visible.y * 100}%`, width: `${visible.w * 100}%`, height: `${visible.h * 100}%` }}
      />
    </div>
  );
}
