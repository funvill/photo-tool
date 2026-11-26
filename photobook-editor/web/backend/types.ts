import type { BookDocument, PhotoAsset, PreflightIssue } from '../../core';

// What the editor needs from its backend: the local server, over HTTP (http.ts).

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ProjectSummary {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  createdAt: string;
  photoCount: number;
  pageCount: number;
  product: 'book' | 'poster';
  trimWidthMm: number;
  trimHeightMm: number;
}

export interface ImportJob {
  id: string;
  kind: 'import' | 'sync' | 'paths';
  status: 'scanning' | 'running' | 'done' | 'failed';
  folder: string;
  total: number;
  processed: number;
  imported: number;
  alreadyInLibrary: number;
  exactDuplicates: number;
  moved: number;
  removed: number;
  missingFolders: string[];
  failed: number;
  /** Photos from a drop: the asset for each input in order ('' for one that failed); a dropped folder gives one entry per photo in it. */
  assetIds: string[];
  /** Drops (desktop): for each `assetIds` entry, the dropped folder it came from ('' for a dropped file). Absent: all files. */
  assetFolders?: string[];
  errors: { file: string; error: string }[];
  /** ISO time the job began; the library uses it for the time left. */
  startedAt: string;
}

/** A folder this project keeps in sync with its library. */
export interface LinkedFolder {
  folder: string;
  name: string;
  exists: boolean;
  onShelf: boolean;
  syncedAt: string | null;
  assetIds: string[];
}

export interface ShelfFolder {
  name: string;
  path: string;
  photos: number;
  subfolders: number;
  previews: string[];
}

export interface ShelfListing {
  root: string;
  exists: boolean;
  path: string;
  parent: string | null;
  folders: ShelfFolder[];
  loosePhotos: number;
}

export interface FolderListing {
  path: string;
  /** Windows, at the list of drives: what the path box shows in place of `path`. */
  label?: string;
  /** Windows: this is the list of drives, not a folder, so it cannot be chosen. */
  drives?: boolean;
  parent: string | null;
  folders: string[];
  photos: number;
}

export interface FileVerification {
  ok: boolean;
  pageCount: number;
  expectedPageCount: number;
  pageSizeMm: { width: number; height: number };
  trimSizeMm: { width: number; height: number };
  problems: string[];
}

export interface ExportResponse {
  file: string;
  url: string;
  bleedMode: 'all' | 'outer';
  cover: null | { file: string; url: string; bytes: number; spineMm: number; verification: FileVerification; textOverflow: PreflightIssue[] };
  bytes: number;
  durationMs: number;
  issues: PreflightIssue[];
  textOverflow: PreflightIssue[];
  verification: {
    ok: boolean;
    pageCount: number;
    expectedPageCount: number;
    pageSizeMm: { width: number; height: number };
    trimSizeMm: { width: number; height: number };
    problems: string[];
  };
}

export interface ImageExportResponse {
  file: string;
  url: string;
  bytes: number;
  widthPx: number;
  heightPx: number;
  dpi: number;
  format: 'png' | 'jpeg';
}

export interface FlipbookResponse {
  file: string;
  url: string;
  bytes: number;
  pages: number;
  hasCover: boolean;
  widthPx: number;
  heightPx: number;
  durationMs: number;
}

export interface NewProject {
  title: string;
  sizeId: string;
  stylePresetId?: string;
  pages?: number;
  printerId?: import('../../core').PrinterId;
  bindingId?: import('../../core').BindingId;
  product?: 'book' | 'poster';
  landscape?: boolean;
}

export interface Backend {
  deletedProjects(): Promise<{ id: string; title: string; deletedAt: string; product: 'book' | 'poster' }[]>;
  trashProject(id: string): Promise<{ ok: true }>;
  restoreProject(id: string): Promise<{ ok: true }>;
  purgeProject(id: string): Promise<{ removedPhotos: number }>;
  places(): Promise<{ id: string; name: string }[]>;
  placeOutline(id: string): Promise<{ name: string; d: string; aspect: number }>;
  suggestPlaces(points: [number, number][]): Promise<{ id: string; name: string; photos: number }[]>;
  exportImage(projectId: string, doc: BookDocument, format: 'png' | 'jpeg', dpi: number): Promise<ImageExportResponse>;
  exportFlipbook(projectId: string, doc: BookDocument, size: 'standard' | 'sharp'): Promise<FlipbookResponse>;
  textOutline(body: { text: string; fontFamily: string; fontWeight: number; italic?: boolean; uppercase?: boolean; letterSpacingEm?: number }): Promise<{ d: string; aspect: number }>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(body: NewProject): Promise<{ doc: BookDocument; revision: number }>;
  getProject(id: string): Promise<{ doc: BookDocument; revision: number; updatedAt: string }>;
  saveProject(doc: BookDocument, baseRevision: number, keepalive?: boolean): Promise<{ revision: number }>;
  revisions(id: string): Promise<{ revision: number; savedAt: string; bytes: number }[]>;
  revision(id: string, rev: number): Promise<{ doc: BookDocument }>;
  assets(id: string): Promise<PhotoAsset[]>;
  patchAsset(projectId: string, assetId: string, patch: { rating?: number; favorite?: boolean; excluded?: boolean }): Promise<PhotoAsset>;
  /** Changes when a photoinfo.json beside the book's photos changes. */
  photoInfoStamp(projectId: string): Promise<string>;
  /** `folder` is a path on this computer. */
  startImport(projectId: string, folder: string): Promise<ImportJob>;
  /**
   * Photos dropped onto the editor, imported by `paths` (the desktop app says where each dropped file
   * lives). Resolves to a job whose `assetIds` lists each file's photo.
   */
  importDropped(projectId: string, files: File[], paths: string[] | null): Promise<ImportJob>;
  job(id: string): Promise<ImportJob>;
  listFolder(path?: string): Promise<FolderListing>;
  links(projectId: string): Promise<LinkedFolder[]>;
  linkFolder(projectId: string, folder: string): Promise<ImportJob>;
  unlinkFolder(projectId: string, folder: string): Promise<LinkedFolder[]>;
  syncLinks(projectId: string, inUse: string[]): Promise<{ job: ImportJob | null }>;
  shelf(path?: string): Promise<ShelfListing>;
  setShelfRoot(root: string): Promise<ShelfListing>;
  createShelf(): Promise<ShelfListing>;
  relink(projectId: string, folder: string): Promise<{ relinked: number; stillMissing: number }>;
  exportPdf(projectId: string, doc: BookDocument, bleedMode?: 'all' | 'outer'): Promise<ExportResponse>;
  /** Image URL of a photo's thumbnail ('s' ≈ 400 px, 'm' ≈ 1600 px). */
  thumbUrl(assetId: string, size?: 's' | 'm'): string;
  shelfPreviewUrl(path: string): string;
  /** Link that downloads an export (`url` from an export response). */
  downloadUrl(url: string): string;
}
