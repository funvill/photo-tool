// The gallery program's part of the main process (`--gallery [folder]`): its page, its File menu,
// handing it folders to open, and starting it from the editor. main.ts runs everything else
// (the server, hardening, the window) the same way for both programs.
import { app, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type NativeImage, type WebContents } from 'electron';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { galleryLaunchCommand, parseMode } from './config';
import { dragFiles, dragRequest, preparedDragFor, sameDragList, type DragCheck, type PreparedDrag } from './drag';
import { copyTextRequest, trashConfirm, trashPhotos, type TrashResult } from './fileActions';
import { readMapConsent, writeMapConsent } from './mapTiles';

export const GALLERY_DESCRIPTION = 'Look through a folder of photos, star the best ones and drag them into other programs. Uses the network only for map tiles, and only if you choose Load maps.';

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

const DRAG_FAILED = "Couldn't drag the photos: the gallery did not answer in time. Try again.";

/**
 * Dragging photos out of the gallery window: the original files, only those the gallery's server has
 * catalogued and that are still on disk, at most MAX_DRAG_FILES. Nothing happens when none is left.
 *
 * Windows starts a drag from the mouse as it is when startDrag is called, so a drag that waits for
 * the server can miss a quick flick. The page therefore sends 'gallery:prepare-drag' when the mouse
 * button goes down on a tile, and the files are checked then; on 'gallery:start-drag' (dragstart) for
 * that same list the drag starts at once. Any other drag is checked then, the slower way. A check that
 * fails is told to the page ('gallery:drag-failed').
 */
export function galleryDrag(o: { fromApp: (e: IpcMainEvent) => boolean; serverPort: () => number; log: (...a: unknown[]) => void }) {
  // Per gallery page (its webContents id): the drag checked on the last pointerdown, or one being checked.
  const prepared = new Map<number, PreparedDrag>();
  const preparing = new Map<number, { requested: string[]; done: Promise<PreparedDrag> }>();
  const watched = new Set<number>();
  const forget = (sender: WebContents) => {
    if (watched.has(sender.id)) return;
    watched.add(sender.id);
    const id = sender.id;
    sender.once('destroyed', () => {
      prepared.delete(id);
      preparing.delete(id);
      watched.delete(id);
    });
  };

  const check = async (requested: string[]): Promise<PreparedDrag> => {
    const reply = await dragCheck(o.serverPort(), requested);
    const catalogued = new Set(reply.paths);
    return { requested, files: dragFiles(requested, (p) => catalogued.has(p), isFile), icon: reply.icon, at: Date.now() };
  };

  const start = (sender: WebContents, p: PreparedDrag) => {
    // Looked at again now (synchronously): a file may have gone since the button went down.
    const files = p.files.filter(isFile);
    if (!files.length || sender.isDestroyed()) return;
    o.log('drag', { files: files.length });
    sender.startDrag({ file: files[0], files, icon: dragIcon(p.icon) });
  };

  ipcMain.on('gallery:prepare-drag', (e, raw: unknown) => {
    if (!o.fromApp(e)) return;
    const id = e.sender.id;
    forget(e.sender);
    prepared.delete(id);
    preparing.delete(id);
    const requested = dragRequest(raw);
    if (!requested.length) return;
    const entry = { requested, done: check(requested) };
    preparing.set(id, entry);
    entry.done.then(
      (p) => {
        if (preparing.get(id) !== entry) return;
        preparing.delete(id);
        prepared.set(id, p);
      },
      (err) => {
        if (preparing.get(id) === entry) preparing.delete(id);
        o.log('drag: could not check the files ahead', String(err));
      },
    );
  });

  ipcMain.on('gallery:start-drag', (e, raw: unknown) => {
    if (!o.fromApp(e)) return;
    const requested = dragRequest(raw);
    if (!requested.length) return;
    const sender = e.sender;
    const ready = preparedDragFor(prepared.get(sender.id), requested, Date.now());
    if (ready) return start(sender, ready);
    // Not checked ahead for this list: wait for the check under way, or make one.
    const pending = preparing.get(sender.id);
    const done = pending && sameDragList(pending.requested, requested) ? pending.done : check(requested);
    done.then(
      (p) => start(sender, p),
      (err) => {
        o.log('drag: could not check the files with the server', String(err));
        if (!sender.isDestroyed()) sender.send('gallery:drag-failed', DRAG_FAILED);
      },
    );
  });
}

const IMAGE_TIMEOUT_MS = 60_000;
const FILE_CHECK_TIMEOUT_MS = 3000;
const REMOVED_TIMEOUT_MS = 10_000;

/** The full-size PNG of a catalogued photo, from the gallery's own server. */
async function fullImage(port: number, path: string): Promise<Buffer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/gallery/image?${new URLSearchParams({ path })}`, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`image answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Which of `paths` are photos of a folder the gallery has open now, in the order asked (the server's
 * file-check). Stricter than the drag-check: a photo catalogued in an earlier session is refused.
 */
async function fileCheck(port: number, paths: string[]): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/gallery/file-check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths }),
    signal: AbortSignal.timeout(FILE_CHECK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`file-check answered ${res.status}`);
  const body = (await res.json()) as { paths?: unknown };
  return Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [];
}

/** Tell the gallery's server these photos went to the Recycle Bin. */
async function tellRemoved(port: number, paths: string[]): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/gallery/removed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths }),
    signal: AbortSignal.timeout(REMOVED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`removed answered ${res.status}`);
}

type ActionReply = { ok: boolean; error?: string };
const NOT_A_PHOTO = "That photo is not in the open folder any more.";
const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The gallery's right-click menu actions: copy the picture or the paths, show the photo in the file
 * manager, move photos to the Recycle Bin. A file action asks the gallery's server first which paths are
 * photos of a folder open now (the file-check), and acts only on those that are files. Only for the
 * gallery's own page (`fromApp`) in its own window. A delete is only ever `shell.trashItem`, after a
 * native confirm.
 */
export function galleryFileActions(o: { window: () => BrowserWindow | null; fromApp: (e: IpcMainInvokeEvent) => boolean; serverPort: () => number; log: (...a: unknown[]) => void }) {
  /** From the gallery's page in the gallery's window. */
  const allowed = (e: IpcMainInvokeEvent) => {
    const w = o.window();
    return o.fromApp(e) && !!w && !w.isDestroyed() && e.sender === w.webContents;
  };
  const inOpenFolder = async (paths: string[]) => (await fileCheck(o.serverPort(), paths)).filter(isFile);
  /** The one photo the page named, when it is a photo of the open folder and a file; else null. */
  const onePhoto = async (raw: unknown) => {
    const [path] = dragRequest([raw]);
    return path ? ((await inOpenFolder([path]))[0] ?? null) : null;
  };

  // Copy path: the page's own clipboard needs a web permission the desktop app turns down.
  ipcMain.handle('gallery:copy-text', async (e, raw: unknown): Promise<ActionReply> => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed' };
    const text = copyTextRequest(raw);
    if (text === null) return { ok: false, error: 'Nothing to copy.' };
    try {
      await clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      o.log('copy text failed', String(err));
      return { ok: false, error: `Couldn't copy: ${failure(err)}` };
    }
  });

  ipcMain.handle('gallery:copy-image', async (e, raw: unknown): Promise<ActionReply> => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed' };
    try {
      const path = await onePhoto(raw);
      if (!path) return { ok: false, error: NOT_A_PHOTO };
      const png = await fullImage(o.serverPort(), path);
      // Only a picture Electron itself can read goes on the clipboard.
      if (nativeImage.createFromBuffer(png).isEmpty()) return { ok: false, error: "Couldn't read that photo." };
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
      return { ok: true };
    } catch (err) {
      o.log('copy image failed', String(err));
      return { ok: false, error: `Couldn't copy the photo: ${failure(err)}` };
    }
  });

  ipcMain.handle('gallery:show-in-folder', async (e, raw: unknown): Promise<ActionReply> => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed' };
    try {
      const path = await onePhoto(raw);
      if (!path) return { ok: false, error: NOT_A_PHOTO };
      shell.showItemInFolder(path);
      return { ok: true };
    } catch (err) {
      o.log('show in folder failed', String(err));
      return { ok: false, error: `Couldn't show the photo: ${failure(err)}` };
    }
  });

  ipcMain.handle('gallery:trash', async (e, raw: unknown): Promise<TrashResult> => {
    if (!allowed(e)) return { trashed: [], failed: [], cancelled: true };
    const result = await trashPhotos(raw, {
      check: inOpenFolder,
      confirm: async (paths) => {
        const w = o.window();
        if (!w || w.isDestroyed()) return false;
        return (await dialog.showMessageBox(w, trashConfirm(paths, process.platform))).response === 0;
      },
      trash: (path) => shell.trashItem(path),
      removed: async (paths) => {
        try {
          await tellRemoved(o.serverPort(), paths);
        } catch (err) {
          o.log('trash: could not tell the server', String(err));
          throw err;
        }
      },
    });
    o.log('trash', { trashed: result.trashed.length, failed: result.failed.length, cancelled: result.cancelled });
    return result;
  });
}

/**
 * The Map tab's answer to "Load maps from the internet?", kept in the gallery's settings file (see
 * mapTiles.ts). null until it was asked. Only for the gallery's own page in its own window.
 */
export function galleryMapConsent(o: { window: () => BrowserWindow | null; fromApp: (e: IpcMainInvokeEvent) => boolean; file: string; onChange: (on: boolean) => void; log: (...a: unknown[]) => void }) {
  const allowed = (e: IpcMainInvokeEvent) => {
    const w = o.window();
    return o.fromApp(e) && !!w && !w.isDestroyed() && e.sender === w.webContents;
  };
  let answer = readMapConsent(o.file);
  o.onChange(answer === true);
  ipcMain.handle('gallery:get-map-consent', (e): boolean | null => (allowed(e) ? answer : null));
  ipcMain.handle('gallery:set-map-consent', (e, on: unknown): void => {
    if (!allowed(e) || typeof on !== 'boolean') return;
    // The guard follows the answer at once, even when it cannot be remembered.
    answer = on;
    o.onChange(on);
    o.log('maps online', on);
    try {
      writeMapConsent(o.file, on);
    } catch (err) {
      o.log('could not save the map setting', String(err));
    }
  });
}

/**
 * Start the gallery program from the editor: this same executable with `--gallery`, on its own.
 * When the gallery is already running, that copy just brings its window forward and exits.
 */
export function launchGallery(log: (...a: unknown[]) => void) {
  const { command, args } = galleryLaunchCommand({ execPath: process.execPath, packaged: app.isPackaged, appPath: app.getAppPath(), env: process.env });
  const env = { ...process.env };
  // A development editor's Vite dev server and API port are its own: the gallery must not take them.
  delete env.PHOTOBOOK_DESKTOP_DEV_URL;
  delete env.PHOTOBOOK_PORT;
  delete env.PHOTOBOOK_WEB_PORT;
  delete env.ELECTRON_RUN_AS_NODE;
  log('starting the gallery', { command, args });
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
  child.once('error', (e) => log('could not start the gallery', String(e)));
  child.unref();
}
