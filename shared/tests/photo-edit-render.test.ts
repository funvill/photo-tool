// The sharp side of photo edits: the pixels follow the same plan the page previews.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMatrix, colorMatrix, NO_ADJUST, type Adjust } from '../core/colorAdjust';
import { editPlan, flipEdit, type PhotoEdit } from '../core/photoEdit';
import { orientedSize } from '../server/media';
import { editFormatFor, renderEdited } from '../server/photoEditRender';

const dir = mkdtempSync(join(tmpdir(), 'pb-edit-render-'));
const id = (over: Partial<PhotoEdit> = {}): PhotoEdit => ({ rotate: 0, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, ...over });

/** 400 x 300: red on the left half, blue on the right. */
async function halves(file: string, withExif = false) {
  const left = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#ff0000' } }).png().toBuffer();
  let img = sharp({ create: { width: 400, height: 300, channels: 3, background: '#0000ff' } }).composite([{ input: left, left: 0, top: 0 }]);
  img = img.jpeg({ quality: 95 });
  if (withExif) img = img.withExif({ IFD0: { Copyright: 'x' }, IFD2: { DateTimeOriginal: '2026:03:14 09:12:05' } } as never);
  await img.toFile(file);
}

const pixel = async (file: string, x: number, y: number) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

beforeAll(() => mkdirSync(dir, { recursive: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('renderEdited', () => {
  it('crops to the left half', async () => {
    const src = join(dir, 'halves.jpg');
    await halves(src);
    const out = join(dir, 'crop.jpg');
    const size = await renderEdited(src, id({ crop: { x: 0, y: 0, w: 0.5, h: 1 } }), out, 'jpeg');
    expect(size).toEqual({ width: 200, height: 300 });
    const m = await sharp(out).metadata();
    expect([m.width, m.height]).toEqual([200, 300]);
    const [r, g, b] = await pixel(out, 100, 150);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  });

  it('follows the upright picture when the file has an EXIF orientation', async () => {
    const src = join(dir, 'rot6.jpg');
    await sharp({ create: { width: 300, height: 400, channels: 3, background: '#808080' } }).jpeg().withMetadata({ orientation: 6 }).toFile(src);
    const up = await orientedSize(src);
    expect([up.width, up.height]).toEqual([400, 300]);
    const out = join(dir, 'rot6-out.jpg');
    const size = await renderEdited(src, id(), out, 'jpeg');
    expect(size).toEqual({ width: up.width, height: up.height });
  });

  it('turns a quarter', async () => {
    const src = join(dir, 'q.jpg');
    await halves(src);
    const out = join(dir, 'q-out.jpg');
    expect(await renderEdited(src, id({ rotate: 90 }), out, 'jpeg')).toEqual({ width: 300, height: 400 });
    // Clockwise: the red left half ends up on top.
    const [r] = await pixel(out, 150, 50);
    const [, , b] = await pixel(out, 150, 350);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
  });

  it('straightens to the planned size with no empty corners', async () => {
    const src = join(dir, 's.jpg');
    await halves(src);
    const out = join(dir, 's-out.jpg');
    const e = id({ straighten: 10 });
    const plan = editPlan(400, 300, e);
    const size = await renderEdited(src, e, out, 'jpeg');
    expect(Math.abs(size.width - plan.out.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(size.height - plan.out.h)).toBeLessThanOrEqual(1);
    for (const [x, y] of [[0, 0], [size.width - 1, 0], [0, size.height - 1], [size.width - 1, size.height - 1]]) {
      const [r, g, b] = await pixel(out, x, y);
      expect(r + g + b).toBeGreaterThan(60);
    }
  });

  it('straightens and crops together to the planned size', async () => {
    const src = join(dir, 'sc.jpg');
    await halves(src);
    const e = id({ rotate: 90, straighten: -7, crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } });
    const plan = editPlan(400, 300, e);
    const size = await renderEdited(src, e, join(dir, 'sc-out.jpg'), 'jpeg');
    expect(Math.abs(size.width - plan.out.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(size.height - plan.out.h)).toBeLessThanOrEqual(1);
  });

  it('keeps EXIF with an upright orientation when asked', async () => {
    const src = join(dir, 'exif.jpg');
    await halves(src, true);
    const out = join(dir, 'exif-out.jpg');
    await renderEdited(src, id({ rotate: 90 }), out, 'jpeg', { keepMetadata: true });
    // exifr is given the bytes, as in media.ts: with a path it calls fileHandle.stat(path), which Node 26 rejects.
    const tags = await exifr.parse(readFileSync(out), { pick: ['DateTimeOriginal'], reviveValues: false });
    expect(tags.DateTimeOriginal).toBeTruthy();
    expect([undefined, 1]).toContain((await sharp(out).metadata()).orientation);
    const plain = join(dir, 'plain-out.jpg');
    await renderEdited(src, id(), plain, 'jpeg');
    expect((await exifr.parse(readFileSync(plain), { pick: ['DateTimeOriginal'] }))?.DateTimeOriginal).toBeUndefined();
  });
});

describe('editFormatFor', () => {
  it('maps extensions', () => {
    expect(editFormatFor('a.HEIC')).toBe('jpeg');
    expect(editFormatFor('a.heif')).toBe('jpeg');
    expect(editFormatFor('a.jpg')).toBe('jpeg');
    expect(editFormatFor('a.jpeg')).toBe('jpeg');
    expect(editFormatFor('a.png')).toBe('png');
    expect(editFormatFor('a.webp')).toBe('webp');
  });
});

describe('#9 renderEdited: flip, light and colour', () => {
  /** A w x h picture of one colour (PNG: no JPEG noise). */
  const flat = async (file: string, rgb: [number, number, number], w = 8, h = 8, channels: 3 | 4 = 3) =>
    sharp({ create: { width: w, height: h, channels, background: channels === 4 ? { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 0.5 } : { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toFile(file);
  const adjust = (a: Partial<Adjust>): PhotoEdit => id({ adjust: { ...NO_ADJUST, ...a } });
  const near = (a: number[], b: number[], tol = 3) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(tol));

  it('flips: red on the left ends up on the right', async () => {
    const src = join(dir, 'f.jpg');
    await halves(src);
    const out = join(dir, 'f-out.jpg');
    await renderEdited(src, id({ flip: true }), out, 'jpeg');
    expect((await pixel(out, 50, 150))[2]).toBeGreaterThan(200);
    expect((await pixel(out, 350, 150))[0]).toBeGreaterThan(200);
  });

  it('flipEdit on a turned photo mirrors what is shown, left to right', async () => {
    const src = join(dir, 'ft.png');
    // Four quadrants of different colours, so a wrong mirror (top to bottom) shows.
    const q = (c: string) => sharp({ create: { width: 20, height: 15, channels: 3, background: c } }).png().toBuffer();
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#000000' } })
      .composite([{ input: await q('#ff0000'), left: 0, top: 0 }, { input: await q('#00ff00'), left: 20, top: 0 }, { input: await q('#0000ff'), left: 0, top: 15 }, { input: await q('#ffffff'), left: 20, top: 15 }])
      .png().toFile(src);
    const e = id({ rotate: 90, crop: { x: 0, y: 0, w: 0.6, h: 1 } });
    const before = join(dir, 'ft-before.png');
    const after = join(dir, 'ft-after.png');
    await renderEdited(src, e, before, 'png');
    await renderEdited(src, flipEdit(e), after, 'png');
    const mirrored = await sharp(before).flop().raw().toBuffer();
    const got = await sharp(after).raw().toBuffer();
    expect(got.equals(mirrored)).toBe(true);
  });

  it('brightness +50 makes a mid-grey photo about 51 levels lighter', async () => {
    const src = join(dir, 'grey.jpg');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg({ quality: 95 }).toFile(src);
    const out = join(dir, 'grey-out.jpg');
    await renderEdited(src, adjust({ brightness: 50 }), out, 'jpeg');
    const before = (await sharp(src).stats()).channels[0].mean;
    const after = (await sharp(out).stats()).channels[0].mean;
    expect(Math.abs(after - before - 51)).toBeLessThanOrEqual(3);
  });

  it('saturation -100 turns a red photo grey', async () => {
    const src = join(dir, 'red.jpg');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#d02020' } }).jpeg({ quality: 95 }).toFile(src);
    const out = join(dir, 'red-out.jpg');
    await renderEdited(src, adjust({ saturation: -100 }), out, 'jpeg');
    const [r, g, b] = await pixel(out, 4, 4);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(3);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(3);
  });

  it('the saved colour is the colour the page works out with the same matrix, even when it clips', async () => {
    const cases: [number[], Partial<Adjust>][] = [
      [[180, 90, 40], { brightness: 30, contrast: -20 }],
      [[230, 30, 120], { brightness: -50, contrast: 100 }],
      [[20, 200, 90], { saturation: 60, warmth: -70, brightness: 10 }],
      [[60, 60, 200], { warmth: 100, contrast: 40 }],
    ];
    for (const [n, [rgb, a]] of cases.entries()) {
      const src = join(dir, `m${n}.png`);
      await flat(src, rgb as [number, number, number]);
      const out = join(dir, `m${n}-out.png`);
      await renderEdited(src, adjust(a), out, 'png');
      near(await pixel(out, 4, 4), applyMatrix(rgb, colorMatrix({ ...NO_ADJUST, ...a })));
    }
  });

  it('a greyscale photo takes colour too (warmth tints it)', async () => {
    const src = join(dir, 'bw.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).toColourspace('b-w').png().toFile(src);
    expect((await sharp(src).metadata()).channels).toBe(1);
    const out = join(dir, 'bw-out.png');
    await renderEdited(src, adjust({ warmth: 100 }), out, 'png');
    near(await pixel(out, 4, 4), applyMatrix([128, 128, 128], colorMatrix({ ...NO_ADJUST, warmth: 100 })));
  });

  it('a PNG with transparency keeps it', async () => {
    const src = join(dir, 'alpha.png');
    await flat(src, [100, 100, 100], 8, 8, 4);
    const out = join(dir, 'alpha-out.png');
    await renderEdited(src, adjust({ brightness: 50 }), out, 'png');
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    near([data[0], data[1], data[2], data[3]], [151, 151, 151, 128], 3);
  });
});
