import type { DesktopApi } from '../../shared/desktopApi';

// The Map tab's answer to "Load maps from the internet?". In the desktop app the main process keeps
// it (its request guard lets map tiles through only while it is true); in a plain browser (the dev
// web build, the e2e tests) the page keeps it in localStorage.

const KEY = 'gallery.mapsOnline';

/** null: not asked yet. */
export async function loadMapConsent(d: Pick<DesktopApi, 'getMapConsent'> | undefined): Promise<boolean | null> {
  if (d?.getMapConsent) {
    try {
      const v = await d.getMapConsent();
      return typeof v === 'boolean' ? v : null;
    } catch {
      return null;
    }
  }
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === 'true' ? true : v === 'false' ? false : null;
  } catch {
    return null;
  }
}

export async function saveMapConsent(d: Pick<DesktopApi, 'setMapConsent'> | undefined, on: boolean): Promise<void> {
  if (d?.setMapConsent) {
    await d.setMapConsent(on);
    return;
  }
  try {
    globalThis.localStorage?.setItem(KEY, String(on));
  } catch {
    // Private mode or storage switched off: the answer just isn't remembered.
  }
}
