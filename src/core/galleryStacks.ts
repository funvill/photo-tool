import type { GalleryFacts, GalleryItemLike } from './gallerySort';

// Stacks fold the near-identical shots of a burst (the facts' groupId) into one tile, so a folder of
// bursts reads as one photo per moment. Free of any UI; the grid just draws what this returns.

export interface StackInfo {
  /** The burst's group id. */
  id: string;
  /** How many members pass the filter (the "×N" badge). */
  size: number;
  open: boolean;
  /** The stack's face; the other members only appear while it is open. */
  top: boolean;
}

/**
 * `sorted` (already filtered and sorted) with each burst folded into its top: the first starred member,
 * else the burst's keeper, else the first member shown. The stack sits where its top sorts; when open, the
 * other members follow it in sort order. A burst with one shown member is a plain photo. `stackOf` has an
 * entry for every shown member of a stack of two or more.
 */
export function stackItems<T extends GalleryItemLike>(
  sorted: T[],
  facts: Map<string, GalleryFacts>,
  open: ReadonlySet<string>,
): { items: T[]; stackOf: Map<string, StackInfo> } {
  const members = new Map<string, T[]>();
  for (const item of sorted) {
    const id = facts.get(item.path)?.groupId;
    if (!id) continue;
    const list = members.get(id);
    if (list) list.push(item);
    else members.set(id, [item]);
  }

  const topOf = new Map<string, T>();
  for (const [id, list] of members) {
    if (list.length < 2) continue;
    topOf.set(id, list.find((m) => m.info.star === true) ?? list.find((m) => facts.get(m.path)?.isKeeper) ?? list[0]);
  }

  const items: T[] = [];
  const stackOf = new Map<string, StackInfo>();
  for (const item of sorted) {
    const id = facts.get(item.path)?.groupId;
    const top = id ? topOf.get(id) : undefined;
    if (!id || !top) {
      items.push(item);
      continue;
    }
    if (item !== top) continue;
    const list = members.get(id)!;
    const isOpen = open.has(id);
    items.push(item);
    stackOf.set(item.path, { id, size: list.length, open: isOpen, top: true });
    if (!isOpen) continue;
    for (const other of list) {
      if (other === top) continue;
      items.push(other);
      stackOf.set(other.path, { id, size: list.length, open: true, top: false });
    }
  }
  return { items, stackOf };
}
