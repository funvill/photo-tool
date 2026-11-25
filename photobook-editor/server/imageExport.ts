import { rm, stat } from 'node:fs/promises';
import type { BookDocument } from '../core';
import { exportPosterPdf, type ExportAsset } from './pdf';
import { rasterPdf } from './pdfRaster';

// Posters as images (PNG or JPEG) for sharing or printing at home. The poster is exported to the
// same verified PDF as for print, rendered (see pdfRaster.ts) at the asked resolution, then
// cropped to the trim — so the image is exactly what the print shop would get.

export const MAX_IMAGE_PX = 14000;

export interface ImageExportResult {
  path: string;
  bytes: number;
  widthPx: number;
  heightPx: number;
  dpi: number;
  format: 'png' | 'jpeg';
}

export async function exportPosterImage(
  doc: BookDocument,
  assets: Map<string, ExportAsset>,
  outPath: string,
  opts: { format: 'png' | 'jpeg'; dpi: number },
): Promise<ImageExportResult> {
  const s = doc.settings;
  const inch = (mm: number) => mm / 25.4;
  const pageW = s.trimWidthMm + 2 * s.bleedMm;
  const pageH = s.trimHeightMm + 2 * s.bleedMm;
  // Keep within a sensible size: very large posters at 300 DPI drop to what fits.
  const dpi = Math.max(36, Math.min(opts.dpi, MAX_IMAGE_PX / inch(Math.max(pageW, pageH))));
  const pdf = `${outPath}.tmp.pdf`;
  let raster: Awaited<ReturnType<typeof rasterPdf>> | null = null;
  try {
    await exportPosterPdf(doc, assets, pdf);
    const longPx = Math.round(inch(Math.max(pageW, pageH)) * dpi);
    raster = await rasterPdf(pdf, { w: pageW, h: pageH }, longPx);
    const k = raster.pxPerMm;
    const left = Math.round(s.bleedMm * k);
    const top = Math.round(s.bleedMm * k);
    const width = Math.min(raster.width - left, Math.round(s.trimWidthMm * k));
    const height = Math.min(raster.height - top, Math.round(s.trimHeightMm * k));
    let img = raster.image().extract({ left, top, width, height }).withMetadata({ density: Math.round(dpi) });
    img = opts.format === 'jpeg' ? img.flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }) : img.png({ compressionLevel: 7 });
    await img.toFile(outPath);
    return { path: outPath, bytes: (await stat(outPath)).size, widthPx: width, heightPx: height, dpi: Math.round(dpi), format: opts.format };
  } finally {
    await rm(pdf, { force: true });
    await raster?.dispose();
  }
}
