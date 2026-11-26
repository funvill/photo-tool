// The album tags sidecar (phototool-tags.json and its vectors file): the format, and the store that keeps it in the
// album folder (atomic, debounced writes; the read-only fallback; broken files left alone).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlbumTagsStore,
  PHOTOTAGS_FORMAT,
  PHOTOTAGS_NAME,
  PHOTOVECTORS_FORMAT,
  PHOTOVECTORS_NAME,
  PhotoTagsParseError,
  decodeVector,
  encodeVector,
  parsePhotoTags,
  parsePhotoVectors,
  resultsOf,
  serialisePhotoTags,
  vectorsOf,
  type AlbumTagsOptions,
} from '../phototags';

describe('phototags format', () => {
  const sample = {
    format: 'phototool-tags/1',
    photos: {
      'a.jpg': {
        models: {
          'describe-1': { contentKey: 'k1', description: 'A dog.', objects: [{ label: 'dog', count: 1 }], madeAt: '2026-01-01T00:00:00.000Z' },
          'keywords-1': { contentKey: 'k1', keywords: [{ label: 'dog', score: 0.9 }] },
        },
      },
    },
  };

  it('names and versions the files', () => {
    expect(PHOTOTAGS_NAME).toBe('phototool-tags.json');
    expect(PHOTOTAGS_FORMAT).toBe('phototool-tags/1');
    expect(PHOTOVECTORS_NAME).toBe('phototool-tags.vectors.json');
    expect(PHOTOVECTORS_FORMAT).toBe('phototool-vectors/1');
  });

  it('parses and round-trips', () => {
    const file = parsePhotoTags(JSON.stringify(sample));
    expect(parsePhotoTags(serialisePhotoTags(file))).toEqual(sample);
    expect(serialisePhotoTags(file)).toContain('\n  "');
    expect(resultsOf(file)).toEqual([
      { fileName: 'a.jpg', modelId: 'describe-1', contentKey: 'k1', description: 'A dog.', objects: [{ label: 'dog', count: 1 }], madeAt: '2026-01-01T00:00:00.000Z' },
      { fileName: 'a.jpg', modelId: 'keywords-1', contentKey: 'k1', keywords: [{ label: 'dog', score: 0.9 }] },
    ]);
  });

  it('keeps unknown fields at every level', () => {
    const text = JSON.stringify({
      format: 'phototool-tags/1', owner: 'x',
      photos: { 'a.jpg': { pinned: true, models: { m: { contentKey: 'k', description: 'd', mood: 'calm' } } } },
    });
    const file = parsePhotoTags(text);
    expect(JSON.parse(serialisePhotoTags(file))).toEqual(JSON.parse(text));
  });

  it('a missing BOM-prefixed or format-less file still parses', () => {
    expect(parsePhotoTags('﻿{"photos":{}}').format).toBe(PHOTOTAGS_FORMAT);
  });

  it('rejects bad JSON, the wrong shape and a newer format', () => {
    expect(() => parsePhotoTags('{not json')).toThrow(PhotoTagsParseError);
    expect(() => parsePhotoTags('[]')).toThrow(PhotoTagsParseError);
    expect(() => parsePhotoTags('{"photos":[]}')).toThrow(PhotoTagsParseError);
    expect(() => parsePhotoTags('{"format":"phototool-tags/2","photos":{}}')).toThrow(/newer/);
  });

  it('skips (but keeps) entries it does not understand', () => {
    const text = JSON.stringify({ format: 'phototool-tags/1', photos: { 'a.jpg': 'junk', 'b.jpg': { models: { m: { description: 'no key' }, n: { contentKey: 'k', description: 'ok' } } } } });
    const file = parsePhotoTags(text);
    expect(resultsOf(file)).toEqual([{ fileName: 'b.jpg', modelId: 'n', contentKey: 'k', description: 'ok' }]);
    expect(JSON.parse(serialisePhotoTags(file))).toEqual(JSON.parse(text));
  });

  it('encodes a vector compactly and exactly', () => {
    const v = new Float32Array([0.1, -2.5, 3e-8, 1]);
    const text = encodeVector(v);
    expect(text.length).toBeLessThan(v.byteLength * 1.4 + 4);
    expect([...decodeVector(text)!]).toEqual([...v]);
    expect(decodeVector('abc')).toBeNull();
  });

  it('parses the vectors file', () => {
    const file = parsePhotoVectors(JSON.stringify({ format: 'phototool-vectors/1', photos: { 'a.jpg': { models: { kw: { contentKey: 'k', data: encodeVector(new Float32Array([1, 2])) } } } } }));
    const [v] = vectorsOf(file);
    expect(v.fileName).toBe('a.jpg');
    expect(v.modelId).toBe('kw');
    expect(v.contentKey).toBe('k');
    expect([...v.embedding]).toEqual([1, 2]);
  });
});

describe('AlbumTagsStore', () => {
  let dir: string;
  let fallbackDir: string;
  let stores: AlbumTagsStore[];
  const tagsFile = () => join(dir, PHOTOTAGS_NAME);
  const vectorsFile = () => join(dir, PHOTOVECTORS_NAME);
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const make = (o: Partial<AlbumTagsOptions> = {}) => {
    const s = new AlbumTagsStore({ fallbackDir, debounceMs: 50, maxWaitMs: 200, onError: () => {}, ...o });
    stores.push(s);
    return s;
  };
  const describeResult = { contentKey: 'k1', description: 'A dog.', objects: [{ label: 'dog', count: 1 }] };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phototags-'));
    fallbackDir = mkdtempSync(join(tmpdir(), 'phototags-fb-'));
    stores = [];
  });
  afterEach(() => {
    for (const s of stores) s.close();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  });

  it('writes a result to the album folder, with its vector beside it', () => {
    const store = make();
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    store.put(dir, 'a.jpg', 'keywords-1', { contentKey: 'k1', keywords: [{ label: 'dog', score: 0.9 }], embedding: new Float32Array([0.5, 0.25]) });
    store.flush();
    const tags = json(tagsFile());
    expect(tags.format).toBe('phototool-tags/1');
    expect(tags.photos['a.jpg'].models['describe-1']).toMatchObject(describeResult);
    expect(typeof tags.photos['a.jpg'].models['describe-1'].madeAt).toBe('string');
    // The embedding is not in the readable file, only in the vectors file.
    expect(tags.photos['a.jpg'].models['keywords-1'].embedding).toBeUndefined();
    const vectors = json(vectorsFile());
    expect(vectors.format).toBe('phototool-vectors/1');
    expect(vectors.photos['a.jpg'].models['keywords-1'].contentKey).toBe('k1');
    const view = make().read(dir);
    expect(view.source).toBe('folder');
    const kw = view.results.find((r) => r.modelId === 'keywords-1')!;
    expect([...kw.embedding!]).toEqual([0.5, 0.25]);
  });

  it('a describe-only pass makes no vectors file', () => {
    const store = make();
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    store.flush();
    expect(existsSync(vectorsFile())).toBe(false);
  });

  it('debounces: many results in a burst are one write', async () => {
    const writes: string[] = [];
    const store = make({ writeFile: (target, text) => { writes.push(target); writeFileSync(target, text); } });
    for (let i = 0; i < 100; i++) store.put(dir, `p${i}.jpg`, 'describe-1', { ...describeResult, contentKey: `k${i}` });
    expect(writes).toEqual([]);
    // Pending results are seen by a read before they are written.
    expect(store.read(dir).results).toHaveLength(100);
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(writes).toEqual([tagsFile()]);
    expect(Object.keys(json(tagsFile()).photos)).toHaveLength(100);
  });

  it('a steady stream is still written at least every maxWait', async () => {
    vi.useFakeTimers();
    let writes = 0;
    const store = make({ debounceMs: 50, maxWaitMs: 200, writeFile: (t, text) => { writes++; writeFileSync(t, text); } });
    for (let i = 0; i < 20; i++) {
      store.put(dir, `p${i}.jpg`, 'describe-1', { ...describeResult, contentKey: `k${i}` });
      vi.advanceTimersByTime(40);
    }
    // 800 ms of results 40 ms apart: never quiet for 50 ms, yet written about every 200 ms.
    expect(writes).toBeGreaterThanOrEqual(3);
    expect(writes).toBeLessThanOrEqual(5);
  });

  it('writes atomically: a temp file renamed over the old one, nothing left behind', () => {
    writeFileSync(tagsFile(), JSON.stringify({ format: 'phototool-tags/1', photos: {} }));
    const renames: [string, string][] = [];
    const store = make({ rename: (from, to) => { renames.push([from, to]); renameSync(from, to); } });
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    store.flush();
    expect(renames).toHaveLength(1);
    expect(renames[0][1]).toBe(tagsFile());
    expect(renames[0][0]).not.toBe(tagsFile());
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps other entries, unknown fields and the result fields it does not know', () => {
    writeFileSync(tagsFile(), JSON.stringify({
      format: 'phototool-tags/1', owner: 'x',
      photos: { 'b.jpg': { pinned: true, models: { m: { contentKey: 'kb', description: 'B' } } }, 'a.jpg': { models: { 'describe-1': { contentKey: 'k1', description: 'old', mood: 'calm' } } } },
    }));
    const store = make();
    store.put(dir, 'A.JPG', 'describe-1', describeResult);
    store.flush();
    const tags = json(tagsFile());
    expect(tags.owner).toBe('x');
    expect(tags.photos['b.jpg']).toEqual({ pinned: true, models: { m: { contentKey: 'kb', description: 'B' } } });
    // Case-insensitive: the existing key is reused.
    expect(Object.keys(tags.photos).sort()).toEqual(['a.jpg', 'b.jpg']);
    expect(tags.photos['a.jpg'].models['describe-1']).toMatchObject({ ...describeResult, mood: 'calm' });
  });

  it('a result for another picture replaces the old one whole', () => {
    writeFileSync(tagsFile(), JSON.stringify({ format: 'phototool-tags/1', photos: { 'a.jpg': { models: { 'describe-1': { contentKey: 'old', description: 'old', mood: 'calm' } } } } }));
    const store = make();
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    store.flush();
    expect(json(tagsFile()).photos['a.jpg'].models['describe-1'].mood).toBeUndefined();
  });

  it('merges with a change another program made since it was read', () => {
    const store = make();
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    store.flush();
    const other = json(tagsFile());
    other.photos['z.jpg'] = { models: { m: { contentKey: 'kz', description: 'Z' } } };
    writeFileSync(tagsFile(), JSON.stringify(other));
    store.put(dir, 'b.jpg', 'describe-1', { ...describeResult, contentKey: 'k2' });
    store.flush();
    expect(Object.keys(json(tagsFile()).photos).sort()).toEqual(['a.jpg', 'b.jpg', 'z.jpg']);
  });

  it('a broken file is never overwritten, and the result waits for the next flush', () => {
    writeFileSync(tagsFile(), '{not json');
    const errors: string[] = [];
    const store = make({ onError: (_f, m) => errors.push(m) });
    const view = store.read(dir);
    expect(view.results).toEqual([]);
    expect(view.error).toBeTruthy();
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    expect(() => store.flush()).not.toThrow();
    expect(readFileSync(tagsFile(), 'utf8')).toBe('{not json');
    expect(errors.join()).toMatch(/phototool-tags\.json/);
    // Fixed by hand: the result kept in memory goes out next time.
    rmSync(tagsFile());
    store.flush();
    expect(json(tagsFile()).photos['a.jpg'].models['describe-1'].description).toBe('A dog.');
  });

  it('a read-only folder falls back to the shared fallback folder, and back again once writable', () => {
    let readOnly = true;
    const writeFile = (target: string, text: string) => {
      if (readOnly && target.startsWith(dir)) throw Object.assign(new Error('read-only'), { code: 'EACCES' });
      writeFileSync(target, text);
    };
    const store = make({ writeFile });
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    store.flush();
    expect(existsSync(tagsFile())).toBe(false);
    const fb = join(fallbackDir, 'phototool-tags');
    const files = readdirSync(fb);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{40}\.json$/);
    expect(json(join(fb, files[0])).folder).toBeTruthy();
    // Read back from the fallback, by a new store too.
    const view = make({ writeFile }).read(dir);
    expect(view.source).toBe('fallback');
    expect(view.results[0].description).toBe('A dog.');
    // Writable again: the next write goes to the folder, with everything, and the fallback is removed.
    readOnly = false;
    store.put(dir, 'b.jpg', 'describe-1', { ...describeResult, contentKey: 'k2' });
    store.flush();
    expect(Object.keys(json(tagsFile()).photos).sort()).toEqual(['a.jpg', 'b.jpg']);
    expect(readdirSync(fb)).toEqual([]);
  });

  it('never writes the photoinfo fallback files', () => {
    mkdirSync(fallbackDir, { recursive: true });
    const store = make({ writeFile: (t, text) => { if (t.startsWith(dir)) throw Object.assign(new Error('ro'), { code: 'EPERM' }); writeFileSync(t, text); } });
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    store.flush();
    expect(readdirSync(fallbackDir)).toEqual(['phototool-tags']);
  });

  it('a folder that is gone is dropped quietly: never created, nothing thrown, no fallback', async () => {
    const errors: string[] = [];
    const store = make({ onError: (_f, m) => errors.push(m) });
    const gone = join(dir, 'gone');
    store.put(gone, 'a.jpg', 'describe-1', describeResult);
    store.flush();
    expect(existsSync(gone)).toBe(false);
    expect(readdirSync(fallbackDir)).toEqual([]);
    expect(errors).toEqual([]);
    // And from a timer too.
    store.put(gone, 'b.jpg', 'describe-1', describeResult);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(gone)).toBe(false);
  });

  it('close() writes what is pending', () => {
    const store = make({ debounceMs: 60_000, maxWaitMs: 60_000 });
    store.put(dir, 'a.jpg', 'describe-1', describeResult);
    expect(existsSync(tagsFile())).toBe(false);
    store.close();
    expect(json(tagsFile()).photos['a.jpg']).toBeTruthy();
  });

  it('read sees a change made on disk by someone else', () => {
    const store = make();
    expect(store.read(dir).source).toBe('none');
    writeFileSync(tagsFile(), JSON.stringify({ format: 'phototool-tags/1', photos: { 'a.jpg': { models: { m: { contentKey: 'k', description: 'one' } } } } }));
    expect(store.read(dir).results[0].description).toBe('one');
    writeFileSync(tagsFile(), JSON.stringify({ format: 'phototool-tags/1', photos: { 'a.jpg': { models: { m: { contentKey: 'k', description: 'two, longer' } } } } }));
    expect(store.read(dir).results[0].description).toBe('two, longer');
  });

  it('a vector whose content key does not match its result is not given to it', () => {
    writeFileSync(tagsFile(), JSON.stringify({ format: 'phototool-tags/1', photos: { 'a.jpg': { models: { kw: { contentKey: 'new', keywords: [] } } } } }));
    writeFileSync(vectorsFile(), JSON.stringify({ format: 'phototool-vectors/1', photos: { 'a.jpg': { models: { kw: { contentKey: 'old', data: encodeVector(new Float32Array([1])) } } } } }));
    expect(make().read(dir).results[0].embedding).toBeUndefined();
  });
});

describe('phototags format: hand edits gone wrong', () => {
  it('reads past known fields of the wrong shape', () => {
    const file = parsePhotoTags(JSON.stringify({ photos: { 'a.jpg': { models: { m: { contentKey: 'k', description: 3, objects: 'x', keywords: [{ label: 'ok', score: 1 }, { label: 2 }] } } } } }));
    expect(resultsOf(file)).toEqual([{ fileName: 'a.jpg', modelId: 'm', contentKey: 'k', objects: [], keywords: [{ label: 'ok', score: 1 }] }]);
  });
});
