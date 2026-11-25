import type { Dirent } from 'node:fs';
import { readdir as fsReaddir } from 'node:fs/promises';
import { join } from 'node:path';
import { isSupported } from '../../../shared/server/media';

// The gallery's own folder walk. Same rules as the editor's scanFolder (supported formats only,
// dotfiles skipped, numeric file-name order), but a subfolder that can't be read is reported and
// skipped instead of ending the walk: a drive or card root has folders like
// "System Volume Information" that nobody may open.

export class GalleryFolderError extends Error {}

export type ReadDir = (dir: string) => Promise<Dirent[]>;

const defaultReaddir: ReadDir = (dir) => fsReaddir(dir, { withFileTypes: true });

export interface PhotoListing {
  files: string[];
  /** Subfolders that could not be read. */
  errors: { path: string; message: string }[];
}

/** The photos in `root` (and its subfolders when `recursive`). Throws GalleryFolderError when `root` itself can't be read. */
export async function listPhotos(root: string, recursive: boolean, readdir: ReadDir = defaultReaddir): Promise<PhotoListing> {
  const files: string[] = [];
  const errors: PhotoListing['errors'] = [];
  const walk = async (dir: string, entries: Dirent[]) => {
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory() && recursive) {
        let inner: Dirent[];
        try {
          inner = await readdir(p);
        } catch (err) {
          errors.push({ path: p, message: err instanceof Error ? err.message : String(err) });
          continue;
        }
        await walk(p, inner);
      } else if (e.isFile() && isSupported(p)) files.push(p);
    }
  };
  let top: Dirent[];
  try {
    top = await readdir(root);
  } catch (err) {
    throw new GalleryFolderError(`Can't read the folder ${root}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await walk(root, top);
  return { files: files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), errors };
}
