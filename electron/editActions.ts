// Saving a gallery photo's edit as a file, the part free of Electron (see gallery.ts for the rest).
// Save to file replaces the photo: the edited picture is made first, the original goes to the Recycle
// Bin (Trash), and only then does the edited picture take its path. Save as writes a copy and never
// touches the original. Only photos of the open folder; a failure is reported, never retried another way.
import { posix, win32 } from 'node:path';
import type { MessageBoxOptions } from 'electron';
import type { PhotoEdit } from '../src/core/photoEdit';

export interface EditSaveResult {
  ok: boolean;
  error?: string;
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
  render(path: string, edit: PhotoEdit): Promise<{ file: string }>;
  /** Put `from` at `to`: a rename, else (another drive) a copy and then removing `from`. */
  move(from: string, to: string): Promise<void>;
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
  /** The save dialog, starting at this path. The chosen path, or null when cancelled. */
  ask(defaultPath: string): Promise<string | null>;
  /** Give the new photo these fields of the original's info. */
  copyInfo(to: string, patch: Record<string, unknown>): Promise<void>;
}

type EditFormat = 'jpeg' | 'png' | 'webp';

/**
 * The format the server writes an edited photo in (editFormatFor in src/server/photoEditRender.ts, which
 * cannot be imported here: it loads sharp, and the main process bundle does not carry it).
 */
function editFormatFor(path: string): EditFormat {
  const ext = win32.extname(path).toLowerCase();
  return ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpeg';
}

const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));
const NOT_A_PHOTO = 'That photo is not in the open folder any more.';
const isHeic = (path: string) => /\.(heic|heif)$/i.test(path);

/** Replace the photo's file with its edited picture. The original is trashed only after the picture is made. */
export async function saveToFile(path: string, edit: PhotoEdit, deps: SaveToFileDeps): Promise<EditSaveResult> {
  if (typeof path !== 'string' || !(await deps.check([path])).includes(path)) return { ok: false, error: NOT_A_PHOTO };
  if (isHeic(path)) return { ok: false, error: 'HEIC photos can only be saved as a copy.' };
  let temp: string;
  try {
    temp = (await deps.render(path, edit)).file;
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
    await deps.move(temp, path);
  } catch (err) {
    // The temp file is the only copy of the edit now: it stays where it is.
    return { ok: false, error: `The original is in the Recycle Bin, but the edited photo could not be put in its place: ${failure(err)}. The edited photo is at ${temp}.` };
  }
  try {
    await deps.clearEdit(path);
  } catch (err) {
    return { ok: false, error: `The photo was saved, but its old edit could not be cleared from the photo info: ${failure(err)}` };
  }
  try {
    return { ok: true, item: (await deps.refresh([path]))[0] };
  } catch (err) {
    return { ok: false, error: `The photo was saved, but the gallery could not read it again: ${failure(err)}` };
  }
}

/** `path` with its extension made to fit the written format: .jpg (or a chosen .jpeg), .png or .webp. */
function withFormatExtension(path: string, format: EditFormat, p: typeof win32): string {
  const { dir, name, ext } = p.parse(path);
  const keep = format === 'jpeg' ? ext.toLowerCase() === '.jpg' || ext.toLowerCase() === '.jpeg' : ext.toLowerCase() === `.${format}`;
  return keep ? path : p.join(dir, `${name}${format === 'jpeg' ? '.jpg' : `.${format}`}`);
}

/** Write the edited photo as a new file the person names. The original stays as it is. */
export async function saveAs(path: string, edit: PhotoEdit, deps: SaveAsDeps, info?: Record<string, unknown>): Promise<EditSaveAsResult> {
  if (typeof path !== 'string' || !(await deps.check([path])).includes(path)) return { ok: false, error: NOT_A_PHOTO };
  const p = deps.platform === 'win32' ? win32 : posix;
  const format = editFormatFor(path);
  const { dir, name, ext } = p.parse(path);
  const chosen = await deps.ask(p.join(dir, `${name}-edited${format === 'jpeg' && isHeic(path) ? '.jpg' : ext}`));
  if (!chosen) return { ok: false, cancelled: true };
  const target = withFormatExtension(chosen, format, p);
  const same = deps.platform === 'win32' ? target.toLowerCase() === path.toLowerCase() : target === path;
  if (same) return { ok: false, error: 'Choose a different name: Save as keeps the original.' };
  let temp: string;
  try {
    temp = (await deps.render(path, edit)).file;
  } catch (err) {
    return { ok: false, error: `Couldn't make the edited photo: ${failure(err)}` };
  }
  try {
    await deps.move(temp, target);
  } catch (err) {
    await deps.removeTemp(temp).catch(() => undefined);
    return { ok: false, error: `Couldn't save the copy: ${failure(err)}` };
  }
  // A copy outside the open folder is just a file: the server has nothing to say about it.
  try {
    const item = (await deps.refresh([target]))[0];
    if (item === undefined) return { ok: true, savedPath: target };
    await deps.copyInfo(target, copyablePatch(info));
    return { ok: true, savedPath: target, item };
  } catch (err) {
    return { ok: false, savedPath: target, error: `The copy was saved as ${target}, but the gallery could not read it: ${failure(err)}` };
  }
}

/** The fields of a photo's info a copy of it keeps: what the person said about the photo, not its edit. */
export function copyablePatch(info: Record<string, unknown> | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
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
