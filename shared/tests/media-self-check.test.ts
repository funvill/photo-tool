// The check the desktop self-test asks the server for: this sharp build decodes each new format from
// bytes made on the spot, and an SVG can't be loaded by its path. It proves the installed app on each
// platform, where the sharp build may differ (Linux's wasm build).
import { describe, expect, it } from 'vitest';
import { mediaSelfCheck } from '../server/mediaSelfCheck';

describe('mediaSelfCheck', () => {
  it('decodes a tiny AVIF, TIFF, GIF, SVG and BMP, and finds SVG refused by path and by content', async () => {
    const r = await mediaSelfCheck();
    expect(r.formats).toEqual({
      avif: { ok: true, width: 8, height: 6 },
      tiff: { ok: true, width: 8, height: 6 },
      gif: { ok: true, width: 8, height: 6 },
      svg: { ok: true, width: 2048, height: 1536 },
      bmp: { ok: true, width: 8, height: 6 },
    });
    expect(r.svgGuard).toEqual({ blockApplied: true, pathRefused: true, disguisedRefused: true });
    expect(r.ok).toBe(true);
  });
});
