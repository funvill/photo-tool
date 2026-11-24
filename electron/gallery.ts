// The gallery program's part of the main process (`--gallery [folder]`): its page, its File menu,
// handing it folders to open, and starting it from the editor. main.ts runs everything else
// (the server, hardening, the window) the same way for both programs.
import { app, dialog, ipcMain, nativeImage, type BrowserWindow, type IpcMainEvent, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMode } from './config';
import { dragFiles, MAX_DRAG_FILES, type DragCheck } from './drag';

export const GALLERY_DESCRIPTION = 'Look through a folder of photos, star the best ones and drag them into other programs. Works offline.';

/** The gallery's page on the server (or, in development, the Vite dev server) at `base`. */
export function galleryPage(base: string): string {
  return new URL('/gallery.html', base).href;
}

/** What a second launch hands over (see requestSingleInstanceLock): Chromium may reorder the argv it passes itself. */
export interface LaunchData {
  argv: string[];
  cwd: string;
}

/**
 * Folders for the page to open: one given at start (`--gallery <folder>`), from a second launch,
 * or from File > Open folder. Each goes to the page over 'gallery:open-folder' once the page
 * listens (its preload says 'gallery:ready-for-folders'); until then the latest one waits. It waits
 * again once the page stops listening ('gallery:not-ready-for-folders') or reloads.
 */
export function galleryFolders(o: { window: () => BrowserWindow | null; fromApp: (e: IpcMainEvent) => boolean; log: (...a: unknown[]) => void }, startFolder: string | null) {
  let pending: string | null = startFolder ? resolve(startFolder) : null;
  let listening = false;

  const open = (folder: string) => {
    const w = o.window();
    o.log('gallery: open folder', folder);
    if (w && !w.isDestroyed() && listening) w.webContents.send('gallery:open-folder', folder);
    else pending = folder;
  };

  ipcMain.on('gallery:ready-for-folders', (e) => {
    if (!o.fromApp(e)) return;
    listening = true;
    if (pending) e.sender.send('gallery:open-folder', pending);
    pending = null;
  });
  // The page's last listener stopped (its preload says so): folders wait again until it listens.
  ipcMain.on('gallery:not-ready-for-folders', (e) => {
    if (!o.fromApp(e)) return;
    listening = false;
  });

  return {
    /** Call for the gallery's window: a reloading page listens again only once it has loaded. */
    watch(w: BrowserWindow) {
      w.webContents.on('did-start-loading', () => (listening = false));
    },
    /** A second `--gallery <folder>` launch (main.ts has already brought the window forward). */
    secondInstance(data: unknown) {
      const d = data as Partial<LaunchData> | null;
      if (!d || !Array.isArray(d.argv)) return;
      const { folder } = parseMode(d.argv.map(String));
      if (folder) open(resolve(typeof d.cwd === 'string' ? d.cwd : process.cwd(), folder));
    },
    /** The gallery's own File menu items (main.ts adds the data folder and Quit). */
    fileMenu(): MenuItemConstructorOptions[] {
      return [
        {
          label: '&Open folder…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const w = o.window();
            const options = { title: 'Open a folder of photos', properties: ['openDirectory' as const] };
            const r = w && !w.isDestroyed() ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
            if (!r.canceled && r.filePaths[0]) open(r.filePaths[0]);
          },
        },
        { type: 'separator' },
      ];
    },
  };
}

/** The drag icon's longest side, in px (the small thumbnail is 400 px). */
const DRAG_ICON_PX = 128;
const DRAG_CHECK_TIMEOUT_MS = 3000;

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The first photo's small thumbnail, or (when it has none) a plain grey square: a drag needs an icon. */
function dragIcon(thumb: string | null): NativeImage {
  const image = thumb ? nativeImage.createFromPath(thumb) : nativeImage.createEmpty();
  if (!image.isEmpty()) {
    const { width, height } = image.getSize();
    return width >= height ? image.resize({ width: Math.min(width, DRAG_ICON_PX) }) : image.resize({ height: Math.min(height, DRAG_ICON_PX) });
  }
  const side = 48;
  return nativeImage.createFromBitmap(Buffer.alloc(side * side * 4, 0x88), { width: side, height: side });
}

/** Which of `paths` the gallery's own server (on 127.0.0.1) has catalogued, and the first one's thumbnail. */
async function dragCheck(port: number, paths: string[]): Promise<DragCheck> {
  const res = await fetch(`http://127.0.0.1:${port}/api/gallery/drag-check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths }),
    signal: AbortSignal.timeout(DRAG_CHECK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`drag-check answered ${res.status}`);
  const body = (await res.json()) as Partial<DragCheck>;
  return {
    paths: Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [],
    icon: typeof body.icon === 'string' ? body.icon : null,
  };
}

/**
 * Dragging photos out of the gallery window ('gallery:start-drag', sent by the page on a tile's
 * dragstart): the original files, only those the gallery's server has catalogued and that are still
 * on disk, at most MAX_DRAG_FILES. Nothing happens when none is left.
 */
export function galleryDrag(o: { fromApp: (e: IpcMainEvent) => boolean; serverPort: () => number; log: (...a: unknown[]) => void }) {
  ipcMain.on('gallery:start-drag', (e, requested: unknown) => {
    if (!o.fromApp(e) || !Array.isArray(requested)) return;
    const paths = requested.filter((p): p is string => typeof p === 'string' && p !== '').slice(0, MAX_DRAG_FILES);
    if (!paths.length) return;
    void (async () => {
      let check: DragCheck;
      try {
        check = await dragCheck(o.serverPort(), paths);
      } catch (err) {
        o.log('drag: could not check the files with the server', String(err));
        return;
      }
      const catalogued = new Set(check.paths);
      const files = dragFiles(paths, (p) => catalogued.has(p), isFile);
      if (!files.length || e.sender.isDestroyed()) return;
      o.log('drag', { files: files.length });
      e.sender.startDrag({ file: files[0], files, icon: dragIcon(check.icon) });
    })();
  });
}

/**
 * Start the gallery program from the editor: this same executable with `--gallery`, on its own.
 * When the gallery is already running, that copy just brings its window forward and exits.
 */
export function launchGallery(log: (...a: unknown[]) => void) {
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--gallery'];
  const env = { ...process.env };
  // A development editor's Vite dev server and API port are its own: the gallery must not take them.
  delete env.PHOTOBOOK_DESKTOP_DEV_URL;
  delete env.PHOTOBOOK_PORT;
  delete env.PHOTOBOOK_WEB_PORT;
  delete env.ELECTRON_RUN_AS_NODE;
  log('starting the gallery', { execPath: process.execPath, args });
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
  child.once('error', (e) => log('could not start the gallery', String(e)));
  child.unref();
}
