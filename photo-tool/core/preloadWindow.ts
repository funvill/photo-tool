// Which photos to load ahead of time around the one on screen, so stepping shows the next one at once
// (issue #5). Free of any UI: the viewer, the preview and the grid all ask the same question.

export interface PreloadOptions {
  /** How many photos to load in the direction of travel (default 20). */
  ahead?: number;
  /** How many photos to load the other way (default 5). */
  behind?: number;
  /** The last step's direction: 1 forward (the default), -1 backward, which swaps ahead and behind. */
  direction?: 1 | -1;
}

/** How many photos in the direction of travel come before the first one behind. */
const LEAD = 3;

/**
 * The places to load around photo `index` of `count`, most wanted first: the next three, then the
 * previous one, then the rest of the photos ahead, then the rest behind. Stepping backward, "next" is
 * the photo before. Never `index` itself, never one twice, nothing outside the list.
 */
export function preloadOrder(index: number, count: number, opts: PreloadOptions = {}): number[] {
  if (index < 0 || index >= count) return [];
  const ahead = Math.max(0, opts.ahead ?? 20);
  const behind = Math.max(0, opts.behind ?? 5);
  const dir = opts.direction ?? 1;
  const at = (k: number) => index + dir * k;
  const order: number[] = [];
  const add = (i: number) => {
    if (i >= 0 && i < count) order.push(i);
  };
  const lead = Math.min(LEAD, ahead);
  for (let k = 1; k <= lead; k++) add(at(k));
  if (behind > 0) add(at(-1));
  for (let k = lead + 1; k <= ahead; k++) add(at(k));
  for (let k = 2; k <= behind; k++) add(at(-k));
  return order;
}

const indexes = new WeakMap<readonly { path: string }[], Map<string, number>>();

/** Each photo's place in `list`, by path: built once per list (lists are new arrays whenever they change). */
export function pathIndex(list: readonly { path: string }[]): Map<string, number> {
  let map = indexes.get(list);
  if (!map) {
    map = new Map(list.map((p, i) => [p.path, i]));
    indexes.set(list, map);
  }
  return map;
}
