import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp, { type Sharp } from 'sharp';
import type { PDFiumLibrary } from '@hyzyla/pdfium';
import { pdfiumDir } from './resources';

// Turning a page of the verified print PDF into pixels, for poster images and the flipbook.
// macOS uses its own PDF renderer (`sips`), as before. Windows and Linux use PDFium, the renderer
// inside Chrome, compiled to WebAssembly: no native module and no system PDF tools needed. The
// fonts are embedded in our PDFs, so nothing is looked up on the computer or anywhere else.

const run = promisify(execFile);

export interface Raster {
  width: number;
  height: number;
  /** Rendered pixels per millimetre of page. */
  pxPerMm: number;
  /** A fresh sharp pipeline over the rendered page each time. */
  image(): Sharp;
  dispose(): Promise<void>;
}

let pdfium: Promise<PDFiumLibrary> | null = null;

/**
 * PDFium is loaded from its own folder at run time (see resources.ts) rather than bundled: its
 * loader finds itself through the module system, which a bundled server does not have.
 */
function loadPdfium(): Promise<PDFiumLibrary> {
  return (pdfium ??= (async () => {
    const dir = pdfiumDir();
    const lib = createRequire(join(dir, 'index.cjs'))('./index.cjs') as typeof import('@hyzyla/pdfium');
    return lib.PDFiumLibrary.init({ wasmBinary: await readFile(join(dir, 'pdfium.wasm')) });
  })().catch((e) => {
    pdfium = null;
    throw e;
  }));
}

/**
 * Render the first page of a PDF, `longPx` on its long edge, on white. `pageMm` is the page's
 * size, so the pixel size is exact rather than rounded from the PDF's points.
 */
export async function rasterPdf(pdfPath: string, pageMm: { w: number; h: number }, longPx: number): Promise<Raster> {
  if (process.platform === 'darwin') {
    const png = `${pdfPath}.png`;
    await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(longPx), pdfPath, '--out', png]);
    const meta = await sharp(png).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0, pxPerMm: (meta.width ?? 1) / pageMm.w, image: () => sharp(png), dispose: () => rm(png, { force: true }) };
  }
  const k = longPx / Math.max(pageMm.w, pageMm.h);
  const width = Math.max(1, Math.round(pageMm.w * k));
  const height = Math.max(1, Math.round(pageMm.h * k));
  const lib = await loadPdfium();
  try {
    const doc = await lib.loadDocument(await readFile(pdfPath));
    try {
      // scale 1 with both sides given: exactly width × height pixels.
      const { data } = await doc.getPage(0).render({ width, height, scale: 1, render: 'bitmap' });
      const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      // Opaque by construction (drawn on white): drop the alpha channel so PNGs don't carry one.
      return { width, height, pxPerMm: k, image: () => sharp(raw, { raw: { width, height, channels: 4 } }).removeAlpha(), dispose: async () => {} };
    } finally {
      doc.destroy();
    }
  } catch (e) {
    // A WebAssembly program that ran out of memory cannot be used again: start a fresh one next time.
    pdfium = null;
    throw e;
  }
}
