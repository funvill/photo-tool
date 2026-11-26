import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { centreOn, clampPan, fitSize, fitView, visibleRect, zoomAt, type Size, type View } from '../../core/previewZoom';

/** One wheel notch zooms by this much. */
const WHEEL_STEP = 1.2;

/**
 * Zoom and pan of the preview's picture. The stage is measured; at zoom 1 the view is always the fit of the
 * current pane, so a resize (or a dragged splitter) puts a zoomed picture back to fit. `img` is the natural
 * size of the 1600 px picture (null until it has loaded).
 */
export function usePreviewZoom(img: Size | null) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [pane, setPane] = useState<Size>({ w: 0, h: 0 });
  const [zoomed, setZoomed] = useState<View | null>(null);
  const live = useRef({ pane, img, view: null as View | null });

  const ready = img !== null && img.w > 0 && img.h > 0 && pane.w > 0 && pane.h > 0;
  const view: View | null = !ready ? null : zoomed && zoomed.zoom > 1 ? zoomed : fitView(img, pane);
  live.current = { pane, img, view };

  // Measure the stage; a new size resets to fit. Before the first paint, so a new photo's stage is never drawn hidden for a frame.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      setPane((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setZoomed(null), [pane.w, pane.h]);

  // React's onWheel is passive and could not stop the page scrolling, so the listener is added by hand.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { pane: p, img: i, view: v } = live.current;
      if (!i || !v || e.deltaY === 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const next = zoomAt(v, e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, e.clientX - r.left, e.clientY - r.top, i, p);
      // Kept current here too: a second notch before the next render must start from this one.
      live.current.view = next;
      setZoomed(next.zoom > 1 ? next : null);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Dragging pans while zoomed in (pointer capture keeps the drag when the pointer leaves the stage).
  const drag = useRef<{ id: number; px: number; py: number; view: View } | null>(null);
  const onPointerDown = useCallback((e: PointerEvent) => {
    const v = live.current.view;
    if (e.button !== 0 || !v || v.zoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, view: v };
  }, []);
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    const { pane: p, img: i } = live.current;
    if (!d || d.id !== e.pointerId || !i) return;
    setZoomed(clampPan({ zoom: d.view.zoom, x: d.view.x + e.clientX - d.px, y: d.view.y + e.clientY - d.py }, i, p));
  }, []);
  const onPointerUp = useCallback((e: PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }, []);

  const reset = useCallback(() => setZoomed(null), []);
  const centre = useCallback((fx: number, fy: number) => {
    const { pane: p, img: i, view: v } = live.current;
    if (i && v && v.zoom > 1) setZoomed(centreOn(v, fx, fy, i, p));
  }, []);

  const fit = ready ? fitSize(img.w, img.h, pane.w, pane.h) : null;
  return {
    stageRef,
    view,
    fit,
    visible: view && img ? visibleRect(view, img, pane) : null,
    reset,
    centre,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
