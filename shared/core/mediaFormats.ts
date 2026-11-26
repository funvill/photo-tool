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
  /**
   * The name the catalogues store. Usually sharp's `metadata().format` name, but not always (sharp
   * calls AVIF 'heif'), so the catalogues take it from here, never from sharp.
   */
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
  // The formats below can't be edited in place: an edit is written as `saveAs`, and Save writes that
  // into the photo's own path, so a .tif would end up holding JPEG bytes. They are saved as a copy.
  {
    // sharp reads AVIF itself (its libheif has an AV1 decoder), though it calls the format 'heif'.
    id: 'avif', extensions: ['.avif'], mime: 'image/avif', kind: 'image', label: 'AVIF',
    capabilities: { editInPlace: false, alpha: true, saveAs: 'jpeg', animated: false },
  },
  {
    // A multi-page TIFF is shown as its first page.
    id: 'tiff', extensions: ['.tif', '.tiff'], mime: 'image/tiff', kind: 'image', label: 'TIFF',
    capabilities: { editInPlace: false, alpha: true, saveAs: 'jpeg', animated: false },
  },
  {
    // An animated GIF is shown, and edited, as its first frame; the file itself is never changed.
    id: 'gif', extensions: ['.gif'], mime: 'image/gif', kind: 'image', label: 'GIF',
    capabilities: { editInPlace: false, alpha: true, saveAs: 'png', animated: true },
  },
  {
    // Untrusted: rasterised from its bytes (never its path, so it can't load files beside it) into a
    // capped PNG; the page never gets the SVG itself.
    id: 'svg', extensions: ['.svg'], mime: 'image/svg+xml', kind: 'image', label: 'SVG',
    capabilities: { editInPlace: false, alpha: true, saveAs: 'png', animated: false },
  },
  {
    // sharp has no BMP or ICO loader: a small decoder of our own turns them into a PNG.
    id: 'bmp', extensions: ['.bmp'], mime: 'image/bmp', kind: 'image', label: 'BMP',
    capabilities: { editInPlace: false, alpha: true, saveAs: 'png', animated: false },
  },
  {
    id: 'ico', extensions: ['.ico'], mime: 'image/x-icon', kind: 'image', label: 'ICO',
    capabilities: { editInPlace: false, alpha: true, saveAs: 'png', animated: false },
  },
  // Camera RAW: shown through the biggest JPEG preview the camera stored in the file (the raw handler
  // in shared/server/mediaHandlers/raw.ts); the sensor data itself is not decoded yet. Never written:
  // an edit is saved as a JPEG copy.
  ...([
    ['dng', 'image/x-adobe-dng'], ['cr2', 'image/x-canon-cr2'], ['cr3', 'image/x-canon-cr3'], ['crw', 'image/x-canon-crw'],
    ['nef', 'image/x-nikon-nef'], ['nrw', 'image/x-nikon-nrw'], ['arw', 'image/x-sony-arw'], ['srf', 'image/x-sony-srf'],
    ['sr2', 'image/x-sony-sr2'], ['raf', 'image/x-fuji-raf'], ['orf', 'image/x-olympus-orf'], ['rw2', 'image/x-panasonic-rw2'],
    ['pef', 'image/x-pentax-pef'], ['srw', 'image/x-samsung-srw'], ['rwl', 'image/x-leica-rwl'], ['3fr', 'image/x-hasselblad-3fr'],
    ['iiq', 'image/x-phaseone-iiq'], ['erf', 'image/x-epson-erf'], ['mef', 'image/x-mamiya-mef'], ['mos', 'image/x-leaf-mos'],
    ['kdc', 'image/x-kodak-kdc'], ['dcr', 'image/x-kodak-dcr'], ['x3f', 'image/x-sigma-x3f'],
  ] as const).map(([id, mime]): MediaFormat => ({
    id, extensions: [`.${id}`], mime, kind: 'raw', label: id.toUpperCase(),
    capabilities: { editInPlace: false, alpha: false, saveAs: 'jpeg', animated: false },
  })),
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

/**
 * Sidecar files: notes a program keeps beside a photo (an XMP file holds a RAW's rating and edits).
 * Never photos, never shown, never reported as files that could not be read.
 */
const SIDECAR_EXTENSIONS: ReadonlySet<string> = new Set(['.xmp']);

/** Whether this file is a sidecar (`IMG_0001.xmp`, `IMG_0001.CR3.xmp`), not a photo. */
export function isSidecar(name: string): boolean {
  return SIDECAR_EXTENSIONS.has(extensionOf(name));
}

/** The formats a camera saves beside a RAW of the same name ("RAW + JPEG"): the picture shown for both. */
const TWIN_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'heif']);

/**
 * RAW + JPEG pairs: a RAW and a JPEG (or HEIC) with the same base name, in any case, in the same folder
 * are one photo. The JPEG is the one shown (`shown`), and `twinOf` gives its RAW; the RAW is not in
 * `shown`. Everything else is kept, in the order given. A picture takes at most one RAW and a RAW at
 * most one picture, the first of each in the order given.
 */
export function pairRawTwins(paths: readonly string[]): { shown: string[]; twinOf: Map<string, string> } {
  /** The folder and base name, lower case, without the extension: what a pair has in common. */
  const stem = (p: string) => {
    const ext = extensionOf(p);
    const cut = p.replace(/[\\/]+$/, '');
    return ext ? cut.slice(0, cut.length - ext.length).toLowerCase() : null;
  };
  const raws = new Map<string, string>();
  for (const p of paths) {
    const s = stem(p);
    if (s !== null && formatOf(p)?.kind === 'raw' && !raws.has(s)) raws.set(s, p);
  }
  const twinOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const p of paths) {
    const s = stem(p);
    const format = formatOf(p);
    if (s === null || !format || !TWIN_FORMATS.has(format.id) || baseOf(p).startsWith('.')) continue;
    const raw = raws.get(s);
    if (raw && !taken.has(raw)) {
      taken.add(raw);
      twinOf.set(p, raw);
    }
  }
  return { shown: paths.filter((p) => !taken.has(p)), twinOf };
}

/** The `accept` attribute for a file input that takes every supported format: MIME types and extensions. */
export function acceptAttribute(): string {
  return [...new Set(MEDIA_FORMATS.flatMap((f) => [f.mime, ...f.extensions]))].join(',');
}
