// The gallery program's part of the main process (`--gallery [folder]`): its page, its File menu,
// handing it folders to open, and starting it from the editor. main.ts runs everything else
// (the server, hardening, the window) the same way for both programs.
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainEvent, type MenuItemConstructorOptions } from 'electron';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseMode } from './config';

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
 * listens (its preload says 'gallery:ready-for-folders'); until then the latest one waits.
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
