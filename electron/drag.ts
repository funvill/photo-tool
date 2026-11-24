// Dragging photos out of the gallery window, the part free of Electron (see gallery.ts for the rest).

/** The most files one drag takes. */
export const MAX_DRAG_FILES = 500;

/**
 * The files a drag may take, in the order asked: only ones the gallery's server has catalogued
 * and that are still on disk, at most MAX_DRAG_FILES.
 */
export function dragFiles(requested: string[], catalogued: (p: string) => boolean, exists: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const p of requested) {
    if (out.length >= MAX_DRAG_FILES) break;
    if (typeof p === 'string' && catalogued(p) && exists(p)) out.push(p);
  }
  return out;
}

/** What the page asked to drag, taken on trust only as far as this: non-empty strings, at most MAX_DRAG_FILES. */
export function dragRequest(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p !== '').slice(0, MAX_DRAG_FILES) : [];
}

/** How long a drag checked on pointerdown stays good for the drag that follows. */
export const PREPARED_DRAG_MS = 10_000;

/**
 * A drag checked ahead, when the mouse button went down on a tile: Windows starts the drag from the
 * mouse as it is, so by dragstart there is no time left to ask the server.
 */
export interface PreparedDrag {
  /** What the page asked to drag. */
  requested: string[];
  /** Of those, the catalogued files that were on disk. */
  files: string[];
  /** The first one's small thumbnail, or null. */
  icon: string | null;
  /** When it was checked (ms). */
  at: number;
}

/** The prepared drag, when it was made for exactly `requested` (same paths, same order) at most PREPARED_DRAG_MS before `now`; else null. */
export function preparedDragFor(prepared: PreparedDrag | undefined, requested: readonly string[], now: number): PreparedDrag | null {
  if (!prepared || now - prepared.at > PREPARED_DRAG_MS || now < prepared.at) return null;
  return sameDragList(prepared.requested, requested) ? prepared : null;
}

/** The same paths in the same order. */
export function sameDragList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** The gallery server's answer to POST /api/gallery/drag-check. */
export interface DragCheck {
  /** The asked-for paths the server has catalogued, in the order asked. */
  paths: string[];
  /** The first of them's small (400 px) thumbnail file, or null when it has none on disk. */
  icon: string | null;
}
