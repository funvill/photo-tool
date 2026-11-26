import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../../shared/web/components/Icon';
import { desktop } from '../../../shared/web/desktop';
import { useShallow } from 'zustand/react/shallow';
import { editActions, menuTargets, useGallery } from '../store';

// Right-click menu on a photo (a tile or the preview), in the editor's .ctx-menu style. Copy to
// clipboard and Show in file explorer act on the photo clicked; Copy path, Favourite, Hide and Delete
// on every selected photo when the clicked one is among them. What needs the desktop app is greyed
// out in a plain browser.

export interface PhotoMenuProps {
  x: number;
  y: number;
  /** The photo right-clicked. */
  path: string;
  onClose(): void;
}

/** Scrolls this soon after the menu opened are the right-click's own (see below). */
const SETTLE_MS = 200;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The review keys (move, favourite, hide, edit, delete): they act on the photos, so the menu goes away. */
const REVIEW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'f', 'F', 'h', 'H', 'e', 'E', 'Delete', '[', ']']);

/**
 * Text onto the clipboard. In the desktop app the main process does it (the app turns every web
 * permission down, the clipboard's included). In a browser, the page's own clipboard; the old copy
 * command (allowed right after a click) when that is refused.
 */
async function writeText(text: string) {
  if (desktop?.copyText) {
    const r = await desktop.copyText(text);
    if (!r.ok) throw new Error(r.error ?? "Couldn't copy.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (e) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw e;
  }
}

async function copyPaths(path: string) {
  const { toast } = useGallery.getState();
  try {
    await writeText(menuTargets(path).join('\n'));
    toast('success', 'Copied');
  } catch (e) {
    toast('error', `Couldn't copy the path: ${message(e)}`);
  }
}

async function copyImage(path: string) {
  const { toast } = useGallery.getState();
  try {
    const r = await desktop!.copyImage!(path);
    if (r.ok) toast('success', 'Copied');
    else toast('error', r.error ?? "Couldn't copy the photo.");
  } catch (e) {
    toast('error', `Couldn't copy the photo: ${message(e)}`);
  }
}

async function showInFolder(path: string) {
  try {
    const r = await desktop!.showPhotoInFolder!(path);
    if (!r.ok) useGallery.getState().toast('error', r.error ?? "Couldn't show the photo.");
  } catch (e) {
    useGallery.getState().toast('error', `Couldn't show the photo: ${message(e)}`);
  }
}

/** Delete, as the Delete key does it, on the photos the menu acts on. */
const trash = (path: string) => useGallery.getState().trashSelected(menuTargets(path));

/** Edit mode on the photo right-clicked (it is the selected one: a right-click selects it). */
function edit(path: string) {
  const s = useGallery.getState();
  if (s.selected !== path) s.select(path);
  s.startEdit(path);
}

export function PhotoMenu({ x, y, path, onClose }: PhotoMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // F and H act on the selected photo (every selected one when several are): the labels follow it.
  const selectedItem = useGallery((s) => s.items.find((i) => i.path === (s.selected ?? path)));
  const starred = selectedItem?.info.star === true;
  const hidden = selectedItem?.info.hidden === true;
  // Being edited, or its save is on its way (an edit started now would be lost when it lands).
  const editing = useGallery((s) => s.editing === path || s.savingPaths.includes(path));
  // Rotate and flip wait while a photo is in edit mode (Done or Cancel first).
  const anyEditing = useGallery((s) => s.editing !== null);
  // Save, Save as…, Save all and Revert to original, as the preview caption offers them for this photo.
  const actions = useGallery(useShallow((s) => {
    const item = s.items.find((i) => i.path === path);
    return item && s.editing === null ? editActions(s, item) : null;
  }));
  const saving = useGallery((s) => s.saving);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);

  useEffect(() => {
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => {
      if (REVIEW_KEYS.has(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Left to the review keys to act on; the menu would now be about another photo.
        onClose();
        return;
      }
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    // Any scroll (the grid, the details) moves the photo away from the menu. Except the one the right-click
    // itself may cause: selecting a tile half out of view scrolls the grid to show it, just as the menu opens.
    const opened = performance.now();
    const scrolled = () => performance.now() - opened > SETTLE_MS && onClose();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const go = (fn: () => unknown) => () => {
    onClose();
    void fn();
  };
  const { toggleFlag } = useGallery.getState();

  return (
    <div className="ctx-menu" ref={ref} style={pos} role="menu" aria-label="Photo" onContextMenu={(e) => e.preventDefault()}>
      <MenuItem icon="crop" label="Edit" hint="E" disabled={editing} onClick={go(() => edit(path))} />
      <MenuItem icon="rotate-left" label="Rotate left" hint="[" disabled={anyEditing} onClick={go(() => useGallery.getState().turnSelected('left'))} />
      <MenuItem icon="rotate" label="Rotate right" hint="]" disabled={anyEditing} onClick={go(() => useGallery.getState().turnSelected('right'))} />
      <MenuItem icon="swap" label="Flip horizontally" disabled={anyEditing} onClick={go(() => useGallery.getState().flipSelected())} />
      {actions?.save && (
        <>
          <MenuItem icon="check" label="Save" disabled={saving || !!actions.saveBlocked} title={actions.saveBlocked ?? actions.saveTitle} onClick={go(() => useGallery.getState().saveEdit(path))} />
          <MenuItem icon="download" label="Save as…" disabled={saving || !!actions.saveAsBlocked} title={actions.saveAsBlocked ?? undefined} onClick={go(() => useGallery.getState().saveEditAs(path))} />
        </>
      )}
      {!!actions?.saveAll && <MenuItem icon="check" label={`Save all (${actions.saveAll})`} disabled={saving} onClick={go(() => useGallery.getState().saveAllEdits())} />}
      {actions?.revert && <MenuItem icon="undo" label="Revert to original" disabled={saving} onClick={go(() => useGallery.getState().revertEdit(path))} />}
      <div className="ctx-sep" />
      <MenuItem icon="image" label="Copy to clipboard" disabled={!desktop?.copyImage} onClick={go(() => copyImage(path))} />
      <MenuItem icon="copy" label="Copy path to clipboard" onClick={go(() => copyPaths(path))} />
      <MenuItem icon="folder" label="Show in file explorer" disabled={!desktop?.showPhotoInFolder} onClick={go(() => showInFolder(path))} />
      <div className="ctx-sep" />
      <MenuItem icon="star" label={starred ? 'Unfavourite' : 'Favourite'} hint="F" onClick={go(() => toggleFlag('star'))} />
      <MenuItem icon={hidden ? 'eye' : 'eye-off'} label={hidden ? 'Unhide' : 'Hide'} hint="H" onClick={go(() => toggleFlag('hidden'))} />
      <div className="ctx-sep" />
      <MenuItem icon="trash" label="Delete" hint="Del" danger disabled={!desktop?.trashPhotos} onClick={go(() => trash(path))} />
    </div>
  );
}

function MenuItem({ icon, label, hint, title, disabled, danger, onClick }: { icon: string; label: string; hint?: string; title?: string; disabled?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={`ctx-item ${danger ? 'danger' : ''}`} disabled={disabled} title={title} onClick={onClick}>
      <Icon name={icon} size={14} />
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
}
