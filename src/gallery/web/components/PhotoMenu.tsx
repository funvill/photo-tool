import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dragPaths } from '../../../core/galleryViewer';
import { Icon } from '../../../web/components/Icon';
import { desktop } from '../../../web/desktop';
import { selectVisible, useGallery } from '../store';

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
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The selected photos in grid order when `path` is one of them, else just `path`. */
function targetsFor(path: string): string[] {
  const s = useGallery.getState();
  return dragPaths(selectVisible(s).map((i) => i.path), s.selection, path);
}

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
    await writeText(targetsFor(path).join('\n'));
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

async function trash(path: string) {
  const { toast } = useGallery.getState();
  try {
    const r = await desktop!.trashPhotos!(targetsFor(path));
    if (r.cancelled) return;
    if (r.trashed.length) useGallery.getState().removeItems(r.trashed);
    if (r.failed.length) {
      const first = r.failed[0];
      toast('error', `Couldn't move ${r.failed.length === 1 ? fileName(first.path) : plural(r.failed.length, 'photo')} to the Recycle Bin: ${first.message}`);
    }
  } catch (e) {
    toast('error', `Couldn't delete: ${message(e)}`);
  }
}

export function PhotoMenu({ x, y, path, onClose }: PhotoMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // F and H act on the selected photo (every selected one when several are): the labels follow it.
  const selectedItem = useGallery((s) => s.items.find((i) => i.path === (s.selected ?? path)));
  const starred = selectedItem?.info.star === true;
  const hidden = selectedItem?.info.hidden === true;

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);

  useEffect(() => {
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => {
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
      <MenuItem icon="image" label="Copy to clipboard" disabled={!desktop?.copyImage} onClick={go(() => copyImage(path))} />
      <MenuItem icon="copy" label="Copy path to clipboard" onClick={go(() => copyPaths(path))} />
      <MenuItem icon="folder" label="Show in file explorer" disabled={!desktop?.showPhotoInFolder} onClick={go(() => showInFolder(path))} />
      <div className="ctx-sep" />
      <MenuItem icon="star" label={starred ? 'Unfavourite' : 'Favourite'} hint="F" onClick={go(() => toggleFlag('star'))} />
      <MenuItem icon={hidden ? 'eye' : 'eye-off'} label={hidden ? 'Unhide' : 'Hide'} hint="H" onClick={go(() => toggleFlag('hidden'))} />
      <div className="ctx-sep" />
      <MenuItem icon="trash" label="Delete" danger disabled={!desktop?.trashPhotos} onClick={go(() => trash(path))} />
    </div>
  );
}

function MenuItem({ icon, label, hint, disabled, danger, onClick }: { icon: string; label: string; hint?: string; disabled?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={`ctx-item ${danger ? 'danger' : ''}`} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={14} />
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
}
