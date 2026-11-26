import { useEffect, useRef } from 'react';
import { pathIndex, preloadOrder } from '../../core/preloadWindow';
import { thumbUrl, type GalleryItem } from '../api';
import { imageCache } from '../imageCache';

/**
 * The preview pane steps through the shown list (the grid's order, or the timeline's date order): around
 * the selected photo, the next 20 and the previous 5 in that order (the other way round after a step
 * back) are loaded into the image cache it shows from. Not while the viewer is open: it asks for its own.
 * When the list's view goes away (the map shown instead, another folder) its photos are no longer wanted.
 */
export function usePreviewPreload(items: GalleryItem[], selected: string | null, viewing: string | null) {
  const at = selected === null ? undefined : pathIndex(items).get(selected);
  const went = useRef<{ index: number; direction: 1 | -1 }>({ index: -1, direction: 1 });
  useEffect(() => {
    if (viewing !== null || at === undefined) return;
    const last = went.current;
    const direction = last.index < 0 || at === last.index ? last.direction : at < last.index ? -1 : 1;
    went.current = { index: at, direction };
    imageCache.want([at, ...preloadOrder(at, items.length, { direction })].map((i) => thumbUrl(items[i].key, 'm')));
  }, [at, items, viewing]);
  useEffect(() => () => imageCache.want([]), []);
}
