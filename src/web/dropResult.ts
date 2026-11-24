import type { ImportJob } from './backend/types';

/** A dropped folder's share of a drop: its photos go to the library only. */
export interface DroppedFolder {
  folder: string;
  /** The folder's own name, for messages. */
  name: string;
  count: number;
}

const folderName = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;

/**
 * Splits a finished drop: `placed` lists the photos from dropped files (drop order), which may go onto
 * the page; `folders` sums up the photos found in each dropped folder (drop order), which are only imported.
 */
export function splitDropResult(job: ImportJob): { placed: string[]; folders: DroppedFolder[] } {
  const placed: string[] = [];
  const folders = new Map<string, DroppedFolder>();
  job.assetIds.forEach((id, i) => {
    if (!id) return;
    const folder = job.assetFolders?.[i] ?? '';
    if (!folder) return void placed.push(id);
    const entry = folders.get(folder) ?? { folder, name: folderName(folder), count: 0 };
    entry.count++;
    folders.set(folder, entry);
  });
  return { placed, folders: [...folders.values()] };
}
