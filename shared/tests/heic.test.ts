// HEIC photos without macOS: the bundled WebAssembly engine (libheif). It runs on every platform,
// so these tests do too; what macOS does with `sips` instead is covered by the editor's import tests.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeHeic, embedIccProfile, heicToJpeg } from '../server/heic';

const FIXTURES = join(process.cwd(), 'fixtures', 'generated', 'trip');
const HEIC = join(FIXTURES, 'day2-06-heic-sunset.heic');

/** The pixel at (x, y) of raw RGB data. */
const at = (data: Buffer, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

describe.runIf(existsSync(HEIC))('HEIC decoding (libheif as WebAssembly)', () => {
  it('decodes the picture itself: right size, right colours in the right places', async () => {
    const { data, width, height, icc } = await decodeHeic(HEIC);
    expect([width, height, data.length]).toEqual([3000, 2000, 3000 * 2000 * 3]);
    expect(icc).toBeNull(); // the fixture carries no profile
    // The fixture's subject is a red dot (#e85d3f) at 60% across, 35% down, in a cream ring (#fff4d6).
    const [r, g, b] = at(data, width, 1800, 700);
    expect(Math.abs(r - 0xe8) + Math.abs(g - 0x5d) + Math.abs(b - 0x3f)).toBeLessThan(40);
    const [rr, rg, rb] = at(data, width, 1800 + 190, 700);
    expect(Math.abs(rr - 0xff) + Math.abs(rg - 0xf4) + Math.abs(rb - 0xd6)).toBeLessThan(40);
    // Pale sky along the top edge, dark water along the bottom: the right way up.
    expect(at(data, width, 1500, 60)[0]).toBeGreaterThan(at(data, width, 1500, 1900)[0] + 100);
  });

  it('decodes several at once, and reports a file that is not HEIC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heic-'));
    const bad = join(dir, 'not-really.heic');
    writeFileSync(bad, 'this is not a photo');
    const results = await Promise.allSettled([decodeHeic(HEIC), decodeHeic(bad), decodeHeic(HEIC), decodeHeic(HEIC), decodeHeic(join(dir, 'missing.heic'))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'rejected']);
    expect(String((results[1] as PromiseRejectedResult).reason.message)).toMatch(/^Could not open this HEIC photo/);
    // The decoder is still usable after the failures.
    expect((await decodeHeic(HEIC)).width).toBe(3000);
    rmSync(dir, { recursive: true, force: true });
  });

  it('converts to a JPEG the rest of the pipeline reads, leaving no temporary file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heic-'));
    const out = join(dir, 'converted.jpg');
    await heicToJpeg(HEIC, out);
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height, meta.orientation]).toEqual(['jpeg', 3000, 2000, undefined]);
    expect(readdirSync(dir)).toEqual(['converted.jpg']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries a colour profile into the JPEG (iPhone photos are Display P3)', async () => {
    const plain = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
    expect((await sharp(plain).metadata()).icc).toBeUndefined();
    const p3 = (await sharp(await sharp(plain).withIccProfile('p3').jpeg().toBuffer()).metadata()).icc!;
    expect(p3.length).toBeGreaterThan(100);
    const tagged = embedIccProfile(plain, p3);
    const meta = await sharp(tagged).metadata();
    expect([meta.width, meta.height]).toEqual([40, 30]);
    expect(meta.icc!.equals(p3)).toBe(true);
    // A profile too large for one segment is split, each part numbered "n of count".
    const big = embedIccProfile(plain, Buffer.alloc(150_000, 7));
    const segments: number[][] = [];
    for (let i = 2; big.readUInt16BE(i) === 0xffe2; i += 2 + big.readUInt16BE(i + 2)) segments.push([big[i + 16], big[i + 17], big.readUInt16BE(i + 2)]);
    expect(segments).toEqual([[1, 3, 65535], [2, 3, 65535], [3, 3, 150_000 - 2 * 65519 + 16]]);
    expect((await sharp(big).metadata()).width).toBe(40);
  });
});
