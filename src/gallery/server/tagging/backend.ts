// What runs the tagging models. The real one (workerBackend) runs Transformers.js in a worker thread
// (./worker.ts), so the server stays responsive; tests use a fake.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ModelChoice, TagPart } from '../../../core/tagModels';
import { VOCABULARY } from './vocabulary';
import type { WorkerReply, WorkerRequest } from './worker';

export interface DescribeResult {
  description: string;
  objects: { label: string; count: number }[];
}

export interface KeywordResult {
  keywords: { label: string; score: number }[];
  /** Unit length, in the same space as embedText's. */
  embedding: Float32Array;
}

export interface TaggerBackend {
  /** Throws ModelLoadError when the model's folder is incomplete or will not load. */
  load(part: TagPart, model: ModelChoice, dir: string): Promise<void>;
  describe(imagePath: string): Promise<DescribeResult>;
  keywords(imagePath: string): Promise<KeywordResult>;
  embedText(text: string): Promise<Float32Array>;
  close(): Promise<void>;
}

export class ModelLoadError extends Error {}

/** The worker's source file, for running from source (development, tests). The desktop app runs its built copy. */
export const taggingWorkerSource = (): string => fileURLToPath(new URL('./worker.ts', import.meta.url));

const fileSize = (path: string): number | null => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};

/** A worker request without its id (one of the union's members). */
type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

type Pending = { resolve(v: unknown): void; reject(e: Error): void; load: boolean };

/**
 * Runs the models in a worker thread with `threads` threads, from `workerFile` (worker.ts from source, or its
 * built .cjs). The worker starts on the first call and is stopped by close().
 */
export function workerBackend(threads: number, workerFile: string): TaggerBackend {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(p.load ? new ModelLoadError(e.message) : e);
    pending.clear();
    worker = null;
  };
  const start = (): Worker => {
    if (worker) return worker;
    const w = new Worker(workerFile);
    w.unref();
    w.on('message', (r: WorkerReply) => {
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.resolve(r.result);
      else p.reject(r.load ? new ModelLoadError(r.error) : new Error(r.error));
    });
    w.on('error', (e) => failAll(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', (code) => {
      if (worker === w) failAll(new Error(`The tagging worker stopped (code ${code}).`));
    });
    return (worker = w);
  };
  const call = <T>(req: Request): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, load: req.op === 'load' });
      start().postMessage({ ...req, id });
    });

  return {
    async load(part, model, dir) {
      const missing = model.files.filter((f) => fileSize(join(dir, f.path)) !== f.bytes);
      if (missing.length) throw new ModelLoadError(`${model.label} is incomplete (${missing.map((f) => f.path).join(', ')}). Download it again.`);
      await call({ op: 'load', part, dir, dtype: model.dtype, threads, keywordThreshold: model.keywordThreshold ?? 0, vocabulary: [...VOCABULARY] });
    },
    describe: (path) => call<DescribeResult>({ op: 'describe', path }),
    keywords: (path) => call<KeywordResult>({ op: 'keywords', path }),
    embedText: (text) => call<Float32Array>({ op: 'embedText', text }),
    async close() {
      const w = worker;
      worker = null;
      for (const p of pending.values()) p.reject(new Error('Tagging stopped.'));
      pending.clear();
      await w?.terminate();
    },
  };
}
