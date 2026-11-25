// Photo Tool's part of the main process: its File menu, handing its page folders to open, dragging
// photos out, the right-click file actions, saving edits and the map setting. main.ts wires them into
// the shared desktop shell (shared/electron/runDesktopApp.ts), which runs the server, the hardening
// and the window.
import { clipboard, ClipboardItem, dialog, ipcMain, nativeImage, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type NativeImage, type WebContents } from 'electron';
import { statSync } from 'node:fs';
import { copyFile, rename, rm, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { editFormatFor, type PhotoEdit } from '../../shared/core/photoEdit';
import { launchFolder } from '../../shared/electron/config';
import { dragFiles, dragRequest, preparedDragFor, sameDragList, type DragCheck, type PreparedDrag } from './drag';
import { copyTextRequest, trashConfirm, trashPhotos, type TrashResult } from './fileActions';
import { saveAs, saveToFile, shouldQuit, unsavedClosePrompt, type EditSaveAsResult, type EditSaveResult } from './editActions';
import { readEditTarget, readMapConsent, writeEditTarget, writeMapConsent, type EditTarget } from './mapTiles';

/** What a second launch hands over (see requestSingleInstanceLock): Chromium may reorder the argv it passes itself. */
export interface LaunchData {
  argv: string[];
  cwd: string;
  /** Run as `electron <app folder>`: the app folder is the first argument, not a folder to open. */
  defaultApp?: boolean;
}

/**
 * Folders for the page to open: one given at start (`Photo Tool <folder>`), from a second launch,
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
    /** A second `Photo Tool <folder>` launch (the shell brings the window forward after this). */
    secondInstance(data: unknown) {
      const d = data as Partial<LaunchData> | null;
      if (!d || !Array.isArray(d.argv)) return;
      const folder = launchFolder(d.argv.map(String), d.defaultApp === true);
      if (folder) open(resolve(typeof d.cwd === 'string' ? d.cwd : process.cwd(), folder));
    },
    /** Photo Tool's own File menu items (the shell adds the data folder and Quit). */
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

const DRAG_FAILED = "Couldn't drag the photos: Photo Tool did not answer in time. Try again.";

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

const EDIT_TIMEOUT_MS = 120_000;
const REFRESH_TIMEOUT_MS = 60_000;

/** POST (or PATCH) a JSON body to the gallery's own server and read the JSON reply. */
async function galleryJson(port: number, method: 'POST' | 'PATCH', path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let message = `${path} answered ${res.status}`;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === 'string') message = b.error;
    } catch {
      // keep the status line
    }
    throw new Error(message);
  }
  return res.json();
}

/** Rename; across drives (the data folder may be on another one than the photo) copy beside the target, rename into place, remove the source. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
    // A copy that fails half way must not leave a partial file under the real name.
    const part = `${to}.${process.pid}-${Date.now()}.part`;
    try {
      await copyFile(from, part);
      await rename(part, to);
    } catch (copyErr) {
      await rm(part, { force: true }).catch(() => undefined);
      throw copyErr;
    }
    // The photo is in place: a source that can't be removed is only a stray temp file (the edits folder is swept).
    await unlink(from).catch(() => undefined);
  }
}

/**
 * Saving a photo's edit: the "edit target" setting ('info' or 'file', kept in the gallery's settings
 * file), Save to file and Save as (see editActions.ts for the steps), and how many photos have edits
 * the page has not saved, which decides whether closing the window asks first. Only for the gallery's
 * own page in its own window; the files touched are only photos the server's file-check names.
 */
export function galleryEditActions(o: { window: () => BrowserWindow | null; fromApp: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean; serverPort: () => number; file: string; log: (...a: unknown[]) => void }) {
  const allowed = (e: IpcMainInvokeEvent | IpcMainEvent) => {
    const w = o.window();
    return o.fromApp(e) && !!w && !w.isDestroyed() && e.sender === w.webContents;
  };
  const port = () => o.serverPort();
  const common = {
    check: async (paths: string[]) => (await fileCheck(port(), paths)).filter(isFile),
    render: async (path: string, edit: PhotoEdit) => (await galleryJson(port(), 'POST', '/api/gallery/edit/render', { path, edit }, EDIT_TIMEOUT_MS)) as { file: string; format?: string },
    move: moveFile,
    removeTemp: (file: string) => rm(file, { force: true }),
    refresh: async (paths: string[]) => {
      const items = await galleryJson(port(), 'POST', '/api/gallery/refresh', { paths }, REFRESH_TIMEOUT_MS);
      return Array.isArray(items) ? items : [];
    },
  };
  const pathOf = (raw: unknown) => (typeof raw === 'string' ? raw : '');
  // Photos being saved now: a second save of the same photo would race the first.
  const saving = new Set<string>();
  const once = async <T extends { ok: boolean; error?: string }>(path: string, run: () => Promise<T>): Promise<T | { ok: false; error: string }> => {
    if (saving.has(path)) return { ok: false, error: 'That photo is already being saved.' };
    saving.add(path);
    try {
      return await run();
    } finally {
      saving.delete(path);
    }
  };

  let target = readEditTarget(o.file);
  ipcMain.handle('gallery:get-edit-target', (e): EditTarget => (allowed(e) ? target : 'info'));
  ipcMain.handle('gallery:set-edit-target', (e, raw: unknown): void => {
    if (!allowed(e) || (raw !== 'info' && raw !== 'file')) return;
    target = raw;
    o.log('edit target', raw);
    try {
      writeEditTarget(o.file, raw);
    } catch (err) {
      o.log('could not save the edit setting', String(err));
    }
  });

  // The server checks the edit itself (400 for one that is not valid), so it is passed on as it came.
  ipcMain.handle('gallery:save-edit-file', async (e, rawPath: unknown, rawEdit: unknown): Promise<EditSaveResult> => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed' };
    try {
      const r = await once(pathOf(rawPath), () =>
        saveToFile(pathOf(rawPath), rawEdit as PhotoEdit, {
          ...common,
          trash: (path) => shell.trashItem(path),
          clearEdit: async (path) => void (await galleryJson(port(), 'PATCH', '/api/gallery/info', { path, patch: { edit: null } }, EDIT_TIMEOUT_MS)),
        }),
      );
      o.log('save edit to file', { ok: r.ok });
      return r;
    } catch (err) {
      o.log('save edit to file failed', String(err));
      return { ok: false, error: `Couldn't save the photo: ${failure(err)}` };
    }
  });

  ipcMain.handle('gallery:save-edit-as', async (e, rawPath: unknown, rawEdit: unknown, rawInfo: unknown): Promise<EditSaveAsResult> => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed' };
    const info = rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo) ? (rawInfo as Record<string, unknown>) : undefined;
    try {
      const r = await once(pathOf(rawPath), () =>
        saveAs(
          pathOf(rawPath),
          rawEdit as PhotoEdit,
          {
            ...common,
            platform: process.platform,
            exists: async (p) => {
              try {
                statSync(p);
                return true;
              } catch {
                return false;
              }
            },
            ask: async (defaultPath) => {
              const w = o.window();
              // The filter makes the dialog itself give the name the right extension and ask before replacing a file.
              const format = editFormatFor(defaultPath);
              const filters = [format === 'jpeg' ? { name: 'JPEG photo', extensions: ['jpg', 'jpeg'] } : { name: `${format.toUpperCase()} photo`, extensions: [format] }];
              const options = { title: 'Save the edited photo as', defaultPath, filters };
              const chosen = w && !w.isDestroyed() ? await dialog.showSaveDialog(w, options) : await dialog.showSaveDialog(options);
              return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
            },
            copyInfo: async (to, patch) => void (await galleryJson(port(), 'PATCH', '/api/gallery/info', { path: to, patch }, EDIT_TIMEOUT_MS)),
          },
          info,
        ),
      );
      o.log('save edit as', { ok: r.ok });
      return r;
    } catch (err) {
      o.log('save edit as failed', String(err));
      return { ok: false, error: `Couldn't save the copy: ${failure(err)}` };
    }
  });

  // How many photos have edits not saved yet, per gallery page (set by the page).
  const unsaved = new Map<number, number>();
  ipcMain.on('gallery:unsaved-edits', (e, raw: unknown) => {
    if (!allowed(e)) return;
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    if (n) unsaved.set(e.sender.id, n);
    else unsaved.delete(e.sender.id);
  });

  return {
    /** Call for the gallery's window: closing (or reloading) a page that says it has unsaved edits asks first. */
    watch(w: BrowserWindow) {
      const id = w.webContents.id;
      w.webContents.on('will-prevent-unload', (event) => {
        const n = unsaved.get(id) ?? 0;
        // preventDefault here lets the page go: the page's own beforeunload is what stopped it.
        if (!n || dialog.showMessageBoxSync(w, unsavedClosePrompt(n)) === 0) event.preventDefault();
      });
      // A new page starts with nothing unsaved; a closed window has nothing left to save.
      w.webContents.on('did-start-navigation', (e) => {
        if (e.isMainFrame && !e.isSameDocument) unsaved.delete(id);
      });
      w.webContents.once('destroyed', () => unsaved.delete(id));
    },
    /**
     * Before quitting (File > Exit, which skips the page's own question): with unsaved edits in the
     * gallery's window, ask as closing it would. True to go on quitting.
     */
    confirmQuit(): boolean {
      const w = o.window();
      if (!w || w.isDestroyed()) return true;
      return shouldQuit(unsaved.get(w.webContents.id) ?? 0, (n) => dialog.showMessageBoxSync(w, unsavedClosePrompt(n)) === 0);
    },
  };
}
