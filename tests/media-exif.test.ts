import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { exifFromTags, readMetadata } from '../src/server/media';

describe('exifFromTags', () => {
  it('reads a full tag set', () => {
    expect(exifFromTags({ LensModel: 'RF24-70mm F2.8', FocalLength: 50, FocalLengthIn35mmFormat: 75, FNumber: 2.8, ExposureTime: 0.004, ISO: 400, ExposureBiasValue: -0.7, Flash: 16 })).toEqual({
      lens: 'RF24-70mm F2.8', focalLength: 50, focalLength35: 75, aperture: 2.8, exposureTime: 0.004, iso: 400, exposureBias: -0.7, flash: false,
    });
  });
  it('takes the first of an ISO array', () => {
    expect(exifFromTags({ ISO: [400] }).iso).toBe(400);
  });
  it('reads Flash as a bit field or a string', () => {
    expect(exifFromTags({ Flash: 16 }).flash).toBe(false);
    expect(exifFromTags({ Flash: 25 }).flash).toBe(true);
    expect(exifFromTags({ Flash: 'Flash fired, auto mode' }).flash).toBe(true);
    expect(exifFromTags({ Flash: 'Flash did not fire' }).flash).toBe(false);
  });
  it('prefixes the lens make unless the model starts with it', () => {
    expect(exifFromTags({ LensMake: 'Canon', LensModel: 'RF50mm F1.8' }).lens).toBe('Canon RF50mm F1.8');
    expect(exifFromTags({ LensMake: 'Canon', LensModel: 'Canon RF50mm' }).lens).toBe('Canon RF50mm');
  });
  it('keeps an exposure bias of 0', () => {
    expect(exifFromTags({ ExposureBiasValue: 0 })).toEqual({ exposureBias: 0 });
  });
  it('drops junk values', () => {
    expect(exifFromTags({ FocalLength: 0, FNumber: -1, ExposureTime: NaN, ISO: Infinity, ExposureBiasValue: NaN, LensModel: '  ', FocalLengthIn35mmFormat: 'x' })).toEqual({});
  });
  it('gives {} for null and undefined', () => {
    expect(exifFromTags(null)).toEqual({});
    expect(exifFromTags(undefined)).toEqual({});
  });
});

describe('readMetadata exif', () => {
  it('reads exif.iso from a JPEG written by sharp with EXIF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-exif-'));
    try {
      const file = join(dir, 'a.jpg');
      writeFileSync(file, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } }).withExif({ IFD2: { ISOSpeedRatings: '200', FNumber: '28/10' } }).jpeg().toBuffer());
      const { exif } = await readMetadata(file);
      expect(exif.iso).toBe(200);
      expect(exif.aperture).toBeCloseTo(2.8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('gives {} for a missing file', async () => {
    expect((await readMetadata(join(tmpdir(), 'no-such-file.jpg'))).exif).toEqual({});
  });
});
