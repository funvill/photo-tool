// Which tiles of a long, square-tiled grid are on screen. Pure: the caller measures the scroll box
// and draws only `firstIndex..lastIndex`, each at row × (rowHeight + gap). Tiles stretch to fill the
// width, so `rowHeight` (the tile's side) is at least `tile` unless the box is narrower than one tile.

export interface GridWindow {
  cols: number;
  /** The side of one (square) tile, in px. */
  rowHeight: number;
  firstIndex: number;
  /** Inclusive; below `firstIndex` when there is nothing to draw. */
  lastIndex: number;
  totalHeight: number;
  /** Top of the first drawn row. */
  offsetTop: number;
}

export function gridWindow(o: { count: number; width: number; tile: number; gap: number; scrollTop: number; viewport: number; overscanRows?: number }): GridWindow {
  const { count, gap } = o;
  const overscan = o.overscanRows ?? 2;
  const width = Math.max(0, o.width);
  const cols = Math.max(1, Math.floor((width + gap) / (o.tile + gap)));
  const rowHeight = Math.max(1, (width - (cols - 1) * gap) / cols);
  const stride = rowHeight + gap;
  const rows = Math.ceil(Math.max(0, count) / cols);
  const totalHeight = rows > 0 ? rows * stride - gap : 0;
  const top = Math.max(0, o.scrollTop);
  const firstRow = Math.min(rows, Math.max(0, Math.floor(top / stride) - overscan));
  const endRow = Math.min(rows, Math.ceil((top + Math.max(0, o.viewport)) / stride) + overscan);
  return {
    cols,
    rowHeight,
    firstIndex: firstRow * cols,
    lastIndex: Math.min(count, endRow * cols) - 1,
    totalHeight,
    offsetTop: firstRow * stride,
  };
}
