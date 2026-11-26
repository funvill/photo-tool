// Deleting photos from the gallery window, the part free of Electron (see gallery.ts for the rest).
// A photo goes to the Recycle Bin (Trash) only: never erased. Only paths the gallery's server has
// catalogued, only after the person said yes, and a failure is reported, never retried another way.
import { pathToFileURL } from 'node:url';
import { MAX_DRAG_FILES } from './drag';

export interface TrashResult {
  /** Moved to the Recycle Bin, in the order asked. */
  trashed: string[];
  /** Could not be moved (some network drives have no bin): left where they are. */
  failed: { path: string; message: string }[];
  /** The person said no: nothing was moved. */
  cancelled: boolean;
}

export interface TrashDeps {
  /** Which of these paths are photos of a folder the gallery has open (and are still files), in order. */
  check(paths: string[]): Promise<string[]>;
  /** Ask the person; true to go ahead. */
  confirm(paths: string[]): Promise<boolean>;
  /** Move one file to the Recycle Bin (`shell.trashItem`). */
  trash(path: string): Promise<void>;
  /** Tell the gallery's server these are gone. */
  removed(paths: string[]): Promise<void>;
}

/** The most photos one Delete takes (Ctrl+A in a big folder). More is refused before anything is asked or moved. */
export const MAX_TRASH_FILES = 10_000;

/** In groups of `size`, in order. */
const batches = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * What the page asked to delete: only catalogued files, after the confirm, each to the Recycle Bin.
 * Every photo the confirm counted is moved (the server checks and is told about 500 at a time, as a
 * drag); over MAX_TRASH_FILES nothing is asked or moved.
 */
export async function trashPhotos(requested: unknown, deps: TrashDeps): Promise<TrashResult> {
  if (!Array.isArray(requested)) return { trashed: [], failed: [], cancelled: false };
  const asked = [...new Set(requested.filter((p): p is string => typeof p === 'string' && p !== ''))];
  if (asked.length > MAX_TRASH_FILES) return { trashed: [], failed: [], cancelled: true };
  const paths: string[] = [];
  for (const batch of batches(asked, MAX_DRAG_FILES)) paths.push(...(await deps.check(batch)));
  if (!paths.length) return { trashed: [], failed: [], cancelled: false };
  if (!(await deps.confirm(paths))) return { trashed: [], failed: [], cancelled: true };
  const trashed: string[] = [];
  const failed: TrashResult['failed'] = [];
  for (const path of paths) {
    try {
      await deps.trash(path);
      trashed.push(path);
    } catch (e) {
      failed.push({ path, message: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const batch of batches(trashed, MAX_DRAG_FILES)) {
    try {
      await deps.removed(batch);
    } catch {
      // The files are in the bin already. The server leaves missing files out of GET items anyway.
    }
  }
  return { trashed, failed, cancelled: false };
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The confirm before a delete: names the file (or the count); Cancel is the default. */
export function trashConfirm(paths: string[], platform: NodeJS.Platform) {
  const bin = platform === 'win32' ? 'Recycle Bin' : 'Trash';
  return {
    type: 'warning' as const,
    buttons: [`Move to ${bin}`, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: paths.length === 1 ? `Move "${fileName(paths[0])}" to the ${bin}?` : `Move ${paths.length} photos to the ${bin}?`,
    detail: `You can restore them from the ${bin}.`,
  };
}

/** The longest text Copy path puts on the clipboard: 500 paths of 4096 characters, one per line. */
export const MAX_COPY_TEXT = MAX_DRAG_FILES * 4097;

/** The text the page asked to copy, when it is a non-empty string no longer than MAX_COPY_TEXT; else null. */
export function copyTextRequest(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' && raw.length <= MAX_COPY_TEXT ? raw : null;
}

/**
 * Ctrl+C with several photos: what the page asked to copy, as far as it is taken on trust. Only paths
 * `allowed` passes (photos of the open folder that are files), each once, at most MAX_DRAG_FILES (as a
 * drag); `dropped` says how many allowed ones were left over. Null when there is nothing to copy.
 */
export function copyFilesRequest(raw: unknown, allowed: (p: string) => boolean): { paths: string[]; dropped: number } | null {
  if (!Array.isArray(raw)) return null;
  const ok = [...new Set(raw.filter((p): p is string => typeof p === 'string' && p !== ''))].filter(allowed);
  if (!ok.length) return null;
  return { paths: ok.slice(0, MAX_DRAG_FILES), dropped: Math.max(0, ok.length - MAX_DRAG_FILES) };
}

/**
 * The files as a text/uri-list (file URLs, CRLF between them). Written to the clipboard under that type,
 * Electron puts it on the Windows clipboard as a file drop list (CF_HDROP), which Explorer and chat apps
 * paste as files. (Found by trying it, issue #9: Electron 45 has no raw clipboard formats any more.)
 */
export function fileUrlList(paths: string[]): string {
  return paths.map((p) => pathToFileURL(p).href).join('\r\n');
}

/**
 * What Ctrl+C with several photos puts on the clipboard. The files only on Windows, the one place it was
 * tried (issue #9); elsewhere their paths as text, one per line, and the reply says so, so the page's
 * message never claims files that may not paste (Linux file managers want their own formats).
 */
export function copyFilesClipboard(paths: string[], platform: NodeJS.Platform): { as: 'files'; type: 'text/uri-list'; data: string } | { as: 'paths'; text: string } {
  return platform === 'win32' ? { as: 'files', type: 'text/uri-list', data: fileUrlList(paths) } : { as: 'paths', text: paths.join('\n') };
}
