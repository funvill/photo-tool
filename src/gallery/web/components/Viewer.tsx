import { useEffect, useRef, useState } from 'react';
import { viewerNeighbours, viewerStep } from '../../../core/galleryViewer';
import { Icon } from '../../../web/components/Icon';
import { formatSize, formatTaken } from '../../../web/components/HoverPreview';
import { thumbUrl, type GalleryItem } from '../api';
import { selectVisible, useGallery, useVisibleItems } from '../store';

// The full-screen viewer: one photo at a time over the whole window, stepping through the grid's own
// list (filtered and sorted). Left/Right move, S or F stars or unstars, H hides or unhides, I shows the
// photo's details, Esc closes and selects the last photo shown. While it is open the page sees no other keys.

/** Keys whose browser default (scrolling the grid behind, moving focus, pressing a button) is kept from happening. */
const SWALLOWED = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Enter', 'Tab', 'Escape', 's', 'S', 'f', 'F', 'h', 'H', 'i', 'I']);

/** Where `path` is in `list`. A photo that has left the list (starred under a "not starred" filter) leaves the viewer on the one now in its place. */
function indexIn(list: GalleryItem[], path: string, last: number): number {
  const i = list.findIndex((p) => p.path === path);
  return i >= 0 ? i : Math.min(last, list.length - 1);
}

export function Viewer() {
  const viewing = useGallery((s) => s.viewing);
  return viewing === null ? null : <OpenViewer path={viewing} />;
}

function OpenViewer({ path }: { path: string }) {
  const items = useVisibleItems();
  const last = useRef(0);
  const index = indexIn(items, path, last.current);
  last.current = Math.max(0, index);
  const item: GalleryItem | undefined = items[index];
  const [details, setDetails] = useState(false);
  const [mark, setMark] = useState<{ on: boolean; n: number } | null>(null);
  const marks = useRef(0);
  // Stars asked for and not saved yet: S pressed twice quickly unstars again.
  const wanted = useRef(new Map<string, boolean>());

  // A field being typed in keeps its text: leaving it saves it before the viewer takes the keys.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);

  // The photo shown left the list: follow the one in its place, or close when none is left.
  useEffect(() => {
    const s = useGallery.getState();
    if (!item) s.closeViewer(null);
    else if (item.path !== path) s.viewPhoto(item.path);
  }, [item, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Caught on the way down, before the grid or anything else on the page sees it.
      e.stopPropagation();
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (SWALLOWED.has(e.key)) e.preventDefault();
      const s = useGallery.getState();
      if (s.viewing === null) return;
      const list = selectVisible(s);
      const i = indexIn(list, s.viewing, last.current);
      const shown = list[i];
      if (!shown) return;
      const step = viewerStep(i, list.length, e.key);
      if (step.action && e.repeat) return;
      if (step.action === 'close') s.closeViewer(shown.path);
      else if (step.action === 'details') setDetails((d) => !d);
      else if (step.action === 'hide') {
        // Hides the photo shown (only it, not a selection made before the viewer opened). When the
        // filter then leaves it out, the viewer moves on to the photo in its place.
        s.select(shown.path);
        void s.toggleFlag('hidden');
      }
      else if (step.action === 'star') {
        const on = !(wanted.current.get(shown.path) ?? shown.info.star === true);
        wanted.current.set(shown.path, on);
        setMark({ on, n: ++marks.current });
        void s.setStar(shown.path, on).finally(() => {
          if (wanted.current.get(shown.path) === on) wanted.current.delete(shown.path);
        });
      } else if (step.index !== i) s.viewPhoto(list[step.index].path);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // The next two and the previous two are loaded ahead, so stepping shows them at once.
  const around = viewerNeighbours(index, items.length).map((i) => items[i].key).join(',');
  const preloaded = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    preloaded.current = around ? around.split(',').map((key) => Object.assign(new Image(), { src: thumbUrl(key, 'm') })) : [];
  }, [around]);

  if (!item) return null;
  const starred = item.info.star === true;
  const hidden = item.info.hidden === true;
  return (
    <div className="gallery-viewer" role="dialog" aria-modal="true" aria-label="Photo viewer">
      <ViewerImage key={item.key} item={item} />
      <div className="gallery-viewer-bar">
        <strong className="ellipsis" title={item.path}>{item.fileName}</strong>
        {starred && (
          <span className="gallery-viewer-starred" aria-label="Starred">
            <Icon name="star" size={16} />
          </span>
        )}
        {hidden && (
          <span className="gallery-viewer-hidden" aria-label="Hidden">
            <Icon name="eye-off" size={16} />
          </span>
        )}
        <span className="gallery-viewer-count">{index + 1} / {items.length}</span>
        <span className="gallery-viewer-keys small">← → move · F or S favourite · H hide · I details · Esc close</span>
        <button type="button" className="icon-btn" aria-label="Close viewer" title="Close (Esc)" onClick={() => useGallery.getState().closeViewer(item.path)}>
          <Icon name="x" />
        </button>
      </div>
      {details && <ViewerDetails item={item} />}
      {mark && (
        <div key={mark.n} className={`gallery-viewer-mark ${mark.on ? 'on' : 'off'}`} aria-hidden="true" onAnimationEnd={() => setMark(null)}>
          <Icon name="star" size={180} />
        </div>
      )}
    </div>
  );
}

/** The 1600 px picture; the 400 px one when that is missing. */
function ViewerImage({ item }: { item: GalleryItem }) {
  const [small, setSmall] = useState(false);
  return <img className="gallery-viewer-img" src={thumbUrl(item.key, small ? 's' : 'm')} alt={item.fileName} draggable={false} onError={() => setSmall(true)} />;
}

/** What the details panel knows about the photo, read-only. */
function ViewerDetails({ item }: { item: GalleryItem }) {
  const people = Array.isArray(item.info.people) ? item.info.people.filter((p): p is string => typeof p === 'string') : [];
  const description = typeof item.info.description === 'string' ? item.info.description : '';
  return (
    <aside className="gallery-viewer-details" aria-label="Photo details">
      <strong className="gallery-viewer-name">{item.fileName}</strong>
      <dl>
        <dt>Taken</dt>
        <dd>{item.effectiveDate ? formatTaken(item.effectiveDate) : 'Unknown'}</dd>
        {item.camera && (
          <>
            <dt>Camera</dt>
            <dd>{item.camera}</dd>
          </>
        )}
        <dt>Size</dt>
        <dd>{item.width} × {item.height} px · {formatSize(item.size)}</dd>
        {people.length > 0 && (
          <>
            <dt>People</dt>
            <dd>{people.join(', ')}</dd>
          </>
        )}
        {description && (
          <>
            <dt>Description</dt>
            <dd>{description}</dd>
          </>
        )}
      </dl>
    </aside>
  );
}
