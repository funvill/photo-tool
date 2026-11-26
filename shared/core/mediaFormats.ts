// The media formats both programs read: one table, so a new format is one entry here plus its
// handler (shared/server/mediaHandlers/), never a hunt for extension lists. Pure and browser-safe:
// the pages may use it too. A guard test (shared/tests/media-formats-guard.test.ts) fails on an
// image-extension list or regex anywhere else.

export type MediaKind = 'image' | 'raw' | 'video';

/** The formats an edited photo can be written in (see photoEdit.ts's `editFormatFor`). */
export type SaveFormat = 'jpeg' | 'png' | 'webp';

export interface MediaCapabilities {
  /** An edit can be written back into the file itself; otherwise only as a copy (in `saveAs`). */
  editInPlace: boolean;
  /** The format can carry see-through pixels (a cutout), so thumbnails may need to keep them. */
  alpha: boolean;
  /** What an edited copy (or an edit saved into the file) is written as. */
  saveAs: SaveFormat;
  /** A moving image (only its first frame is shown as a photo). */
  animated: boolean;
}

export interface MediaFormat {
  /** Equal to sharp's `metadata().format` name for the format, which the catalogues store. */
  id: string;
  /** Lower case, with the dot; the first is the one new files get. */
  extensions: readonly string[];
  mime: string;
  kind: MediaKind;
  /** The format's name in messages ("HEIC photos can only be saved as a copy"). */
  label: string;
  capabilities: MediaCapabilities;
}

export const MEDIA_FORMATS: readonly MediaFormat[] = [
  {
    id: 'jpeg', extensions: ['.jpg', '.jpeg'], mime: 'image/jpeg', kind: 'image', label: 'JPEG',
    capabilities: { editInPlace: true, alpha: false, saveAs: 'jpeg', animated: false },
  },
  {
    id: 'png', extensions: ['.png'], mime: 'image/png', kind: 'image', label: 'PNG',
    capabilities: { editInPlace: true, alpha: true, saveAs: 'png', animated: false },
  },
  {
    id: 'webp', extensions: ['.webp'], mime: 'image/webp', kind: 'image', label: 'WEBP',
    capabilities: { editInPlace: true, alpha: true, saveAs: 'webp', animated: false },
  },
  {
    // sharp's bundled libvips reads the HEIF container but can't decode HEVC: its handler decodes it.
    id: 'heif', extensions: ['.heic', '.heif'], mime: 'image/heic', kind: 'image', label: 'HEIC',
    capabilities: { editInPlace: false, alpha: false, saveAs: 'jpeg', animated: false },
  },
];

const BY_EXTENSION = new Map<string, MediaFormat>(MEDIA_FORMATS.flatMap((f) => f.extensions.map((e) => [e, f] as const)));
const BY_ID = new Map<string, MediaFormat>(MEDIA_FORMATS.map((f) => [f.id, f]));

/** Every extension the programs read, lower case with the dot. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(BY_EXTENSION.keys());

/** The last path part (either slash), as Node's `basename` gives it. */
const baseOf = (name: string) => name.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/**
 * A name's extension, lower case with the dot, as Node's `extname` gives it: '' when there is none,
 * and none for a dot file such as `.jpg` (that whole name is the base, not an extension).
 */
export function extensionOf(name: string): string {
  const base = baseOf(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** The format of a file by its extension (any case), or null when no program reads it. */
export function formatOf(name: string): MediaFormat | null {
  return BY_EXTENSION.get(extensionOf(name)) ?? null;
}

/** A format by its id (sharp's format name, as the catalogues store it), or null. */
export function formatById(id: string): MediaFormat | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Whether the programs read this file: a known extension, and not one of the `._name` files macOS
 * leaves beside photos on other disks (AppleDouble metadata, not pictures).
 */
export function isSupported(name: string): boolean {
  return formatOf(name) !== null && !baseOf(name).startsWith('._');
}

/** The `accept` attribute for a file input that takes every supported format: MIME types and extensions. */
export function acceptAttribute(): string {
  return [...new Set(MEDIA_FORMATS.flatMap((f) => [f.mime, ...f.extensions]))].join(',');
}
