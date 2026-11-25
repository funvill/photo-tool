// What runs the tagging models: a worker thread with Transformers.js. The real-model checks run only when
// PHOTOBOOK_TAGGING_MODELS_DIR points at a folder holding the models as downloaded by Hugging Face
// (<dir>/<repo>/...), e.g. the cache of scripts/tagging/measure.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findModel } from '../core/tagModels';
import { BackendLostError, ModelLoadError, workerBackend } from '../server/tagging/backend';
import { taggingWorkerSource } from '../server/tagging/workerSource';
import { VOCABULARY } from '../server/tagging/vocabulary';

const TRIP = join(process.cwd(), 'fixtures', 'generated', 'trip');
const MODELS = process.env.PHOTOBOOK_TAGGING_MODELS_DIR;

describe('tagging vocabulary', () => {
  it('VOCABULARY is lower case, unique, at least 500 entries', () => {
    expect(VOCABULARY.length).toBeGreaterThanOrEqual(500);
    expect(new Set(VOCABULARY).size).toBe(VOCABULARY.length);
    for (const w of VOCABULARY) expect(w).toMatch(/^[a-z][a-z' -]*[a-z]$/);
  });
});

describe('worker backend', () => {
  it('workerBackend.load throws ModelLoadError for a folder with a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagger-'));
    try {
      const m = findModel('clip-base-q8')!;
      mkdirSync(join(dir, 'onnx'));
      writeFileSync(join(dir, 'config.json'), '{}');
      const backend = workerBackend(1, taggingWorkerSource());
      await expect(backend.load('keywords', m, dir)).rejects.toBeInstanceOf(ModelLoadError);
      await backend.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a call before load is refused, not hung', async () => {
    const backend = workerBackend(1, taggingWorkerSource());
    const call = backend.keywords(join(TRIP, 'day2-04-lake.jpg'));
    await expect(call).rejects.toThrow(/not loaded/i);
    // Says the model is gone (load it again), not that the photo is bad.
    await expect(call).rejects.toBeInstanceOf(BackendLostError);
    await backend.close();
  });

  it('a caption (Regenerate) before load is refused as a lost descriptions model, not hung', async () => {
    const backend = workerBackend(1, taggingWorkerSource());
    const call = backend.caption(join(TRIP, 'day2-04-lake.jpg'));
    await expect(call).rejects.toThrow(/descriptions model is not loaded/i);
    await expect(call).rejects.toBeInstanceOf(BackendLostError);
    await backend.close();
  });
});

describe.skipIf(!MODELS)('real models', () => {
  const backend = workerBackend(4, taggingWorkerSource());
  afterAll(() => backend.close());

  it('real models (skipped unless PHOTOBOOK_TAGGING_MODELS_DIR is set): describe gives a sentence and objects for a fixture; keywords gives at most 12 labels and a unit-length embedding; embedText of a matching word scores higher than an unrelated one', async () => {
    const florence = findModel('florence2-base-q8')!;
    const clip = findModel('clip-base-q8')!;
    await backend.load('describe', florence, join(MODELS!, florence.repo));
    await backend.load('keywords', clip, join(MODELS!, clip.repo));
    const lake = join(TRIP, 'day2-04-lake.jpg');
    const d = await backend.describe(lake);
    expect(d.description.length).toBeGreaterThan(20);
    expect(d.description).not.toMatch(/<|>/);
    expect(Array.isArray(d.objects)).toBe(true);
    // Regenerate samples: a few tries give at least one other wording, and never the tags.
    const captions = [await backend.caption(lake), await backend.caption(lake), await backend.caption(lake)];
    for (const c of captions) {
      expect(c.length).toBeGreaterThan(10);
      expect(c).not.toMatch(/<|>/);
    }
    expect(new Set([d.description, ...captions]).size).toBeGreaterThan(1);
    const k = await backend.keywords(lake);
    expect(k.keywords.length).toBeGreaterThan(0);
    expect(k.keywords.length).toBeLessThanOrEqual(12);
    expect(k.keywords.map((w) => w.label)).toContain('lake');
    expect(Math.hypot(...k.embedding)).toBeCloseTo(1, 4);
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
    const near = await backend.embedText('a lake in the mountains');
    const far = await backend.embedText('a plate of spaghetti');
    expect(Math.hypot(...near)).toBeCloseTo(1, 4);
    expect(dot(k.embedding, near)).toBeGreaterThan(dot(k.embedding, far));
  }, 300_000);

  it('real models: a search (embedText) is answered while a photo is being described, not after it', async () => {
    const florence = findModel('florence2-base-q8')!;
    const clip = findModel('clip-base-q8')!;
    await backend.load('describe', florence, join(MODELS!, florence.repo));
    await backend.load('keywords', clip, join(MODELS!, clip.repo));
    const order: string[] = [];
    const describing = backend.describe(join(TRIP, 'day1-05-harbour-pano.jpg')).then(() => order.push('describe'));
    // Let the description start first.
    await new Promise((r) => setTimeout(r, 300));
    const searching = backend.embedText('boats in a harbour').then(() => order.push('embedText'));
    await Promise.all([describing, searching]);
    expect(order).toEqual(['embedText', 'describe']);
  }, 300_000);
});
