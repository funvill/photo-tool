// Generates a deterministic synthetic "trip" for tests and demos: no personal photos needed.
// Covers the cases the milestone must survive: mixed orientations, a panorama, a burst of
// near-duplicates, an exact duplicate, a blurry frame, a low-resolution image, a HEIC file,
// an EXIF-rotated file, and an undated PNG.
//
//   npm run fixtures            → fixtures/generated/trip  (20 photos)
//                                 and fixtures/generated/formats (one AVIF, TIFF, GIF, SVG, BMP, ICO)
//   npm run fixtures -- 500     → fixtures/generated/large-500

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureInitialized, jsEncodeImage } from 'elheif';
import sharp from 'sharp';
import { mulberry32 } from '../photobook-editor/core/random';

interface Scene {
  name: string;
  w: number;
  h: number;
  day: number;
  time: string;
  hue: number;
  subjectX: number;
  subjectY: number;
  label: string;
  seed: number;
}

const PALETTES = [
  ['#f6d365', '#fda085'], ['#a1c4fd', '#c2e9fb'], ['#d4fc79', '#96e6a1'], ['#84fab0', '#8fd3f4'],
  ['#fccb90', '#d57eeb'], ['#e0c3fc', '#8ec5fc'], ['#f093fb', '#f5576c'], ['#4facfe', '#00f2fe'],
];

function sceneSvg(s: Scene): string {
  const rnd = mulberry32(s.seed);
  const [c1, c2] = PALETTES[s.hue % PALETTES.length];
  const horizon = s.h * (0.55 + rnd() * 0.15);
  const ridge = Array.from({ length: 9 }, (_, i) => `${(i / 8) * s.w},${horizon - rnd() * s.h * 0.25}`).join(' ');
  const r = Math.min(s.w, s.h) * 0.12;
  const sx = s.subjectX * s.w;
  const sy = s.subjectY * s.h;
  const fs = Math.round(Math.min(s.w, s.h) * 0.06);
  // Fine texture lines give the sharpness detector real detail to measure.
  const lines = Array.from({ length: 60 }, (_, i) => {
    const y = horizon + ((s.h - horizon) * i) / 60;
    return `<line x1="0" y1="${y}" x2="${s.w}" y2="${y + rnd() * 6}" stroke="#ffffff" stroke-opacity="${0.15 + rnd() * 0.2}" stroke-width="2"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s.w}" height="${s.h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <polygon points="0,${s.h} ${ridge} ${s.w},${s.h}" fill="#2d3a4a" fill-opacity="0.75"/>
    <rect y="${horizon}" width="${s.w}" height="${s.h - horizon}" fill="#1f4e5f" fill-opacity="0.55"/>
    ${lines}
    <circle cx="${sx}" cy="${sy}" r="${r}" fill="#fff4d6" stroke="#222" stroke-width="${r * 0.08}"/>
    <circle cx="${sx}" cy="${sy}" r="${r * 0.45}" fill="#e85d3f"/>
    <text x="${sx}" y="${sy + r + fs * 1.4}" font-family="Helvetica, Arial" font-size="${fs}" font-weight="700" text-anchor="middle" fill="#111">${s.label}</text>
    <text x="${s.w * 0.03}" y="${s.h * 0.06 + fs * 0.6}" font-family="Helvetica, Arial" font-size="${fs * 0.7}" fill="#111" fill-opacity="0.8">↑ TOP · ${s.name}</text>
  </svg>`;
}

async function writeJpeg(dir: string, s: Scene, opts: { blur?: number; date?: boolean; orientation6?: boolean } = {}) {
  let img = sharp(Buffer.from(sceneSvg(s)));
  if (opts.blur) img = img.blur(opts.blur);
  const exif: Record<string, Record<string, string>> = { IFD0: { Make: 'Photobook Fixture', Model: 'Synthetic' } };
  if (opts.date !== false) {
    exif.IFD2 = { DateTimeOriginal: `2026:03:${String(13 + s.day).padStart(2, '0')} ${s.time}:00` };
    exif.IFD3 = { GPSLatitudeRef: 'N', GPSLatitude: `${35 + s.day}/1 40/1 0/1`, GPSLongitudeRef: 'E', GPSLongitude: '139/1 45/1 0/1' };
  }
  const path = join(dir, `${s.name}.jpg`);
  if (opts.orientation6) {
    // Stored rotated 90° counter-clockwise with EXIF orientation 6 ("rotate 90° CW to view").
    const upright = await img.png().toBuffer();
    await sharp(upright).rotate(-90).jpeg({ quality: 90 }).withExif(exif).withMetadata({ orientation: 6 }).toFile(path);
  } else {
    await img.jpeg({ quality: 90 }).withExif(exif).toFile(path);
  }
  return path;
}

async function trip(dir: string) {
  const L = { w: 3000, h: 2000 };
  const P = { w: 2000, h: 3000 };
  let seed = 1;
  const sc = (name: string, size: { w: number; h: number }, day: number, time: string, hue: number, sx: number, sy: number, label: string, sameAs?: number): Scene => ({
    name, ...size, day, time, hue, subjectX: sx, subjectY: sy, label, seed: sameAs ?? seed++,
  });
  const scenes: [Scene, Parameters<typeof writeJpeg>[2]?][] = [
    [sc('day1-01-arrival', L, 1, '09:05', 0, 0.3, 0.4, 'Arrival')],
    [sc('day1-02-street', P, 1, '10:20', 1, 0.5, 0.35, 'Old street')],
    [sc('day1-03-market', L, 1, '11:45', 2, 0.65, 0.45, 'Market')],
    [sc('day1-04-lunch', P, 1, '13:10', 3, 0.4, 0.5, 'Lunch')],
    [sc('day1-05-harbour-pano', { w: 5400, h: 2000 }, 1, '17:30', 4, 0.7, 0.4, 'Harbour panorama')],
    [sc('day1-06-dusk', L, 1, '19:15', 5, 0.25, 0.3, 'Dusk')],
    [sc('day2-01-trail', L, 2, '08:00', 6, 0.55, 0.45, 'Trailhead')],
    [sc('day2-02-burst-a', L, 2, '10:00', 7, 0.5, 0.5, 'Summit')],
    // A burst: same scene, subject shifting slightly between frames.
    [sc('day2-02-burst-b', L, 2, '10:00', 7, 0.52, 0.5, 'Summit', 8)],
    [sc('day2-02-burst-c', L, 2, '10:01', 7, 0.54, 0.51, 'Summit', 8)],
    [sc('day2-03-blurry', P, 2, '12:30', 0, 0.5, 0.4, 'Blurry candid'), { blur: 14 }],
    [sc('day2-04-lake', L, 2, '14:00', 1, 0.35, 0.55, 'Lake')],
    [sc('day2-05-rotated', P, 2, '16:20', 2, 0.5, 0.3, 'EXIF rotated'), { orientation6: true }],
    [sc('day3-01-cafe', P, 3, '09:30', 3, 0.6, 0.4, 'Café')],
    [sc('day3-02-museum', L, 3, '11:00', 4, 0.45, 0.5, 'Museum')],
    [sc('day3-03-garden', L, 3, '13:40', 5, 0.7, 0.6, 'Garden')],
    [sc('day3-04-departure', L, 3, '18:00', 6, 0.5, 0.45, 'Departure')],
  ];
  for (const [s, opts] of scenes) await writeJpeg(dir, s, opts);

  // Exact duplicate under another name (same bytes).
  copyFileSync(join(dir, 'day1-03-market.jpg'), join(dir, 'day1-03-market-copy.jpg'));
  // Low resolution phone screenshot-sized image.
  await writeJpeg(dir, sc('day3-05-lowres', { w: 640, h: 480 }, 3, '19:00', 7, 0.5, 0.5, 'Low res'));
  // Undated PNG (no EXIF at all).
  await sharp(Buffer.from(sceneSvg(sc('undated-scan', { w: 2400, h: 2400 }, 0, '00:00', 2, 0.5, 0.5, 'Undated scan')))).png().toFile(join(dir, 'undated-scan.png'));
  // HEIC (HEVC), encoded with elheif: libheif + kvazaar as WebAssembly, so it is made the same way
  // on every platform with nothing installed. Pixels only: the file carries no EXIF date or GPS.
  const heic = sc('day2-06-heic-sunset', L, 2, '19:40', 4, 0.6, 0.35, 'HEIC sunset');
  const { data, info } = await sharp(Buffer.from(sceneSvg(heic))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  await ensureInitialized();
  const encoded = jsEncodeImage(new Uint8Array(data), info.width, info.height);
  if (encoded.err) throw new Error(`Could not encode the HEIC fixture: ${encoded.err}`);
  writeFileSync(join(dir, `${heic.name}.heic`), encoded.data);
}

/** A 24-bit, bottom-up BMP (sharp can't write BMP). */
function bmpBytes(rgb: Buffer, width: number, height: number): Buffer {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + stride * height);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      out[row + x * 3] = rgb[i + 2];
      out[row + x * 3 + 1] = rgb[i + 1];
      out[row + x * 3 + 2] = rgb[i];
    }
  }
  return out;
}

/** An icon with a 256 px PNG picture and a 32 px 32-bit BMP one (with its, empty, 1-bit mask). */
function icoBytes(png256: Buffer, rgba32: Buffer): Buffer {
  const side = 32;
  const dib = Buffer.alloc(40 + side * side * 4 + (side / 8) * side);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(side, 4);
  dib.writeInt32LE(side * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4;
      const o = 40 + ((side - 1 - y) * side + x) * 4;
      dib[o] = rgba32[i + 2];
      dib[o + 1] = rgba32[i + 1];
      dib[o + 2] = rgba32[i];
      dib[o + 3] = rgba32[i + 3];
    }
  }
  const header = Buffer.alloc(6 + 2 * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(2, 4);
  const entries: [number, Buffer][] = [[side, dib], [0, png256]];
  let offset = header.length;
  entries.forEach(([size, data], i) => {
    const e = 6 + i * 16;
    header[e] = size;
    header[e + 1] = size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map(([, d]) => d)]);
}

/** A solid picture of one colour, as PNG bytes. */
const solid = (w: number, h: number, colour: string) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();

// One small file per format phase 2 of #6 added, in a folder of their own (tests count the trip's photos).
async function formats(dir: string) {
  const L = { w: 1200, h: 800 };
  let seed = 100;
  const sc = (name: string, size: { w: number; h: number }, hue: number, label: string): Scene => ({
    name, ...size, day: 1, time: '12:00', hue, subjectX: 0.5, subjectY: 0.45, label, seed: seed++,
  });
  const scene = (s: Scene) => sharp(Buffer.from(sceneSvg(s))).png().toBuffer();
  // AVIF, with an EXIF date (sharp writes EXIF into the HEIF container).
  const avif = sc('avif-lake', L, 1, 'AVIF lake');
  await sharp(await scene(avif)).avif({ quality: 60 })
    .withExif({ IFD0: { Make: 'Photobook Fixture', Model: 'Synthetic' }, IFD2: { DateTimeOriginal: '2026:04:02 12:00:00' } })
    .toFile(join(dir, `${avif.name}.avif`));
  // A two-page TIFF: the scene, then a magenta page that must never be the one shown.
  const tiff = sc('tiff-harbour', L, 4, 'TIFF harbour');
  await sharp([await scene(tiff), await solid(L.w, L.h, '#ff00ff')], { join: { animated: true } }).tiff({ compression: 'lzw' }).toFile(join(dir, `${tiff.name}.tif`));
  // An animated GIF: a red frame first, then a blue one. It is shown as its first frame.
  await sharp([await solid(320, 240, '#ff0000'), await solid(320, 240, '#0000ff')], { join: { animated: true } }).gif({ delay: [400, 400], loop: 0 }).toFile(join(dir, 'gif-animated.gif'));
  // A 300 × 200 SVG drawing with a see-through background around its rounded box.
  writeFileSync(join(dir, 'svg-badge.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
  <rect x="10" y="10" width="280" height="180" rx="24" fill="#2e7d32"/>
  <circle cx="150" cy="100" r="60" fill="#ffeb3b"/>
</svg>
`);
  // A 24-bit BMP.
  const bmp = sc('bmp-garden', { w: 600, h: 400 }, 5, 'BMP garden');
  const raw = await sharp(await scene(bmp)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  writeFileSync(join(dir, `${bmp.name}.bmp`), bmpBytes(raw.data, raw.info.width, raw.info.height));
  // An icon: a 256 px orange PNG picture (the one shown) and a 32 px grey BMP one.
  const small = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } }).raw().toBuffer();
  writeFileSync(join(dir, 'ico-app.ico'), icoBytes(await solid(256, 256, '#ff8800'), small));
}

async function large(dir: string, count: number) {
  for (let i = 0; i < count; i++) {
    const day = 1 + Math.floor(i / 60);
    const portrait = i % 3 === 0;
    const minutes = 8 * 60 + (i % 60) * 12;
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    await writeJpeg(dir, {
      name: `IMG_${String(i + 1).padStart(4, '0')}`, w: portrait ? 1200 : 1800, h: portrait ? 1800 : 1200,
      day, time, hue: i, subjectX: 0.3 + ((i * 37) % 40) / 100, subjectY: 0.4, label: `#${i + 1}`, seed: 1000 + i,
    });
  }
}

const count = Number(process.argv[2] ?? 0);
const root = join(process.cwd(), 'fixtures', 'generated');
const jobs: [string, (dir: string) => Promise<void>][] = count ? [[`large-${count}`, (d) => large(d, count)]] : [['trip', trip], ['formats', formats]];
for (const [name, make] of jobs) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await make(dir);
  console.log(`Wrote fixtures to ${dir}`);
}
