// Deleting photos from the gallery window, the part free of Electron (see gallery.ts for the rest).
// A photo goes to the Recycle Bin (Trash) only: never erased. Only paths the gallery's server has
// catalogued, only after the person said yes, and a failure is reported, never retried another way.
import { dragRequest } from './drag';

export interface TrashResult {
  /** Moved to the Recycle Bin, in the order asked. */
  trashed: string[];
  /** Could not be moved (some network drives have no bin): left where they are. */
  failed: { path: string; message: string }[];
  /** The person said no: nothing was moved. */
  cancelled: boolean;
}

export interface TrashDeps {
  /** Which of these paths the gallery's server has catalogued (and are still files), in order. */
  check(paths: string[]): Promise<string[]>;
  /** Ask the person; true to go ahead. */
  confirm(paths: string[]): Promise<boolean>;
  /** Move one file to the Recycle Bin (`shell.trashItem`). */
  trash(path: string): Promise<void>;
  /** Tell the gallery's server these are gone. */
  removed(paths: string[]): Promise<void>;
}

/** What the page asked to delete: only catalogued files, after the confirm, each to the Recycle Bin. */
export async function trashPhotos(requested: unknown, deps: TrashDeps): Promise<TrashResult> {
  const asked = dragRequest(requested);
  const paths = asked.length ? await deps.check(asked) : [];
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
  if (trashed.length) {
    try {
      await deps.removed(trashed);
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
