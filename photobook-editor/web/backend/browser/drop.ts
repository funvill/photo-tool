import type { ImportJob } from '../types';
import { isSupported } from './folders';

// Files dropped onto the web editor are imported like a picked folder (only the photos among them),
// but the caller wants one answer per dropped file, in drop order. These two pure helpers keep that
// bookkeeping out of the backend.

export const notAPhoto = (name: string) => `${name}: not a photo this app can read`;

/** The photos among the dropped files (drop order kept) and an error for each file that is not one. */
export function splitDropped(files: File[]): { photos: File[]; rejected: { file: string; error: string }[] } {
  const photos = files.filter((f) => isSupported(f.name));
  const rejected = files.filter((f) => !isSupported(f.name)).map((f) => ({ file: f.name, error: notAPhoto(f.name) }));
  return { photos, rejected };
}

/**
 * The job as the caller of `importDropped` sees it: `assetIds[i]` belongs to `files[i]` ('' for a
 * file that is not a photo or failed), and the rejected files are in `errors`. `job.assetIds` holds
 * one id per photo, in the order the photos were registered.
 */
export function alignDropped(files: File[], job: ImportJob): ImportJob {
  const { rejected } = splitDropped(files);
  let next = 0;
  const assetIds = files.map((f) => (isSupported(f.name) ? job.assetIds[next++] ?? '' : ''));
  return { ...job, assetIds, errors: [...rejected, ...job.errors] };
}
