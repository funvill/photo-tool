// Phase 2 of #6: the new formats' handlers, on the generated fixtures (fixtures/generated/formats,
// made by `npm run fixtures`). For each one: the working image, both thumbnails and the full-size
// JPEG the zoomed view gets, and that the right picture (first page, first frame) is the one shown.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlerFor } from '../server/mediaHandlers';
import { SVG_MAX_SIDE, SVG_MIN_SIDE } from '../server/mediaHandlers/svg';
import { hashFile, orientedSize, readMetadata, THUMB_SIZES, workingFile, writeJpegThumb } from '../server/media';

const FORMATS = join(process.cwd(), 'fixtures', 'generated', 'formats');

interface Case {
  file: string;
  id: string;
  /** The working image's size. */
  size: [number, number];
  /** Read by sharp from the original (no copy, no hash), or decoded into the derived cache. */
  derived: boolean;
  /** The colour at the picture's centre, as the thumbnails show it (on white), within ±40 per channel. */
  centre?: [number, number, number];
}

const CASES: Case[] = [
  { file: 'avif-lake.avif', id: 'avif', size: [1200, 800], derived: false },
  // Page 2 is solid magenta: the centre of page 1 is the scene's red-and-cream subject, never magenta.
  { file: 'tiff-harbour.tif', id: 'tiff', size: [1200, 800], derived: false },
  // Frame 1 is red, frame 2 blue.
  { file: 'gif-animated.gif', id: 'gif', size: [320, 240], derived: false, centre: [255, 0, 0] },
  // 300 × 200 drawn at 2048 px across; a yellow circle in the middle.
  { file: 'svg-badge.svg', id: 'svg', size: [2048, 1365], derived: true, centre: [255, 235, 59] },
  { file: 'bmp-garden.bmp', id: 'bmp', size: [600, 400], derived: true },
  // The 256 px orange PNG picture is the biggest, so the one shown.
  { file: 'ico-app.ico', id: 'ico', size: [256, 256], derived: true, centre: [255, 136, 0] },
];

let root: string;
let dataDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'media-handlers-'));
  dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'derived'), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The RGB colour at the centre of an image file (flattened on white, as the thumbnails are). */
async function centreOf(file: string): Promise<number[]> {
  const { data, info } = await sharp(file).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
  return [data[o], data[o + 1], data[o + 2]];
}

const near = (got: number[], want: number[], by = 40) => got.every((v, i) => Math.abs(v - want[i]) <= by);

describe.runIf(existsSync(FORMATS))('the new formats, from their fixtures', () => {
  it('has one fixture per new format', () => {
    expect(readdirSync(FORMATS).map((f) => handlerFor(f)?.id).sort()).toEqual(CASES.map((c) => c.id).sort());
  });

  for (const c of CASES) {
    describe(c.file, () => {
      const original = () => join(FORMATS, c.file);

      it('makes the working image', async () => {
        let hashed = false;
        const work = await workingFile(original(), dataDir, async () => {
          hashed = true;
          return hashFile(original());
        });
        if (c.derived) {
          expect(work.derived).toBe(join(dataDir, 'derived', `${await hashFile(original())}.png`));
          expect(work.path).toBe(work.derived);
          expect(existsSync(work.path)).toBe(true);
          expect((await sharp(work.path).metadata()).format).toBe('png');
        } else {
          expect(work).toEqual({ path: original(), derived: null });
          expect(hashed).toBe(false);
        }
        const dims = await orientedSize(work.path);
        expect(dims.width).toBe(c.size[0]);
        expect(Math.abs(dims.height - c.size[1])).toBeLessThanOrEqual(1);
        // Asked again: the same copy, not decoded again.
        expect((await workingFile(original(), dataDir, () => hashFile(original()))).path).toBe(work.path);
      });

      it('makes both thumbnails and the full-size JPEG', async () => {
        const work = await workingFile(original(), dataDir, () => hashFile(original()));
        for (const size of ['s', 'm'] as const) {
          const out = join(root, `${c.id}_${size}.jpg`);
          await writeJpegThumb(work.path, size, out);
          const meta = await sharp(out).metadata();
          expect(meta.format).toBe('jpeg');
          expect(Math.max(meta.width!, meta.height!)).toBe(Math.min(THUMB_SIZES[size], Math.max(...c.size)));
          if (c.centre) expect(near(await centreOf(out), c.centre), `${c.file} ${size}: ${await centreOf(out)}`).toBe(true);
          // Not the TIFF's second page.
          expect(near(await centreOf(out), [255, 0, 255], 60)).toBe(false);
        }
        // /api/gallery/full: the working image upright, as JPEG.
        const full = await sharp(await sharp(work.path, { failOn: 'none' }).rotate().jpeg({ quality: 90 }).toBuffer()).metadata();
        expect([full.format, full.width]).toEqual(['jpeg', c.size[0]]);
      });

      it('gives an upright picture in memory (the editor\'s shelf previews)', async () => {
        const img = await handlerFor(original())!.image(original());
        const { info } = await img.resize(160, 160, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
        expect(Math.max(info.width, info.height)).toBe(160);
      });
    });
  }

  it('reads an AVIF photo\'s EXIF date', async () => {
    expect((await readMetadata(join(FORMATS, 'avif-lake.avif'))).capturedAt).toBe('2026-04-02T12:00:00');
  });
});

describe('SVG is untrusted', () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'svg-untrusted-'));
    mkdirSync(join(dir, 'data', 'derived'), { recursive: true });
    // A red picture beside the SVG, which the SVG tries to draw over its blue background.
    await sharp({ create: { width: 50, height: 50, channels: 3, background: '#ff0000' } }).png().toFile(join(dir, 'red.png'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const svgFile = (name: string, body: string, attrs = 'width="50" height="50"') => {
    const file = join(dir, name);
    writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`);
    return file;
  };
  const isBlue = async (file: string) => near(await centreOf(file), [0, 0, 255], 10);

  it('never draws files beside it, files by full path, or anything from the network', async () => {
    const abs = `file:///${join(dir, 'red.png').split('\\').join('/')}`;
    for (const href of ['red.png', './red.png', abs, 'http://127.0.0.1:5899/red.png']) {
      const name = `ref-${Math.random().toString(36).slice(2)}.svg`;
      const file = svgFile(name, `<rect width="50" height="50" fill="#0000ff"/><image href="${href}" xlink:href="${href}" width="50" height="50"/><script>throw 1</script>`);
      const work = await workingFile(file, join(dir, 'data'), () => hashFile(file));
      expect(await isBlue(work.path), href).toBe(true);
      const shelf = join(dir, `${name}.shelf.png`);
      await (await handlerFor(file)!.image(file)).png().toFile(shelf);
      expect(await isBlue(shelf), href).toBe(true);
    }
  });

  it('loads no other kind of outside reference either: <use>, XInclude, entities, stylesheets', async () => {
    // Each would turn the blue square red if it loaded. They are offered both beside the SVG and on
    // a local web server, which must see no request at all.
    writeFileSync(join(dir, 'red.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect id="r" width="50" height="50" fill="#ff0000"/></svg>');
    writeFileSync(join(dir, 'red.css'), 'rect { fill: #ff0000 !important; }');
    writeFileSync(join(dir, 'red.xml'), '<rect xmlns="http://www.w3.org/2000/svg" width="50" height="50" fill="#ff0000"/>');
    const requests: string[] = [];
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((r) => server.listen(5897, '127.0.0.1', () => r()));
    try {
      for (const base of ['', 'http://127.0.0.1:5897/']) {
        const head = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xi="http://www.w3.org/2001/XInclude" width="50" height="50"><rect width="50" height="50" fill="#0000ff"/>';
        const docs: Record<string, string> = {
          use: `${head}<use href="${base}red.svg#r" xlink:href="${base}red.svg#r"/></svg>`,
          xinclude: `${head}<xi:include href="${base}red.xml" parse="xml"/></svg>`,
          entity: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY red SYSTEM "${base}red.xml">]>${head}&red;</svg>`,
          import: `${head}<style>@import url(${base}red.css);</style></svg>`,
          pi: `<?xml version="1.0"?><?xml-stylesheet type="text/css" href="${base}red.css"?>${head}</svg>`,
        };
        for (const [kind, svg] of Object.entries(docs)) {
          const file = join(dir, `${kind}-${base ? 'net' : 'local'}.svg`);
          writeFileSync(file, svg);
          // Refused outright is as good as drawn without it; drawn, it must be blue.
          const work = await workingFile(file, join(dir, 'data'), () => hashFile(file)).catch(() => null);
          if (work) expect(await isBlue(work.path), `${kind} ${base || 'beside it'}`).toBe(true);
        }
      }
      expect(requests).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('caps the raster of a huge drawing, and scales up a tiny one', async () => {
    mkdirSync(join(dir, 'data', 'derived'), { recursive: true });
    const huge = svgFile('huge.svg', '<rect width="100%" height="100%" fill="#0000ff"/>', 'width="50000" height="25000"');
    const big = await orientedSize((await workingFile(huge, join(dir, 'data'), () => hashFile(huge))).path);
    expect([big.width, big.height]).toEqual([SVG_MAX_SIDE, SVG_MAX_SIDE / 2]);
    const tiny = svgFile('tiny.svg', '<rect width="100%" height="100%" fill="#0000ff"/>', 'width="2" height="1"');
    const small = await orientedSize((await workingFile(tiny, join(dir, 'data'), () => hashFile(tiny))).path);
    expect([small.width, small.height]).toEqual([SVG_MIN_SIDE, SVG_MIN_SIDE / 2]);
  });

  it('refuses an SVG whose drawing would be too big even at the lowest density', async () => {
    mkdirSync(join(dir, 'data', 'derived'), { recursive: true });
    const absurd = svgFile('absurd.svg', '<rect width="100%" height="100%" fill="#0000ff"/>', 'width="900000000" height="900000000"');
    await expect(workingFile(absurd, join(dir, 'data'), () => hashFile(absurd))).rejects.toThrow();
  });

  it('cannot be loaded by path anywhere in the process, even under a photo extension', async () => {
    const file = svgFile('disguised.svg', '<rect width="50" height="50" fill="#0000ff"/>');
    const jpg = join(dir, 'disguised.jpg');
    copyFileSync(file, jpg);
    await expect(sharp(file).metadata()).rejects.toThrow();
    await expect(sharp(jpg).metadata()).rejects.toThrow();
    await expect(orientedSize(jpg)).rejects.toThrow();
  });
});
