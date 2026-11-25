import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TagFilter } from '../../core/gallerySort';
import { galleryApi, type GalleryItem } from '../api';
import { useGallery } from '../store';

/** The label of the model chosen for descriptions ("" while not known), read again when Settings closes. */
function useDescribeModel(): string {
  const settingsOpen = useGallery((s) => s.settingsOpen);
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (settingsOpen) return;
    let live = true;
    galleryApi
      .models()
      .then((m) => live && setLabel(m.catalogue.find((c) => c.id === m.settings.describe)?.label ?? ''))
      .catch(() => {
        // Only the tooltip goes without it.
      });
    return () => void (live = false);
  }, [settingsOpen]);
  return label;
}

// Photos being described again, by path. Kept outside the component so the busy state lasts while the panel is
// folded, closed or showing another photo, and a second request for the same photo is not sent.
const writing = new Set<string>();
const writingListeners = new Set<() => void>();
const subscribeWriting = (fn: () => void) => {
  writingListeners.add(fn);
  return () => void writingListeners.delete(fn);
};
const setWriting = (path: string, on: boolean) => {
  if (on) writing.add(path);
  else writing.delete(path);
  for (const fn of writingListeners) fn();
};

async function regenerate(path: string): Promise<void> {
  if (writing.has(path)) return;
  setWriting(path, true);
  try {
    await useGallery.getState().regenerateDescription(path);
  } finally {
    setWriting(path, false);
  }
}

function Chip({ f, text }: { f: TagFilter; text: string }) {
  const on = useGallery((s) => !!s.filter.tags?.some((t) => t.kind === f.kind && t.value === f.value));
  return (
    <button type="button" className={`gallery-chip${on ? ' on' : ''}`} aria-pressed={on} title={on ? 'Stop filtering by this' : 'Show only photos with this'} onClick={() => useGallery.getState().toggleTagFilter(f)}>
      {text}
    </button>
  );
}

/**
 * The info panel's "What's in it": what photo tagging found in the photo (a sentence, keywords, objects).
 * A keyword or object is a button that filters the grid to the photos having it.
 */
export function WhatsInIt({ item }: { item: GalleryItem }) {
  const notWorking = useGallery((s) => s.tagging?.notWorking.length ?? 0) > 0;
  const model = useDescribeModel();
  const busy = useSyncExternalStore(subscribeWriting, () => writing.has(item.path));
  const { state, description, keywords, objects, canRegenerate } = item.tags;
  if (state === 'off') {
    return (
      <p className="muted small">
        Tagging is off.{' '}
        <a
          href="#settings"
          className="gallery-link-btn"
          onClick={(e) => {
            e.preventDefault();
            useGallery.getState().setSettingsOpen(true);
          }}
        >
          Settings
        </a>
      </p>
    );
  }
  return (
    <div className="gallery-whatsinit">
      {notWorking && <p className="gallery-note gallery-note-error small">Not working: a chosen model is damaged or would not load. See Settings.</p>}
      {state === 'waiting' && !description && !keywords.length && !objects.length && <p className="muted small">Not looked at yet</p>}
      {state === 'failed' && <p className="gallery-note gallery-note-error small">Couldn&apos;t look at this photo</p>}
      {description && (
        <p className="gallery-whatsinit-description" title={model ? `Written by ${model}` : undefined}>
          {description}
        </p>
      )}
      {description && canRegenerate && (
        <button
          type="button"
          className="btn btn-small gallery-whatsinit-regenerate"
          disabled={busy}
          aria-busy={busy}
          aria-label={busy ? undefined : 'Regenerate the description'}
          title={busy ? undefined : `Ask ${model || 'the descriptions model'} to describe this photo again`}
          onClick={() => void regenerate(item.path)}
        >
          {busy ? 'Writing a new description…' : 'Regenerate'}
        </button>
      )}
      {keywords.length > 0 && (
        <div className="gallery-chip-row" role="group" aria-label="Keywords">
          <span className="muted small">Keywords</span>
          {keywords.map((k) => (
            <Chip key={k} f={{ kind: 'keyword', value: k }} text={k} />
          ))}
        </div>
      )}
      {objects.length > 0 && (
        <div className="gallery-chip-row" role="group" aria-label="Objects">
          <span className="muted small">Objects</span>
          {objects.map((o) => (
            <Chip key={o.label} f={{ kind: 'object', value: o.label }} text={o.count > 1 ? `${o.label} ×${o.count}` : o.label} />
          ))}
        </div>
      )}
    </div>
  );
}
