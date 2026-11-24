import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { extname } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { editPlan, type PhotoEdit } from '../core';

// Renders a photo edit (crop, rotate, straighten) into a new file. The steps follow `editPlan` in
// core/photoEdit.ts, the same plan the page uses for its preview. The original is only read.

export type EditFormat = 'jpeg' | 'png' | 'webp';

/** The format an edited photo is written in: its own, except HEIC, which is written as JPEG. */
export function editFormatFor(path: string): EditFormat {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  return 'jpeg';
}

/** A lossless step between two sharp pipelines (sharp applies rotate and extract in a fixed order, so each gets its own). */
const lossless = (img: Sharp) => img.png({ compressionLevel: 0 }).toBuffer({ resolveWithObject: true });

/**
 * Writes `workPath` with `edit` applied to `outFile`: EXIF orientation first, then the quarter turn, the
 * straighten turn (corners filled black, then cut away), and the crop. Returns the size written.
 * `keepMetadata` keeps the EXIF block, with the orientation set upright.
 */
export async function renderEdited(
  workPath: string,
  edit: PhotoEdit,
  outFile: string,
  format: EditFormat,
  opts: { keepMetadata?: boolean } = {},
): Promise<{ width: number; height: number }> {
  const keep = !!opts.keepMetadata;
  const withMeta = (img: Sharp) => (keep ? img.keepExif() : img);

  // Step 0 and 1: the upright picture, turned by the quarter.
  const upright = await lossless(withMeta(sharp(workPath, { failOn: 'none' }).autoOrient()));
  const plan = editPlan(upright.info.width, upright.info.height, edit);
  let step = await lossless(withMeta(sharp(upright.data).rotate(plan.rotate)));

  // Step 2: the straighten turn enlarges the canvas; the frame sits in its middle.
  if (plan.straighten !== 0) step = await lossless(withMeta(sharp(step.data).rotate(plan.straighten, { background: '#000000' })));
  const canvasW = step.info.width;
  const canvasH = step.info.height;
  const frameLeft = Math.max(0, Math.round((canvasW - plan.frame.w) / 2));
  const frameTop = Math.max(0, Math.round((canvasH - plan.frame.h) / 2));

  // Step 3: cut the crop out of the frame (one extract for both).
  const left = Math.min(frameLeft + plan.extract.left, canvasW - 1);
  const top = Math.min(frameTop + plan.extract.top, canvasH - 1);
  const width = Math.min(plan.extract.width, canvasW - left);
  const height = Math.min(plan.extract.height, canvasH - top);
  let out = withMeta(sharp(step.data).extract({ left, top, width, height }));
  if (keep) out = out.withMetadata({ orientation: 1 });
  if (format === 'png') out = out.png();
  else if (format === 'webp') out = out.webp({ quality: 95 });
  else out = out.jpeg({ quality: 95 });

  const tmp = `${outFile}.${randomUUID()}.tmp`;
  try {
    const info = await out.toFile(tmp);
    await rename(tmp, outFile);
    return { width: info.width, height: info.height };
  } finally {
    await rm(tmp, { force: true });
  }
}
