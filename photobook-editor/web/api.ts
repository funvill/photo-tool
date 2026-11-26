import { backend } from './backend';

// The editor's backend: the local server. Components import `api` and the URL helpers from here.

export * from './backend/types';

export const api = backend;

export const shelfPreviewUrl = (path: string) => backend.shelfPreviewUrl(path);

export const thumbUrl = (assetId: string, size: 's' | 'm' = 's') => backend.thumbUrl(assetId, size);

export const downloadUrl = (url: string) => backend.downloadUrl(url);
