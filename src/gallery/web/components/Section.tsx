import { useState, type ReactNode } from 'react';

const KEY = 'gallery.sections';

function readOpen(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeOpen(id: string, open: boolean) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...readOpen(), [id]: open }));
  } catch {
    // Storage switched off: the fold just isn't remembered.
  }
}

/** A part of the info panel with a header that folds it; open or folded is remembered per machine. */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => readOpen()[id] !== false);
  const toggle = () => {
    writeOpen(id, !open);
    setOpen(!open);
  };
  return (
    <section className="gallery-section">
      <button type="button" className="gallery-section-head" aria-expanded={open} aria-controls={`gallery-section-${id}`} onClick={toggle}>
        <span className="gallery-section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      <div id={`gallery-section-${id}`} className="gallery-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
