import { useRef } from 'react';

/** A panel width remembered in localStorage under `key`: the saved one when it is a number, else `fallback`. */
export function savedWidth(key: string, fallback: number): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(key));
    return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
  } catch {
    return fallback;
  }
}

export function saveWidth(key: string, px: number) {
  try {
    globalThis.localStorage?.setItem(key, String(Math.round(px)));
  } catch {
    // Private mode or storage switched off: the width just isn't remembered.
  }
}

export interface SplitterProps {
  /** What it resizes, for screen readers ("Resize thumbnail column"). */
  label: string;
  /** The panel's width now (px) and the range it may take. */
  value: number;
  min: number;
  max: number;
  /** 1: the panel is on the left (dragging right widens it); -1: it is on the right. */
  dir: 1 | -1;
  /** While dragging. */
  onChange(px: number): void;
  /** The button was let go: the width to remember. */
  onCommit(px: number): void;
}

/** A 6 px vertical handle between two columns; drag it to move the boundary. */
export function Splitter({ label, value, min, max, dir, onChange, onCommit }: SplitterProps) {
  const drag = useRef<{ x: number; start: number; last: number } | null>(null);
  const clamp = (px: number) => Math.round(Math.max(min, Math.min(px, Math.max(min, max))));

  return (
    <div
      className="gallery-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: value, last: value };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clamp(d.start + dir * (e.clientX - d.x));
        onChange(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        onCommit(d.last);
      }}
      onLostPointerCapture={() => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        onCommit(d.last);
      }}
    />
  );
}
