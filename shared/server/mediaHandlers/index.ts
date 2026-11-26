import type { Sharp } from 'sharp';
import { formatOf, MEDIA_FORMATS } from '../../core/mediaFormats';
import { heifHandler } from './heic';
import { sharpHandler } from './sharp';

// One handler per format in shared/core/mediaFormats.ts: how that format is decoded. Everything that
// reads a photo's pixels (the scanners, the importer, /full, /image, the shelf previews, the edit
// actions) asks `handlerFor(file)` instead of checking extensions. "Plug-in" means a module listed
// here, never code loaded from outside at run time.

export interface HandlerContext {
  /** Where decoded copies are cached: `<dataDir>/derived` (it exists already). */
  derivedDir: string;
  /** The original's SHA-256, worked out only when a handler asks (to name a decoded copy). */
  contentHash(): Promise<string>;
}

export interface MediaHandler {
  /** The format's id in mediaFormats.ts. */
  id: string;
  /** Fast: a picture good enough for thumbnails, as a file sharp reads (or its bytes). */
  preview(file: string, ctx: HandlerContext): Promise<string | Buffer>;
  /** Full quality, for zoom, export and edits: a file sharp reads. Defaults to `preview()`. */
  working?(file: string, ctx: HandlerContext): Promise<string>;
  /** The picture as an upright sharp image, decoded in memory without the cache (small previews). */
  image(file: string): Promise<Sharp>;
}

const HANDLERS: readonly MediaHandler[] = [sharpHandler('jpeg'), sharpHandler('png'), sharpHandler('webp'), heifHandler];

const BY_ID = new Map(HANDLERS.map((h) => [h.id, h]));

/** Every handler, for the registry tests. */
export const mediaHandlers = (): readonly MediaHandler[] => HANDLERS;

/** The handler for a file, by its extension, or null when no program reads the file. */
export function handlerFor(file: string): MediaHandler | null {
  const format = formatOf(file);
  return format ? BY_ID.get(format.id) ?? null : null;
}

/** The full-quality file sharp should read for `file`: `working()`, else `preview()`. */
export async function workingPath(handler: MediaHandler, file: string, ctx: HandlerContext): Promise<string> {
  if (handler.working) return handler.working(file, ctx);
  const preview = await handler.preview(file, ctx);
  if (typeof preview !== 'string') throw new Error(`The ${handler.id} handler gives preview bytes, so it needs working()`);
  return preview;
}

// A format without a handler (or a handler without a format) is a mistake made here: fail at load.
for (const f of MEDIA_FORMATS) if (!BY_ID.has(f.id)) throw new Error(`No media handler for the ${f.id} format`);
for (const h of HANDLERS) if (!MEDIA_FORMATS.some((f) => f.id === h.id)) throw new Error(`The ${h.id} media handler has no format`);
