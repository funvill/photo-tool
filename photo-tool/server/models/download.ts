// Downloads one tagging model's files from Hugging Face, the only network use besides map tiles. Only the
// catalogue's files, only from huggingface.co and the hosts it redirects to, checked against the catalogue's
// SHA-256 before a file is put in place. A broken download resumes from its `.part` file.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { ModelChoice, ModelFile } from '../../core/tagModels';
import { modelDir } from './store';

const MAX_REDIRECTS = 5;

/** https on the default port, no user info, host huggingface.co or under .huggingface.co / .hf.co. */
export const isAllowedModelUrl = (url: string): boolean => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return h === 'huggingface.co' || h.endsWith('.huggingface.co') || h.endsWith('.hf.co');
};

export interface DownloadProgress {
  id: string;
  received: number;
  total: number;
}

export interface DownloadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?(p: DownloadProgress): void;
}

export class ModelDownloadError extends Error {}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const sha256Of = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

/** Follows redirects by hand so every hop is checked. */
async function get(doFetch: typeof fetch, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedModelUrl(url)) throw new ModelDownloadError(`Download host not allowed: ${new URL(url).host}`);
    const res = await doFetch(url, { headers, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new ModelDownloadError('Hugging Face sent a redirect without a location.');
      url = new URL(next, url).href;
      continue;
    }
    return res;
  }
  throw new ModelDownloadError('Too many redirects from Hugging Face.');
}

async function downloadFile(doFetch: typeof fetch, m: ModelChoice, f: ModelFile, dir: string, signal: AbortSignal | undefined, onBytes: (n: number) => void) {
  const target = join(dir, f.path);
  const part = `${target}.part`;
  mkdirSync(dirname(target), { recursive: true });
  let have = sizeOf(part);
  if (have > f.bytes) {
    rmSync(part, { force: true });
    have = 0;
  }
  onBytes(have);
  if (have < f.bytes) {
    const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.path}`;
    const res = await get(doFetch, url, have > 0 ? { range: `bytes=${have}-` } : {}, signal);
    if (have > 0 && res.status === 200) {
      // The server ignored the Range: start the file again.
      rmSync(part, { force: true });
      onBytes(-have);
      have = 0;
    } else if (!res.ok || !res.body) {
      throw new ModelDownloadError(`Hugging Face answered ${res.status} for ${f.path}.`);
    }
    // A write that fails (a full disk, a lock) must end the download with a message, never crash the server:
    // the stream's error is caught here and turned into a ModelDownloadError. The .part is kept for a retry.
    const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    let writeError: Error | null = null;
    out.on('error', (e) => (writeError ??= e));
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (signal?.aborted) throw new ModelDownloadError('Download cancelled.');
        if (writeError) break;
        if (!out.write(chunk)) await once(out, 'drain').catch((e: Error) => (writeError ??= e));
        onBytes(chunk.length);
      }
    } finally {
      out.end();
      await finished(out).catch((e: Error) => (writeError ??= e));
    }
    if (writeError) throw writeFailed(f.path, writeError);
  }
  if (sizeOf(part) !== f.bytes || (await sha256Of(part)) !== f.sha256) {
    rmSync(part, { force: true });
    throw new ModelDownloadError(`${f.path} did not pass its check (wrong size or SHA-256); it was deleted. Try again.`);
  }
  renameSync(part, target);
}

/**
 * Checks every file of an installed model against its SHA-256 and deletes the ones that do not match (damaged in
 * place, same size), so the model shows as incomplete and Download again fetches them. Returns the deleted paths.
 */
export async function verifyModel(dataDir: string, m: ModelChoice): Promise<string[]> {
  const dir = modelDir(dataDir, m.id);
  const bad: string[] = [];
  for (const f of m.files) {
    const path = join(dir, f.path);
    if (!existsSync(path)) continue;
    if (sizeOf(path) !== f.bytes || (await sha256Of(path).catch(() => '')) !== f.sha256) {
      rmSync(path, { force: true });
      bad.push(f.path);
    }
  }
  return bad;
}

const writeFailed = (path: string, e: NodeJS.ErrnoException): ModelDownloadError =>
  new ModelDownloadError(e.code === 'ENOSPC' ? `Not enough disk space for ${path}. Free some space and download again.` : `Couldn't write ${path}: ${e.message}`);

/** Downloads every file of `m` not yet in place into `<dataDir>/models/<id>/`. */
export async function downloadModel(dataDir: string, m: ModelChoice, opts: DownloadOptions = {}): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const dir = modelDir(dataDir, m.id);
  const total = m.files.reduce((s, f) => s + f.bytes, 0);
  let received = 0;
  const report = () => opts.onProgress?.({ id: m.id, received, total });
  for (const f of m.files) {
    if (opts.signal?.aborted) throw new ModelDownloadError('Download cancelled.');
    const target = join(dir, f.path);
    if (existsSync(target) && sizeOf(target) === f.bytes) {
      received += f.bytes;
      report();
      continue;
    }
    rmSync(target, { force: true });
    await downloadFile(doFetch, m, f, dir, opts.signal, (n) => {
      received += n;
      report();
    });
  }
}
