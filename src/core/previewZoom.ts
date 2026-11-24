import type { CropRect } from './photoEdit';

// The maths of the gallery's preview: the picture fitted to the pane, zoomed with the wheel, panned by
// dragging. Pure, so it is tested without a browser. All sizes are pixels except where a fraction is said.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export interface Size { w: number; h: number }

/** x, y: where the picture's top-left corner is in the pane (pixels). The picture is drawn `zoom` times its fitted size. */
export interface View { zoom: number; x: number; y: number }

/** The largest size with the picture's shape that fits wholly inside the pane (never cropped). */
export function fitSize(imgW: number, imgH: number, paneW: number, paneH: number): Size {
  if (imgW <= 0 || imgH <= 0 || paneW <= 0 || paneH <= 0) return { w: 0, h: 0 };
  const scale = Math.min(paneW / imgW, paneH / imgH);
  return { w: imgW * scale, h: imgH * scale };
}

const fitted = (img: Size, pane: Size) => fitSize(img.w, img.h, pane.w, pane.h);

/** Zoom 1: the fitted picture, centred. */
export function fitView(img: Size, pane: Size): View {
  const s = fitted(img, pane);
  return { zoom: 1, x: (pane.w - s.w) / 2, y: (pane.h - s.h) / 2 };
}

/** One axis: centred when the picture is smaller than the pane, otherwise no gap at either edge. */
function clampAxis(pos: number, size: number, pane: number): number {
  if (size <= pane) return (pane - size) / 2;
  return Math.min(0, Math.max(pane - size, pos));
}

/** Keeps the picture covering the pane wherever it can, and centred on an axis where it is smaller. */
export function clampPan(v: View, img: Size, pane: Size): View {
  const s = fitted(img, pane);
  return { zoom: v.zoom, x: clampAxis(v.x, s.w * v.zoom, pane.w), y: clampAxis(v.y, s.h * v.zoom, pane.h) };
}

/** Zooms by `factor` (1 to 8 overall), keeping the picture point under the pointer (px, py) where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number, img: Size, pane: Size): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
  if (zoom <= MIN_ZOOM) return fitView(img, pane);
  const s = fitted(img, pane);
  // The fraction of the picture under the pointer, before and after.
  const u = (px - v.x) / (s.w * v.zoom);
  const w = (py - v.y) / (s.h * v.zoom);
  return clampPan({ zoom, x: px - u * s.w * zoom, y: py - w * s.h * zoom }, img, pane);
}

/** The part of the picture in the pane, as fractions of the picture (the mini map's rectangle). */
export function visibleRect(v: View, img: Size, pane: Size): CropRect {
  const s = fitted(img, pane);
  const sw = s.w * v.zoom;
  const sh = s.h * v.zoom;
  if (sw <= 0 || sh <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.max(0, -v.x) / sw;
  const x1 = Math.min(sw, pane.w - v.x) / sw;
  const y0 = Math.max(0, -v.y) / sh;
  const y1 = Math.min(sh, pane.h - v.y) / sh;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Moves the view so the picture point (fx, fy), as fractions, is at the middle of the pane (as far as the edges allow). */
export function centreOn(v: View, fx: number, fy: number, img: Size, pane: Size): View {
  const s = fitted(img, pane);
  return clampPan({ zoom: v.zoom, x: pane.w / 2 - fx * s.w * v.zoom, y: pane.h / 2 - fy * s.h * v.zoom }, img, pane);
}
