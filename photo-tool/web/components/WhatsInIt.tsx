import { useEffect, useState } from 'react';
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
  const { state, description, keywords, objects } = item.tags;
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
