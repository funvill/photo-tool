import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { orientedSize, workingFile } from './media';
import { checkSvgGuard } from './mediaHandlers/svg';

// For the desktop self-test: does this sharp build (it differs per platform, and Linux can use a
// WebAssembly build) decode each format phase 2 of #6 added, and is an SVG refused by its path and
// under another name? Every file is made here, in a temp folder, from a few bytes.

export interface MediaSelfCheck {
  ok: boolean;
  formats: Record<string, { ok: boolean; width?: number; height?: number; error?: string }>;
  svgGuard: { blockApplied: boolean; pathRefused: boolean; disguisedRefused: boolean };
}

const W = 8;
const H = 6;

/** A W × H 24-bit BMP, all one colour (sharp can't write BMP). */
function tinyBmp(): Buffer {
  const stride = Math.ceil((W * 3) / 4) * 4;
  const out = Buffer.alloc(54 + stride * H);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(W, 18);
  out.writeInt32LE(H, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.set([200, 100, 50], 54 + y * stride + x * 3);
  return out;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#2e7d32"/></svg>`;

export async function mediaSelfCheck(): Promise<MediaSelfCheck> {
  const dir = await mkdtemp(join(tmpdir(), 'media-self-check-'));
  const dataDir = join(dir, 'data');
  await mkdir(join(dataDir, 'derived'), { recursive: true });
  try {
    const base = () => sharp({ create: { width: W, height: H, channels: 3, background: '#3366cc' } });
    const files: Record<string, () => Promise<Buffer>> = {
      avif: () => base().avif().toBuffer(),
      tiff: () => base().tiff().toBuffer(),
      gif: () => base().gif().toBuffer(),
      svg: async () => Buffer.from(SVG),
      bmp: async () => tinyBmp(),
    };
    const ext: Record<string, string> = { avif: 'avif', tiff: 'tif', gif: 'gif', svg: 'svg', bmp: 'bmp' };
    const formats: MediaSelfCheck['formats'] = {};
    for (const [id, make] of Object.entries(files)) {
      try {
        const file = join(dir, `check.${ext[id]}`);
        await writeFile(file, await make());
        const work = await workingFile(file, dataDir, `selfcheck-${id}`);
        const { width, height } = await orientedSize(work.path);
        formats[id] = { ok: width > 0 && height > 0, width, height };
      } catch (e) {
        formats[id] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    // An SVG named .jpg must be refused, by our own content check, whatever sharp does: plain, and
    // behind 600 spaces (libvips still finds that <svg; a fixed-size look at the first bytes did not).
    let disguisedRefused = true;
    for (const [name, bytes] of [['disguised.jpg', SVG], ['spaced.jpg', ' '.repeat(600) + SVG]]) {
      const disguised = join(dir, name);
      await writeFile(disguised, bytes);
      if (await workingFile(disguised, dataDir, `selfcheck-${name}`).then(() => true, () => false)) disguisedRefused = false;
    }
    const guard = await checkSvgGuard(() => undefined);
    const svgGuard = { ...guard, disguisedRefused };
    return { ok: Object.values(formats).every((f) => f.ok) && disguisedRefused, formats, svgGuard };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
