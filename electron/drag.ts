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

/** The gallery server's answer to POST /api/gallery/drag-check. */
export interface DragCheck {
  /** The asked-for paths the server has catalogued, in the order asked. */
  paths: string[];
  /** The first of them's small (400 px) thumbnail file, or null when it has none on disk. */
  icon: string | null;
}
