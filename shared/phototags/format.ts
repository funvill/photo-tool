// The on-disk format of an album folder's phototool-tags.json (what the tagging models said about each photo) and
// its companion phototool-tags.vectors.json (the keywords model's picture embeddings, for search by meaning).
// photoinfo.json stays for what people type; these two hold only generated data, so they can be deleted and made again.
// Node-only and dependency-free: nothing here imports from the rest of the repo.

export const PHOTOTAGS_NAME = 'phototool-tags.json';
export const PHOTOTAGS_FORMAT = 'phototool-tags/1';
export const PHOTOVECTORS_NAME = 'phototool-tags.vectors.json';
export const PHOTOVECTORS_FORMAT = 'phototool-vectors/1';

/**
 * One model's finished result for one photo. `contentKey` names the picture it was made from (a hash of its pixels):
 * a result whose key does not match the photo now in that file (replaced, or edited) is not used for it.
 */
export interface TagResult {
  contentKey: string;
  description?: string;
  objects?: { label: string; count: number }[];
  keywords?: { label: string; score: number }[];
  /** ISO time it was made. */
  madeAt?: string;
  /** Unknown fields are kept untouched on every write (while the result is for the same picture). */
  [extra: string]: unknown;
}

export interface PhotoTagsEntry {
  /** By model id. */
  models: Record<string, TagResult>;
  [extra: string]: unknown;
}

export interface PhotoTagsFile {
  format: string;
  /** Keyed by file name only (no path), as in photoinfo.json. Entries this version can't read are kept as they are. */
  photos: Record<string, PhotoTagsEntry | unknown>;
  [extra: string]: unknown;
}

export interface VectorEntry {
  contentKey: string;
  /** The embedding: base64 of its float32 values, little-endian. */
  data: string;
  [extra: string]: unknown;
}

export interface PhotoVectorsFile {
  format: string;
  photos: Record<string, { models: Record<string, VectorEntry>; [extra: string]: unknown } | unknown>;
  [extra: string]: unknown;
}

/** A result as read from the file, with where it was. */
export interface StoredResult extends TagResult {
  fileName: string;
  modelId: string;
}

export interface StoredVector {
  fileName: string;
  modelId: string;
  contentKey: string;
  embedding: Float32Array;
}

export class PhotoTagsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoTagsParseError';
  }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses either file's text: a JSON object with an object of photos and this format (or none). */
function parseFile(text: string, format: string, name: string): { format: string; photos: Record<string, unknown>; [extra: string]: unknown } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new PhotoTagsParseError(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new PhotoTagsParseError('Expected a JSON object at the top level');
  if (raw.format !== undefined && raw.format !== format) {
    // Another version's file is never rewritten in this version's shape.
    throw new PhotoTagsParseError(`${name} is "${String(raw.format)}", made by a newer Photo Tool; this one reads "${format}"`);
  }
  const photos = raw.photos === undefined ? {} : raw.photos;
  if (!isPlainObject(photos)) throw new PhotoTagsParseError('"photos" must be an object keyed by file name');
  return { ...raw, format, photos };
}

/** Parses the text of a phototool-tags.json. Throws PhotoTagsParseError on invalid JSON, the wrong shape or another format. */
export function parsePhotoTags(text: string): PhotoTagsFile {
  return parseFile(text, PHOTOTAGS_FORMAT, PHOTOTAGS_NAME);
}

/** Parses the text of a phototool-tags.vectors.json. */
export function parsePhotoVectors(text: string): PhotoVectorsFile {
  return parseFile(text, PHOTOVECTORS_FORMAT, PHOTOVECTORS_NAME);
}

/** Pretty-printed so the file diffs and reads well. */
export function serialisePhotoTags(file: PhotoTagsFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

/** One line: the vectors are not for reading. */
export function serialisePhotoVectors(file: PhotoVectorsFile): string {
  return JSON.stringify(file) + '\n';
}

/** The models of an entry, when it has the shape this version reads. */
export function modelsOf(entry: unknown): Record<string, unknown> | undefined {
  return isPlainObject(entry) && isPlainObject(entry.models) ? entry.models : undefined;
}

/** Every result this version can use (a string content key); others are skipped, though kept in the file. */
export function resultsOf(file: PhotoTagsFile): StoredResult[] {
  const out: StoredResult[] = [];
  for (const [fileName, entry] of Object.entries(file.photos)) {
    for (const [modelId, r] of Object.entries(modelsOf(entry) ?? {})) {
      if (!isPlainObject(r) || typeof r.contentKey !== 'string' || !r.contentKey) continue;
      // Known fields of the wrong shape (a hand edit gone wrong) are left out of what is read.
      const clean: StoredResult = { fileName, modelId, ...(r as TagResult) };
      if (clean.description !== undefined && typeof clean.description !== 'string') delete clean.description;
      if (clean.objects !== undefined) clean.objects = listOf(clean.objects, (o) => typeof o.label === 'string' && typeof o.count === 'number');
      if (clean.keywords !== undefined) clean.keywords = listOf(clean.keywords, (k) => typeof k.label === 'string' && typeof k.score === 'number');
      out.push(clean);
    }
  }
  return out;
}

const listOf = <T>(v: unknown, ok: (x: Record<string, unknown>) => boolean): T[] => (Array.isArray(v) ? v.filter((x) => isPlainObject(x) && ok(x)) : []) as T[];

export function encodeVector(v: Float32Array): string {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf.toString('base64');
}

/** Null when the text is not a whole number of float32 values. */
export function decodeVector(text: string): Float32Array | null {
  const buf = Buffer.from(text, 'base64');
  if (!buf.length || buf.length % 4) return null;
  const v = new Float32Array(buf.length / 4);
  for (let i = 0; i < v.length; i++) v[i] = buf.readFloatLE(i * 4);
  return v;
}

export function vectorsOf(file: PhotoVectorsFile): StoredVector[] {
  const out: StoredVector[] = [];
  for (const [fileName, entry] of Object.entries(file.photos)) {
    for (const [modelId, r] of Object.entries(modelsOf(entry) ?? {})) {
      if (!isPlainObject(r) || typeof r.contentKey !== 'string' || typeof r.data !== 'string') continue;
      const embedding = decodeVector(r.data);
      if (embedding) out.push({ fileName, modelId, contentKey: r.contentKey, embedding });
    }
  }
  return out;
}

/** Exact key first, then case-insensitive (as photoinfo.json). */
export function findName(photos: Record<string, unknown>, fileName: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(photos, fileName)) return fileName;
  const lower = fileName.toLowerCase();
  return Object.keys(photos).find((k) => k.toLowerCase() === lower);
}
