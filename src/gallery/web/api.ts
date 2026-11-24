import type { GalleryInfoReply, GalleryItem } from '../server/app';

// Thin client for the gallery's local server (same origin, 127.0.0.1). Errors carry the server's message.

export type { GalleryInfoReply, GalleryItem };

export class GalleryApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RecentFolder {
  folder: string;
  recursive: boolean;
  openedAt: string;
  /** False when the folder is gone (or its drive is not connected). */
  exists: boolean;
}

/** Info entries of a folder whose photo is no longer there. */
export interface OrphanedFolder {
  folder: string;
  fileNames: string[];
}

export interface JobUpdate {
  total: number;
  processed: number;
  startedAt: number;
  done: boolean;
  /** Stopped before the end (the folder was closed, or another one opened). */
  cancelled: boolean;
  errors: { path: string; message: string }[];
  /** The photos finished after the first `since`. */
  items: GalleryItem[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GalleryApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

const qs = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export const galleryApi = {
  recent: () => call<RecentFolder[]>('GET', '/api/gallery/recent'),
  open: (folder: string, recursive: boolean) => call<{ jobId: string }>('POST', '/api/gallery/open', { folder, recursive }),
  job: (id: string, since: number) => call<JobUpdate>('GET', `/api/gallery/jobs/${encodeURIComponent(id)}?${qs({ since })}`),
  cancel: (job: string) => call<{ cancelled: boolean }>('POST', `/api/gallery/jobs/${encodeURIComponent(job)}/cancel`),
  items: (job: string) => call<GalleryItem[]>('GET', `/api/gallery/items?${qs({ job })}`),
  stamp: async (job: string) => (await call<{ stamp: string }>('GET', `/api/gallery/stamp?${qs({ job })}`)).stamp,
  people: (job: string) => call<string[]>('GET', `/api/gallery/people?${qs({ job })}`),
  places: () => call<{ id: string; name: string }[]>('GET', '/api/places'),
  suggestPlaces: (points: [number, number][]) => call<{ id: string; name: string; photos: number }[]>('POST', '/api/places/suggest', { points }),
  orphans: (job: string) => call<OrphanedFolder[]>('GET', `/api/gallery/orphans?${qs({ job })}`),
  forget: (folder: string, fileNames: string[]) => call<{ removed: number }>('POST', '/api/gallery/forget', { folder, fileNames }),
  /** With `job`, the reply carries that folder's stamp just before and after the write. */
  /** A null value deletes that field. */
  patchInfo: (path: string, patch: Record<string, unknown>, job?: string) => call<GalleryInfoReply>('PATCH', '/api/gallery/info', job ? { path, patch, job } : { path, patch }),
};

/** 's' is 400 px (the grid), 'm' is 1600 px (the hover preview). */
export function thumbUrl(key: string, size: 's' | 'm' = 's'): string {
  return `/api/gallery/thumb?${qs({ key, size })}`;
}

/** The photo at full size, upright (JPEG): what the zoomed preview swaps in. */
export function fullUrl(path: string): string {
  return `/api/gallery/full?${qs({ path })}`;
}
