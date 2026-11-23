// The on-disk format of a folder's photoinfo.json, shared by the editor and the gallery program.
// Node-only and dependency-free: nothing here imports from the rest of the repo.

export const PHOTOINFO_NAME = 'photoinfo.json';
export const PHOTOINFO_FORMAT = 'photoinfo/1';

export interface PhotoInfo {
  star?: boolean;
  people?: string[];
  /** ISO local date-time string. */
  date?: string;
  location?: { lat: number; lon: number; name?: string };
  description?: string;
  notes?: string;
  /** Unknown fields are kept untouched on every write. */
  [extra: string]: unknown;
}

export interface PhotoInfoFile {
  format: string;
  /** Keyed by file name only (no path). */
  photos: Record<string, PhotoInfo>;
  [extra: string]: unknown;
}

export class PhotoInfoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoInfoParseError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses the text of a photoinfo.json. Throws PhotoInfoParseError on invalid JSON or the wrong shape. */
export function parsePhotoInfo(text: string): PhotoInfoFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new PhotoInfoParseError(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new PhotoInfoParseError('Expected a JSON object at the top level');
  const photos = raw.photos === undefined ? {} : raw.photos;
  if (!isPlainObject(photos)) throw new PhotoInfoParseError('"photos" must be an object keyed by file name');
  for (const [name, entry] of Object.entries(photos)) {
    if (!isPlainObject(entry)) throw new PhotoInfoParseError(`The entry for "${name}" must be an object`);
  }
  const format = typeof raw.format === 'string' ? raw.format : PHOTOINFO_FORMAT;
  return { ...raw, format, photos: photos as Record<string, PhotoInfo> };
}

/** Pretty-printed so the file diffs and hand-edits well. */
export function serialisePhotoInfo(file: PhotoInfoFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}
