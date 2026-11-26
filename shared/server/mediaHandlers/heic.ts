import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { heicImage, heicToJpeg } from '../heic';
import type { MediaHandler } from './index';

// HEIC/HEIF (what iPhones save). sharp's bundled libvips can't decode HEVC, so the photo is converted
// once into `<dataDir>/derived/<sha256>.jpg`: with macOS `sips`, elsewhere with the bundled libheif
// (see ../heic.ts). The original is untouched.

const run = promisify(execFile);

export const heifHandler: MediaHandler = {
  id: 'heif',
  async preview(file, ctx) {
    const out = join(ctx.derivedDir, `${await ctx.contentHash()}.jpg`);
    if (!existsSync(out)) {
      if (process.platform === 'darwin') await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', file, '--out', out]);
      else await heicToJpeg(file, out);
    }
    return out;
  },
  // Decoded in memory with libheif on every platform; rotation is already applied.
  image: (file) => heicImage(file),
};
