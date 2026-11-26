// Saving a gallery photo's edit as a file, the part free of Electron (see gallery.ts for the rest).
// Save to file replaces the photo: the edited picture is made first, the original goes to the Recycle
// Bin (Trash), and only then does the edited picture take its path. Save as writes a copy and never
// touches the original. Only photos of the open folder; a failure is reported, never retried another way.
import { posix, win32 } from 'node:path';
import type { MessageBoxOptions } from 'electron';
import { formatById, formatOf } from '../../shared/core/mediaFormats';
import { editFormatFor, type EditFormat, type PhotoEdit } from '../../shared/core/photoEdit';

export interface EditSaveResult {
  ok: boolean;
  error?: string;
  /** True when the file was written even though `ok` is false (only the follow-up steps failed). */
  saved?: boolean;
  /** The server's refreshed GalleryItem. */
  item?: unknown;
}

export interface EditSaveAsResult extends EditSaveResult {
  cancelled?: boolean;
  savedPath?: string;
}

interface CommonDeps {
  /** Which of these paths are photos of the folder open now (and files), in order. */
  check(paths: string[]): Promise<string[]>;
  /** Write the photo with the edit applied into the gallery's data folder; says where. */
  render(path: string, edit: PhotoEdit): Promise<{ file: string; format?: string }>;
  /** Put `from` at `to`: a rename, else (another drive) a copy and then removing `from`. */
  move(from: string, to: string): Promise<void>;
  /** Wait this long before trying a busy move again (a test passes one that does not wait). */
  wait?(ms: number): Promise<void>;
  removeTemp(file: string): Promise<void>;
  /** Make the server read these photos again; the photos now in the open folder. */
  refresh(paths: string[]): Promise<unknown[]>;
}

export interface SaveToFileDeps extends CommonDeps {
  /** Move one file to the Recycle Bin (`shell.trashItem`). */
  trash(path: string): Promise<void>;
  /** Remove the photo's edit from photoinfo.json: it is in the file now. */
  clearEdit(path: string): Promise<void>;
}

export interface SaveAsDeps extends CommonDeps {
  platform: NodeJS.Platform;
  /** Is there a file (or folder) at this path? */
  exists(path: string): Promise<boolean>;
  /** The save dialog, starting at this path. The chosen path, or null when cancelled. */
  ask(defaultPath: string): Promise<string | null>;
  /** Give the new photo these fields of the original's info. */
  copyInfo(to: string, patch: Record<string, unknown>): Promise<void>;
}

const BAD_FORMAT = 'Photo Tool wrote the edited photo in an unexpected format, so nothing was changed.';
const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));
const NOT_A_PHOTO = 'That photo is not in the open folder any more.';
/** A format that can't be written (HEIC): an edit is saved only as a copy. Unknown formats are not refused here. */
const copyOnly = (path: string) => formatOf(path)?.capabilities.editInPlace === false;

/** Codes a move gets on Windows while another program (OneDrive, antivirus, a viewer) holds the file open. */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** A busy move is tried this many times in all, this far apart. */
export const MOVE_TRIES = 3;
export const MOVE_RETRY_MS = 200;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `deps.move`, tried again a few times while the file is busy; any other failure is thrown at once. */
async function moveRetrying(deps: CommonDeps, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.move(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt >= MOVE_TRIES || !code || !BUSY_CODES.has(code)) throw err;
      await (deps.wait ?? sleep)(MOVE_RETRY_MS);
    }
  }
}

/** Replace the photo's file with its edited picture. The original is trashed only after the picture is made. */
export async function saveToFile(path: string, edit: PhotoEdit, deps: SaveToFileDeps): Promise<EditSaveResult> {
  if (typeof path !== 'string' || !(await deps.check([path])).includes(path)) return { ok: false, error: NOT_A_PHOTO };
  if (copyOnly(path)) return { ok: false, error: `${formatOf(path)!.label} photos can only be saved as a copy.` };
  let temp: string;
  try {
    const made = await deps.render(path, edit);
    temp = made.file;
    if (made.format !== undefined && made.format !== editFormatFor(path)) {
      await deps.removeTemp(temp).catch(() => undefined);
      return { ok: false, error: BAD_FORMAT };
    }
  } catch (err) {
    return { ok: false, error: `Couldn't make the edited photo: ${failure(err)}` };
  }
  try {
    await deps.trash(path);
  } catch (err) {
    await deps.removeTemp(temp).catch(() => undefined);
    return { ok: false, error: `Couldn't move the original to the Recycle Bin, so nothing was changed: ${failure(err)}` };
  }
  try {
    await moveRetrying(deps, temp, path);
  } catch (err) {
    // The temp file is the only copy of the picture now: it stays where it is (the gallery sweeps its edits folder after an hour).
    // Save again cannot help: there is no photo at the path any more until the original is restored.
    return {
      ok: false,
      error: `The original is in the Recycle Bin, but the edited photo could not be put in its place: ${failure(err)}. Restore the original from the Recycle Bin to get the photo back. The edited photo is at ${temp} for about the next hour, if you want to copy it somewhere yourself.`,
    };
  }
  try {
    await deps.clearEdit(path);
  } catch (err) {
    return { ok: false, saved: true, error: `The photo was saved, but its old edit could not be cleared from the photo info: ${failure(err)}` };
  }
  try {
    return { ok: true, item: (await deps.refresh([path]))[0] };
  } catch (err) {
    return { ok: false, saved: true, error: `The photo was saved, but Photo Tool could not read it again: ${failure(err)}` };
  }
}

/** The extension new files of a written format get: .jpg, .png or .webp. */
const extensionFor = (format: EditFormat) => formatById(format)!.extensions[0];

/** `path` with its extension made to fit the written format: .jpg (or a chosen .jpeg), .png or .webp. */
function withFormatExtension(path: string, format: EditFormat, p: typeof win32): string {
  const { dir, name } = p.parse(path);
  return formatOf(path)?.id === format ? path : p.join(dir, `${name}${extensionFor(format)}`);
}

/** Write the edited photo as a new file the person names. The original stays as it is. */
export async function saveAs(path: string, edit: PhotoEdit, deps: SaveAsDeps, info?: Record<string, unknown>): Promise<EditSaveAsResult> {
  if (typeof path !== 'string' || !(await deps.check([path])).includes(path)) return { ok: false, error: NOT_A_PHOTO };
  const p = deps.platform === 'win32' ? win32 : posix;
  const format = editFormatFor(path);
  const { dir, name, ext } = p.parse(path);
  const chosen = await deps.ask(p.join(dir, `${name}-edited${copyOnly(path) ? extensionFor(format) : ext}`));
  if (!chosen) return { ok: false, cancelled: true };
  const target = withFormatExtension(chosen, format, p);
  const same = deps.platform === 'win32' ? target.toLowerCase() === path.toLowerCase() : target === path;
  if (same) return { ok: false, error: 'Choose a different name: Save as keeps the original.' };
  // The dialog confirmed the name as typed; a name changed to fit the format was not confirmed.
  if (target !== chosen && (await deps.exists(target))) return { ok: false, error: 'A file with that name already exists. Choose another name.' };
  let temp: string;
  try {
    const made = await deps.render(path, edit);
    temp = made.file;
    if (made.format !== undefined && made.format !== format) {
      await deps.removeTemp(temp).catch(() => undefined);
      return { ok: false, error: BAD_FORMAT };
    }
  } catch (err) {
    return { ok: false, error: `Couldn't make the edited photo: ${failure(err)}` };
  }
  try {
    await moveRetrying(deps, temp, target);
  } catch (err) {
    await deps.removeTemp(temp).catch(() => undefined);
    return { ok: false, error: `Couldn't save the copy: ${failure(err)}` };
  }
  // A copy outside the open folder is just a file: the server has nothing to say about it.
  let item: unknown;
  try {
    item = (await deps.refresh([target]))[0];
  } catch (err) {
    return { ok: false, saved: true, savedPath: target, error: `The copy was saved as ${target}, but Photo Tool could not read it: ${failure(err)}` };
  }
  if (item === undefined) return { ok: true, savedPath: target };
  try {
    await deps.copyInfo(target, copyablePatch(info));
  } catch (err) {
    return { ok: false, saved: true, savedPath: target, error: `The copy was saved as ${target}, but its star, people, date, location, description and notes could not be copied to it: ${failure(err)}` };
  }
  return { ok: true, savedPath: target, item };
}

/**
 * The fields of a photo's info a copy of it keeps: what the person said about the photo, not its edit.
 * The copy's own edit is removed: a file saved over one that had an entry (an older -edited copy) must
 * not show that file's edit on top of the new picture.
 */
export function copyablePatch(info: Record<string, unknown> | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = { edit: null };
  if (!info || typeof info !== 'object') return patch;
  for (const key of ['star', 'people', 'date', 'location', 'description', 'notes']) if (info[key] !== undefined) patch[key] = info[key];
  return patch;
}

/** The native question when the window is closed with edits not yet saved; Keep editing is the default. */
export function unsavedClosePrompt(count: number): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: ['Close without saving', 'Keep editing'],
    defaultId: 1,
    cancelId: 1,
    message: `${count} ${count === 1 ? 'photo has' : 'photos have'} edits that are not saved.`,
    detail: 'Closing now throws those edits away.',
  };
}

/**
 * Quitting (File > Exit) closes the window without the page's own question, so it is asked here:
 * with unsaved edits, quit only when `ask` (the unsavedClosePrompt dialog) says to close anyway.
 */
export function shouldQuit(count: number, ask: (count: number) => boolean): boolean {
  return count <= 0 || ask(count);
}

/**
 * The page's own question stopped a close (or reload): let it go? Without asking when the close was
 * already confirmed (Restart now asks shouldQuit first, then closes the window); otherwise as shouldQuit.
 */
export function letPageClose(o: { count: number; confirmed: boolean }, ask: (count: number) => boolean): boolean {
  return o.confirmed || shouldQuit(o.count, ask);
}
