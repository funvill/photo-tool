import { useRef } from 'react';

export const LIBRARY_MIN = 220;
export const LIBRARY_MAX = 900;
export const LIBRARY_DEFAULT = 264;
const KEY = 'photobook.libraryWidth';

export const clampLibraryWidth = (w: number) => Math.min(LIBRARY_MAX, Math.max(LIBRARY_MIN, Math.round(w)));

export function loadLibraryWidth(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? clampLibraryWidth(n) : LIBRARY_DEFAULT;
  } catch {
    return LIBRARY_DEFAULT;
  }
}

export function saveLibraryWidth(w: number) {
  try {
    localStorage.setItem(KEY, String(clampLibraryWidth(w)));
  } catch {
    /* private mode or blocked storage: the width just isn't remembered */
  }
}

/** Drag handle on the library's right edge. */
export function PanelResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize library"
      aria-valuemin={LIBRARY_MIN}
      aria-valuemax={LIBRARY_MAX}
      aria-valuenow={width}
      tabIndex={0}
      style={{ left: width - 3 }}
      title="Drag to resize the library · double-click to reset"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        if (drag.current) onChange(clampLibraryWidth(drag.current.w + e.clientX - drag.current.x));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        saveLibraryWidth(clampLibraryWidth(drag.current.w + e.clientX - drag.current.x));
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => {
        onChange(LIBRARY_DEFAULT);
        saveLibraryWidth(LIBRARY_DEFAULT);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const w = clampLibraryWidth(width + (e.key === 'ArrowRight' ? 24 : -24));
        onChange(w);
        saveLibraryWidth(w);
      }}
    />
  );
}
