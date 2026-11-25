import type { DesktopApi } from '../../shared/desktop/desktopApi';

// Settings' "When I save an edit": change only the photo's info file ('info', the default) or the photo
// file itself ('file'). In the desktop app the main process keeps it in the gallery's settings file; in a
// plain browser (the dev web build, the e2e tests) the page keeps it in localStorage.

export type EditTarget = 'info' | 'file';

const KEY = 'gallery.editTarget';

const asTarget = (v: unknown): EditTarget => (v === 'file' ? 'file' : 'info');

export async function loadEditTarget(d: Pick<DesktopApi, 'getEditTarget'> | undefined): Promise<EditTarget> {
  if (d?.getEditTarget) {
    try {
      return asTarget(await d.getEditTarget());
    } catch {
      return 'info';
    }
  }
  try {
    return asTarget(globalThis.localStorage?.getItem(KEY));
  } catch {
    return 'info';
  }
}

export async function saveEditTarget(d: Pick<DesktopApi, 'setEditTarget'> | undefined, target: EditTarget): Promise<void> {
  if (d?.setEditTarget) {
    await d.setEditTarget(target);
    return;
  }
  try {
    globalThis.localStorage?.setItem(KEY, target);
  } catch {
    // Private mode or storage switched off: the choice just isn't remembered.
  }
}
