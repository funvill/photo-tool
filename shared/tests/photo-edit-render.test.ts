// The sharp side of photo edits: the pixels follow the same plan the page previews.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editPlan, type PhotoEdit } from '../core/photoEdit';
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

describe('renderEdited, see-through pictures', () => {
  /** 100 × 80, see-through except a red square in the middle. */
  async function cutout(file: string) {
    const red = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    await sharp({ create: { width: 100, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: red, left: 40, top: 30 }]).png().toFile(file);
  }

  it('writes a JPEG on white, as every view shows it (not on black)', async () => {
    const src = join(dir, 'cutout.png');
    await cutout(src);
    for (const edit of [id(), id({ rotate: 90 }), id({ straighten: 5 })]) {
      const out = join(dir, `cutout-${edit.rotate}-${edit.straighten}.jpg`);
      await renderEdited(src, edit, out, 'jpeg');
      const { width, height } = await sharp(out).metadata();
      for (const v of await pixel(out, 1, 1)) expect(v, `${JSON.stringify(edit)} corner`).toBeGreaterThan(245);
      const [r, g, b] = await pixel(out, Math.floor(width! / 2), Math.floor(height! / 2));
      expect([r > 200, g < 60, b < 60]).toEqual([true, true, true]);
    }
  });

  it('keeps see-through parts see-through in a PNG or WebP', async () => {
    const src = join(dir, 'cutout2.png');
    await cutout(src);
    for (const format of ['png', 'webp'] as const) {
      const out = join(dir, `cutout2.${format}`);
      await renderEdited(src, id(), out, format);
      const { data } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(data[3], format).toBe(0);
    }
  });
});
