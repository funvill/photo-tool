import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import sharp, { type Sharp } from 'sharp';
import { libheifFile } from './resources';

// HEIC/HEIF photos (what iPhones save) on Windows and Linux. sharp's bundled libvips reads the
// HEIF container but has no HEVC decoder, so the pixels are decoded with libheif + libde265
// compiled to WebAssembly (the libheif-js package): no native module, nothing downloaded, the same
// file on every platform. macOS keeps using `sips` (see media.ts).
//
// Decoding is one long synchronous call (about a second for a 12 MP photo), so it runs in worker
// threads: the server keeps answering while photos import, and the decoder's memory (which only
// ever grows) is given back when an idle worker is stopped.

export interface DecodedHeic {
  /** 8-bit RGB, rotation and mirroring from the file already applied. */
  data: Buffer;
  width: number;
  height: number;
  /** The photo's ICC colour profile (Display P3 on iPhones), when the file carries one. */
  icc: Buffer | null;
}

// Plain CommonJS, so it runs the same from source (tsx, vitest) and inside the bundled app.
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const libheif = require(workerData.lib)();

function profile(handle) {
  // The raw C functions want the handle's address, which embind keeps in $$.ptr.
  const ptr = handle.$$ && handle.$$.ptr;
  if (!ptr || !libheif._heif_image_handle_get_raw_color_profile_size) return null;
  const size = libheif._heif_image_handle_get_raw_color_profile_size(ptr);
  if (!(size > 0 && size < 16 * 1024 * 1024)) return null;
  const err = libheif._malloc(32); // the returned heif_error struct
  const buf = libheif._malloc(size);
  try {
    libheif._heif_image_handle_get_raw_color_profile(err, ptr, buf);
    if (libheif.HEAP32[err >> 2] !== 0) return null;
    return libheif.HEAPU8.slice(buf, buf + size);
  } finally {
    libheif._free(buf);
    libheif._free(err);
  }
}

async function decode(path) {
  const ok = libheif.heif_error_code.heif_error_Ok;
  const ctx = libheif.heif_context_alloc();
  let handle = null;
  let image = null;
  try {
    const read = libheif.heif_context_read_from_memory(ctx, readFileSync(path));
    if (read.code !== ok) throw new Error(read.message || 'not a HEIC file');
    handle = libheif.heif_js_context_get_primary_image_handle(ctx);
    if (!handle || handle.code) { const e = handle; handle = null; throw new Error((e && e.message) || 'no image in the file'); }
    const decoded = await libheif.heif_js_decode_image2(handle, libheif.heif_colorspace.heif_colorspace_RGB, libheif.heif_chroma.heif_chroma_interleaved_RGB);
    if (!decoded || decoded.code) throw new Error((decoded && decoded.message) || 'the image could not be decoded');
    image = decoded.image;
    const ch = decoded.channels.find((c) => c.id === libheif.heif_channel.heif_channel_interleaved);
    if (!ch) throw new Error('the image could not be decoded');
    const { width, height, stride } = ch;
    const row = width * 3;
    const data = new Uint8Array(row * height);
    if (stride === row) data.set(ch.data.subarray(0, data.length));
    else for (let y = 0; y < height; y++) data.set(ch.data.subarray(y * stride, y * stride + row), y * row);
    let icc = null;
    try { icc = profile(handle); } catch { /* the photo still imports, as sRGB */ }
    return { data, width, height, icc };
  } finally {
    if (image) libheif.heif_image_release(image);
    if (handle) libheif.heif_image_handle_release(handle);
    libheif.heif_context_free(ctx);
  }
}

parentPort.on('message', ({ id, path }) => {
  decode(path).then(
    (r) => parentPort.postMessage({ id, ...r }, r.icc ? [r.data.buffer, r.icc.buffer] : [r.data.buffer]),
    (e) => parentPort.postMessage({ id, error: String((e && e.message) || e) }),
  );
});
`;

/**
 * As many decoders as the importer reads photos at once. Each holds its photo a few times over:
 * about 150 MB for a 12 MP photo, 550 MB for a 48 MP one.
 */
const MAX_WORKERS = Math.min(4, Math.max(1, availableParallelism() - 1));
const IDLE_MS = 10_000;

interface Job {
  path: string;
  resolve: (d: DecodedHeic) => void;
  reject: (e: Error) => void;
}
interface Slot {
  worker: Worker;
  job: Job | null;
  idle: NodeJS.Timeout | null;
}

const slots: Slot[] = [];
const queue: Job[] = [];
let nextId = 0;

function spawn(): Slot {
  // execArgv: a plain Node worker, whatever loaders (tsx) or flags the server itself was started with.
  const worker = new Worker(WORKER, { eval: true, execArgv: [], workerData: { lib: libheifFile() } });
  worker.unref(); // an idle decoder never keeps the server (or a test run) alive
  const slot: Slot = { worker, job: null, idle: null };
  const fail = (e: Error) => {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    if (slot.idle) clearTimeout(slot.idle);
    slot.job?.reject(e);
    slot.job = null;
    pump();
  };
  worker.on('message', (m: { id: number; error?: string; data: Uint8Array; width: number; height: number; icc: Uint8Array | null }) => {
    const job = slot.job;
    slot.job = null;
    worker.unref();
    if (m.error) job?.reject(new Error(`Could not open this HEIC photo: ${m.error}`));
    else job?.resolve({ data: Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength), width: m.width, height: m.height, icc: m.icc ? Buffer.from(m.icc) : null });
    pump();
  });
  worker.on('error', (e: Error) => fail(new Error(`Could not open this HEIC photo: ${e.message}`)));
  worker.on('exit', () => fail(new Error('Could not open this HEIC photo: the decoder stopped')));
  slots.push(slot);
  return slot;
}

function pump() {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) ?? (slots.length < MAX_WORKERS ? spawn() : null);
    if (!slot) return;
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    slot.job = queue.shift()!;
    slot.worker.ref();
    slot.worker.postMessage({ id: nextId++, path: slot.job.path });
  }
  for (const slot of slots) {
    if (slot.job || slot.idle) continue;
    slot.idle = setTimeout(() => {
      const i = slots.indexOf(slot);
      if (i >= 0) slots.splice(i, 1);
      slot.worker.removeAllListeners('exit');
      void slot.worker.terminate();
    }, IDLE_MS);
    slot.idle.unref();
  }
}

/** Decode a HEIC/HEIF file's main image. The file is only read. */
export function decodeHeic(path: string): Promise<DecodedHeic> {
  return new Promise((resolve, reject) => {
    queue.push({ path, resolve, reject });
    pump();
  });
}

/** A JPEG with `icc` embedded as its colour profile (APP2 "ICC_PROFILE" segments after the SOI). */
export function embedIccProfile(jpeg: Buffer, icc: Buffer): Buffer {
  const MAX = 65519; // 65535 less the length field and the 14-byte header
  const count = Math.ceil(icc.length / MAX);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || count < 1 || count > 255) return jpeg;
  const parts: Buffer[] = [jpeg.subarray(0, 2)];
  for (let i = 0; i < count; i++) {
    const chunk = icc.subarray(i * MAX, (i + 1) * MAX);
    const head = Buffer.alloc(18);
    head.writeUInt16BE(0xffe2, 0);
    head.writeUInt16BE(chunk.length + 16, 2);
    head.write('ICC_PROFILE\0', 4, 'latin1');
    head[16] = i + 1;
    head[17] = count;
    parts.push(head, chunk);
  }
  parts.push(jpeg.subarray(2));
  return Buffer.concat(parts);
}

/** The decoded photo as a sharp image (colour profile not applied: for small previews). */
export async function heicImage(path: string): Promise<Sharp> {
  const { data, width, height } = await decodeHeic(path);
  return sharp(data, { raw: { width, height, channels: 3 } });
}

/**
 * Convert a HEIC photo to the JPEG the rest of the pipeline works from, keeping its colour
 * profile, as `sips -s format jpeg` does on macOS. Written under a temporary name first, so an
 * interrupted conversion never leaves half a file behind.
 */
export async function heicToJpeg(originalPath: string, outPath: string): Promise<void> {
  const { data, width, height, icc } = await decodeHeic(originalPath);
  const jpeg = await sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const tmp = `${outPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, icc ? embedIccProfile(jpeg, icc) : jpeg);
    // The same photo under two names can be converted twice at once: the first one home wins.
    await rename(tmp, outPath).catch((e) => {
      if (!existsSync(outPath)) throw e;
    });
  } finally {
    await rm(tmp, { force: true });
  }
}
