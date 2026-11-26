import { useState, type CSSProperties } from 'react';
import { editCss, type PhotoEdit } from '../../../shared/core/photoEdit';
import type { Size } from '../../core/previewZoom';
import { imageCache } from '../imageCache';
import { ColorFilter, colorFilterCss } from './ColorFilter';

export interface EditedImageProps {
  src: string;
  alt: string;
  edit: PhotoEdit;
  /** The box to show it in, in px. */
  box: Size;
  /**
   * 'contain' (default): the whole result, fitted; the element takes the result's own shape.
   * 'cover': the element is the box, filled with the middle of the result (as a grid tile's thumbnail is).
   */
  fit?: 'contain' | 'cover';
  className?: string;
  style?: CSSProperties;
  loading?: 'lazy' | 'eager';
  /** The picture's natural size, each time one loads. */
  onPicture?(size: Size): void;
  onError?(): void;
}

/**
 * A photo with an edit (flip, crop, rotate, straighten) drawn by CSS: a box that hides what is cut away, and
 * the upright picture inside it placed, mirrored and turned by `editCss`; light and colour by an SVG filter
 * (ColorFilter). The picture's shape is known once it has loaded; until then it is loading, unseen.
 */
export function EditedImage({ src, alt, edit, box, fit = 'contain', className, style, loading, onPicture, onError }: EditedImageProps) {
  // Known at once when the picture is decoded in the image cache (the preview steps from it): placed on the
  // first frame, not hidden until a load event. Many photos are edited (a turn, a flip, colour): this keeps them as quick as the rest.
  const [pic, setPic] = useState<Size | null>(() => {
    const img = imageCache.get(src);
    return img && img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  const ready = pic !== null && pic.w > 0 && pic.h > 0 && box.w > 0 && box.h > 0;

  let outer: Size = box;
  let img: CSSProperties = { visibility: 'hidden' };
  if (ready) {
    let css = editCss(edit, pic.w, pic.h, box.w, box.h);
    let dx = 0;
    let dy = 0;
    if (fit === 'cover') {
      // Fitted, the result leaves a gap on one side: draw it larger by that much, centred, and let the box cut it.
      const grow = Math.max(box.w / css.box.w, box.h / css.box.h);
      css = editCss(edit, pic.w, pic.h, box.w * grow, box.h * grow);
      dx = (box.w - css.box.w) / 2;
      dy = (box.h - css.box.h) / 2;
    } else {
      outer = css.box;
    }
    img = { width: css.img.width, height: css.img.height, transform: `translate(${dx}px, ${dy}px) ${css.img.transform}`, filter: colorFilterCss(edit.adjust) };
  }

  return (
    <div className={`gallery-edited${className ? ` ${className}` : ''}`} style={{ ...style, width: outer.w, height: outer.h }}>
      <ColorFilter adjust={edit.adjust} />
      <img
        src={src}
        alt={alt}
        loading={loading}
        decoding="async"
        draggable={false}
        style={img}
        onLoad={(e) => {
          const size = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
          setPic((p) => (p && p.w === size.w && p.h === size.h ? p : size));
          onPicture?.(size);
        }}
        onError={onError}
      />
    </div>
  );
}
