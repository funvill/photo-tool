// Fake tagging models for tests and the e2e gallery server (PHOTOBOOK_GALLERY_FAKE_TAGGING=1): a tiny
// catalogue whose files are served from memory by a fake fetch (with Range, and one redirect hop to a CDN host).
import { createHash } from 'node:crypto';
import type { ModelChoice } from '../../src/core/tagModels';

const bytesOf = (seed: string, n: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
  return b;
};

/** Every fake file's content, by `<repo>/<path>`. */
export const FAKE_FILES = new Map<string, Buffer>();

const fakeModel = (id: string, part: ModelChoice['part'], size: ModelChoice['size'], label: string, fileBytes: number[]): ModelChoice => {
  const repo = `fake/${id}`;
  const files = fileBytes.map((n, i) => {
    const path = i === 0 ? 'config.json' : `onnx/model_${i}.onnx`;
    const content = bytesOf(`${id}:${path}`, n);
    FAKE_FILES.set(`${repo}/${path}`, content);
    return { path, bytes: n, sha256: createHash('sha256').update(content).digest('hex') };
  });
  return {
    id, part, size, label, repo, revision: 'a'.repeat(40), dtype: 'q8', files, licence: 'MIT',
    secondsPerPhoto: size === 'smaller' ? 1 : 3,
    ...(part === 'keywords' ? { keywordThreshold: 0.2, meaningThreshold: 0.5 } : {}),
  };
};

export const FAKE_CATALOGUE: readonly ModelChoice[] = [
  fakeModel('fake-describe-small', 'describe', 'smaller', 'Fake describe small', [300, 200_000]),
  fakeModel('fake-describe-large', 'describe', 'larger', 'Fake describe large', [300, 400_000]),
  fakeModel('fake-keywords-small', 'keywords', 'smaller', 'Fake keywords small', [300, 150_000]),
  fakeModel('fake-keywords-large', 'keywords', 'larger', 'Fake keywords large', [300, 350_000]),
];

export interface FakeFetchOptions {
  /** Answer with this content instead, by `<repo>/<path>`. */
  override?: Map<string, Buffer>;
  /** Redirect resolve URLs here instead of the allowed CDN host. */
  redirectTo?: string;
  /** Delay per chunk, so a test can cancel half-way. */
  chunkDelayMs?: number;
  /** Every request seen: url and Range header. */
  log?: { url: string; range: string | null }[];
}

/** A fetch that serves FAKE_FILES: huggingface.co/<repo>/resolve/<rev>/<path> redirects to cdn-lfs.hf.co. */
export function fakeFetch(o: FakeFetchOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    o.log?.push({ url: url.href, range: headers.get('range') });
    const m = /^\/(.+)\/resolve\/[0-9a-f]{40}\/(.+)$/.exec(url.pathname);
    if (url.hostname === 'huggingface.co' && m) {
      const target = o.redirectTo ?? `https://cdn-lfs.hf.co/${m[1]}/${m[2]}`;
      return new Response(null, { status: 302, headers: { location: target } });
    }
    if (url.hostname !== 'cdn-lfs.hf.co') return new Response('not found', { status: 404 });
    const key = decodeURIComponent(url.pathname.slice(1));
    const content = o.override?.get(key) ?? FAKE_FILES.get(key);
    if (!content) return new Response('not found', { status: 404 });
    const range = /^bytes=(\d+)-$/.exec(headers.get('range') ?? '');
    const start = range ? Number(range[1]) : 0;
    const body = content.subarray(start);
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < body.length; i += 16_384) {
          if (signal?.aborted) {
            controller.error(new DOMException('aborted', 'AbortError'));
            return;
          }
          if (o.chunkDelayMs) await new Promise((r) => setTimeout(r, o.chunkDelayMs));
          controller.enqueue(new Uint8Array(body.subarray(i, i + 16_384)));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: range ? 206 : 200,
      headers: { 'content-length': String(body.length), ...(range ? { 'content-range': `bytes ${start}-${content.length - 1}/${content.length}` } : {}) },
    });
  }) as typeof fetch;
}
