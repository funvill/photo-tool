import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import type { MediaHandler } from './index';
import { findRawPreviews, RAW_PREVIEW_MAX_PIXELS, rawExifBlock } from './rawPreview';
import { rasterFormat } from './sniff';

// Camera RAW files, shown through the biggest JPEG preview the camera stored in the file (phase 3 of
// #6; decoding the sensor data itself is phase 4). The RAW is never handed to sharp: our own parser
// (rawPreview.ts) finds the preview, the bytes are checked to start as a JPEG (sniff.ts), and only
// those bytes go to sharp, which writes the derived copy `<dataDir>/derived/<sha256>.preview.jpg`.
// That copy carries the RAW's own EXIF orientation (IFD0's; the preview's own tag only when the RAW
// has none), so everything downstream turns it upright exactly once, as it does any JPEG.
//
// A RAW with no preview this program can decode is not an error to try again and again: the finding
// is remembered (`<sha256>.no-preview`), `preview()` throws NoPreviewError, and the gallery shows a
// placeholder tile for it (noPreviewPicture).

/** RAW files bigger than this are not read (the biggest medium-format files are a few hundred MB). */
export const RAW_MAX_BYTES = 512 * 1024 * 1024;
/** How many candidates are given to sharp before giving up. */
const MAX_TRIES = 8;

/** The RAW holds no preview this program can show (or is too large, or damaged). */
export class NoPreviewError extends Error {}

const NO_PREVIEW = 'This RAW file has no preview picture Photo tools can show.';

async function readRaw(file: string): Promise<Buffer> {
  if ((await stat(file)).size > RAW_MAX_BYTES) throw new NoPreviewError(`This RAW file is too large to open (over ${RAW_MAX_BYTES / 1024 / 1024} MB).`);
  return readFile(file);
}

/**
 * The RAW's best preview as JPEG bytes carrying the RAW's orientation, or null when none decodes.
 * Candidates are tried biggest first; a JPEG that decodes only with warnings (cut short) is used
 * only when none decodes cleanly.
 */
export async function extractRawPreview(buf: Buffer): Promise<Buffer | null> {
  const found = findRawPreviews(buf);
  const tries = found.candidates.slice(0, MAX_TRIES);
  for (const failOn of ['warning', 'error'] as const) {
    for (const c of tries) {
      const bytes = buf.subarray(c.offset, c.offset + c.length);
      // Only bytes that start as a JPEG reach sharp, which picks its decoder by content.
      if (rasterFormat(bytes) !== 'jpeg') continue;
      try {
        const opts = { failOn, limitInputPixels: RAW_PREVIEW_MAX_PIXELS } as const;
        if ((await sharp(bytes, opts).metadata()).format !== 'jpeg') continue;
        return await sharp(bytes, opts)
          .withMetadata(found.orientation ? { orientation: found.orientation } : {})
          .jpeg({ quality: 95 })
          .toBuffer();
      } catch {
        // damaged: the next one
      }
    }
  }
  return null;
}

let placeholder: Promise<Buffer> | null = null;

/** The picture shown for a RAW with no preview: a dark card with a camera and the words "No preview". */
function placeholderJpeg(): Promise<Buffer> {
  placeholder ??= sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="#3a3f47"/>
  <rect x="440" y="250" width="320" height="210" rx="28" fill="none" stroke="#c9ced6" stroke-width="18"/>
  <rect x="520" y="215" width="120" height="50" rx="10" fill="#c9ced6"/>
  <circle cx="600" cy="355" r="66" fill="none" stroke="#c9ced6" stroke-width="18"/>
  <line x1="420" y1="500" x2="780" y2="210" stroke="#e57373" stroke-width="18" stroke-linecap="round"/>
  <text x="600" y="580" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="64" font-weight="700" fill="#e8eaed" text-anchor="middle">RAW</text>
  <text x="600" y="650" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="44" fill="#c9ced6" text-anchor="middle">No preview in this file</text>
</svg>`)).jpeg({ quality: 85 }).toBuffer();
  return placeholder;
}

/** The placeholder picture as a file in the derived cache (made once), for a RAW with no preview. */
export async function noPreviewPicture(derivedDir: string): Promise<string> {
  const out = join(derivedDir, 'raw-no-preview.jpg');
  if (!existsSync(out)) await writeAtomically(out, await placeholderJpeg());
  return out;
}

async function writeAtomically(out: string, bytes: Buffer): Promise<void> {
  const tmp = `${out}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    // The same RAW under two names can be read twice at once: the first one home wins.
    await rename(tmp, out).catch((e) => {
      if (!existsSync(out)) throw e;
    });
  } finally {
    await rm(tmp, { force: true });
  }
}

function rawHandler(id: string): MediaHandler {
  return {
    id,
    async preview(file, ctx) {
      const hash = await ctx.contentHash();
      const out = join(ctx.derivedDir, `${hash}.preview.jpg`);
      if (existsSync(out)) return out;
      const none = join(ctx.derivedDir, `${hash}.no-preview`);
      if (existsSync(none)) throw new NoPreviewError(NO_PREVIEW);
      const jpeg = await extractRawPreview(await readRaw(file));
      if (!jpeg) {
        await writeFile(none, '');
        throw new NoPreviewError(NO_PREVIEW);
      }
      await writeAtomically(out, jpeg);
      return out;
    },
    async image(file): Promise<Sharp> {
      const jpeg = await extractRawPreview(await readRaw(file)).catch((e) => {
        if (e instanceof NoPreviewError) return null;
        throw e;
      });
      return sharp(jpeg ?? (await placeholderJpeg())).rotate();
    },
    exifBlock: async (data) => rawExifBlock(data),
  };
}

/** One handler per RAW format of the registry: they all read the file the same way. */
export const rawHandlers = (ids: readonly string[]): MediaHandler[] => ids.map(rawHandler);
