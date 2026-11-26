import { useEffect, useRef } from 'react';
import { Icon } from './Icon';

// The keyboard shortcuts, over the page (? in Photo Tool, or Help > Keyboard shortcuts). Shared, so the
// Photobook Editor can show its own table the same way. While it is open it takes every key: ? again or
// Esc closes it (so does a click outside it), and the keys meant for what is under it do nothing.

export interface ShortcutRow {
  /** One string per alternative; a combination joined by + ('Ctrl+Z'). */
  keys: readonly string[];
  does: string;
}

export interface ShortcutGroup {
  title: string;
  rows: readonly ShortcutRow[];
}

export function ShortcutOverlay({ groups, onClose }: { groups: readonly ShortcutGroup[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    // Focus goes back where it was when the list closes.
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (plain && (e.key === '?' || e.key === 'Escape')) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) close.current();
      } else if (e.key !== 'Tab') {
        // Not for the grid, the viewer or edit mode under the list.
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (before && document.contains(before)) before.focus?.();
    };
  }, []);

  return (
    <div className="shortcut-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="shortcut-overlay" role="dialog" aria-modal="true" aria-labelledby="shortcut-title" tabIndex={-1}>
        <div className="shortcut-head">
          <h2 id="shortcut-title">Keyboard shortcuts</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="x" />
          </button>
        </div>
        {groups.map((g) => (
          <section key={g.title} className="shortcut-group" aria-label={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.rows.map((r) => (
                <div key={r.keys.join() + r.does} className="shortcut-row">
                  <dt>
                    {r.keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="shortcut-or"> or </span>}
                        {k.split(/\+(?=.)/).map((part, j) => (
                          <span key={j}>
                            {j > 0 && '+'}
                            <kbd>{part}</kbd>
                          </span>
                        ))}
                      </span>
                    ))}
                  </dt>
                  <dd>{r.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
