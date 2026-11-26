import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sharp } from 'sharp';
import type { HandlerContext } from './index';

// A decoded copy in the derived cache (`<dataDir>/derived/<sha256>.png`), for formats sharp should
// not (SVG) or can't (BMP, ICO) read from the original. PNG keeps see-through pixels. Written to a
// temp file and renamed into place, so a copy that exists is always complete.

export async function derivedPng(file: string, ctx: HandlerContext, decode: (file: string) => Promise<Sharp>): Promise<string> {
  const out = join(ctx.derivedDir, `${await ctx.contentHash()}.png`);
  if (existsSync(out)) return out;
  const tmp = `${out}.${randomUUID()}.tmp`;
  try {
    await (await decode(file)).png({ compressionLevel: 6 }).toFile(tmp);
    // The same picture under two names can be decoded twice at once: the first one home wins.
    await rename(tmp, out).catch((e) => {
      if (!existsSync(out)) throw e;
    });
  } finally {
    await rm(tmp, { force: true });
  }
  return out;
}
