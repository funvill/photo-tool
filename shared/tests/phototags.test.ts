// The album tags sidecar (phototool-tags.json and its vectors file): the format, and the store that keeps it in the
// album folder (atomic, debounced writes; the read-only fallback; broken files left alone).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
    // Regenerate replaces the folder's result for the same picture (a tagging result would keep it).
    store.put(dir, 'A.JPG', 'describe-1', describeResult, 'replace');
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

describe('AlbumTagsStore: fix round 1', () => {
  let dir: string;
  let fallbackDir: string;
  let stores: AlbumTagsStore[];
  const tagsFile = () => join(dir, PHOTOTAGS_NAME);
  const vectorsFile = () => join(dir, PHOTOVECTORS_NAME);
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const make = (o: Partial<AlbumTagsOptions> = {}) => {
    const s = new AlbumTagsStore({ fallbackDir, onError: () => {}, ...o });
    stores.push(s);
    return s;
  };
  const r = (contentKey: string, description = `About ${contentKey}.`) => ({ contentKey, description, objects: [] });
  const seed = (photos: Record<string, Record<string, Record<string, unknown>>>, path = tagsFile()) =>
    writeFileSync(path, JSON.stringify({ format: 'phototool-tags/1', photos: Object.fromEntries(Object.entries(photos).map(([n, models]) => [n, { models }])) }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phototags-r1-'));
    fallbackDir = mkdtempSync(join(tmpdir(), 'phototags-r1-fb-'));
    stores = [];
  });
  afterEach(() => {
    for (const s of stores) s.close();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  });

  describe('write cadence at real model speeds', () => {
    it('a photo every 10 s for 20 minutes is written about every 5 minutes, not after every photo', () => {
      vi.useFakeTimers();
      let writes = 0;
      const store = make({ writeFile: (t, text) => { writes++; writeFileSync(t, text); } });
      for (let i = 0; i < 120; i++) {
        store.put(dir, `p${i}.jpg`, 'describe-1', r(`k${i}`));
        vi.advanceTimersByTime(10_000);
      }
      expect(writes).toBeGreaterThanOrEqual(3);
      expect(writes).toBeLessThanOrEqual(5);
    });

    it('once results stop coming, they are written a minute later', () => {
      vi.useFakeTimers();
      const store = make();
      store.put(dir, 'a.jpg', 'describe-1', r('k1'));
      vi.advanceTimersByTime(59_000);
      expect(existsSync(tagsFile())).toBe(false);
      vi.advanceTimersByTime(2_000);
      expect(existsSync(tagsFile())).toBe(true);
    });
  });

  describe('a failed write backs off', () => {
    const busy = () => {
      let attempts = 0;
      let isBusy = true;
      const rename = (from: string, to: string) => {
        attempts++;
        if (isBusy) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        renameSync(from, to);
      };
      return { rename, attempts: () => attempts, free: () => (isBusy = false) };
    };

    it('later results do not retry at once; the tail is retried on its own, with a growing wait', () => {
      vi.useFakeTimers();
      const b = busy();
      const store = make({ rename: b.rename });
      store.put(dir, 'a.jpg', 'describe-1', r('k1'));
      store.flush();
      const first = b.attempts();
      expect(first).toBeGreaterThan(0);
      for (let i = 0; i < 20; i++) {
        store.put(dir, `p${i}.jpg`, 'describe-1', r(`k${i}`));
        vi.advanceTimersByTime(1_000);
      }
      store.flush(); // a pass ended: still waiting out the backoff
      expect(b.attempts()).toBe(first);
      vi.advanceTimersByTime(10_000);
      const second = b.attempts();
      expect(second).toBeGreaterThan(first);
      // Doubled: nothing 30 s later, again after 60 s.
      vi.advanceTimersByTime(30_000);
      expect(b.attempts()).toBe(second);
      b.free();
      vi.advanceTimersByTime(31_000);
      expect(Object.keys(json(tagsFile()).photos)).toHaveLength(21);
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });

    it('close() still tries, whatever the backoff', () => {
      const b = busy();
      const store = make({ rename: b.rename });
      store.put(dir, 'a.jpg', 'describe-1', r('k1'));
      store.flush();
      b.free();
      store.close();
      expect(json(tagsFile()).photos['a.jpg']).toBeTruthy();
    });

    it('a broken vectors file does not make the tags file be rewritten for every result', () => {
      writeFileSync(vectorsFile(), '{broken');
      let tagWrites = 0;
      const store = make({ writeFile: (t, text) => { if (t === tagsFile()) tagWrites++; writeFileSync(t, text); } });
      for (let i = 0; i < 5; i++) {
        store.put(dir, `p${i}.jpg`, 'keywords-1', { contentKey: `k${i}`, keywords: [{ label: 'x', score: 1 }], embedding: new Float32Array([1]) });
        store.flush();
      }
      expect(tagWrites).toBe(5); // one per flush with something new in it
      expect(Object.keys(json(tagsFile()).photos)).toHaveLength(5);
      expect(readFileSync(vectorsFile(), 'utf8')).toBe('{broken');
      // Fixed: the vectors waiting go out, and the tags file is not written again.
      rmSync(vectorsFile());
      store.flush();
      expect(Object.keys(json(vectorsFile()).photos)).toHaveLength(5);
      expect(tagWrites).toBe(5);
    });

    it('a broken tags file is not read again until it changes', () => {
      writeFileSync(tagsFile(), '{broken');
      let reads = 0;
      const store = make({ readFile: (p) => { if (p === tagsFile()) reads++; return readFileSync(p, 'utf8'); } });
      store.put(dir, 'a.jpg', 'describe-1', r('k1'));
      store.flush();
      const after = reads;
      for (let i = 0; i < 5; i++) {
        store.put(dir, `p${i}.jpg`, 'describe-1', r(`k${i}`));
        store.flush();
      }
      expect(reads).toBe(after);
    });
  });

  describe('a folder that becomes writable again', () => {
    it('merges entry by entry: what another device wrote to the folder meanwhile is kept, a newer fallback entry wins', () => {
      const ro = { on: true };
      const writeFile = (target: string, text: string) => {
        if (ro.on && target.startsWith(dir)) throw Object.assign(new Error('read-only'), { code: 'EACCES' });
        writeFileSync(target, text);
      };
      seed({ 'old.jpg': { m: { contentKey: 'ko', description: 'Before.', madeAt: '2026-01-01T00:00:00.000Z' } } });
      const store = make({ writeFile });
      store.put(dir, 'mine.jpg', 'm', { ...r('km'), madeAt: '2026-02-01T00:00:00.000Z' });
      store.put(dir, 'old.jpg', 'm', { ...r('ko', 'Regenerated here.'), madeAt: '2026-03-01T00:00:00.000Z' }, 'replace');
      store.flush();
      expect(readdirSync(join(fallbackDir, 'phototool-tags'))).toHaveLength(1);
      // Meanwhile another device adds a photo and changes one, in the folder's own file.
      seed({
        'old.jpg': { m: { contentKey: 'ko', description: 'Before.', madeAt: '2026-01-01T00:00:00.000Z' } },
        'theirs.jpg': { m: { contentKey: 'kt', description: 'Theirs.', madeAt: '2026-02-15T00:00:00.000Z' } },
        'mine.jpg': { m: { contentKey: 'km', description: 'Their newer take.', madeAt: '2026-04-01T00:00:00.000Z' } },
      });
      // Reads see both while the fallback is there.
      const seen = Object.fromEntries(store.read(dir).results.map((x) => [x.fileName, x.description]));
      expect(seen).toEqual({ 'old.jpg': 'Regenerated here.', 'theirs.jpg': 'Theirs.', 'mine.jpg': 'Their newer take.' });
      ro.on = false;
      store.put(dir, 'new.jpg', 'm', r('kn'));
      store.flush();
      const file = json(tagsFile());
      const descriptions = Object.fromEntries(Object.entries(file.photos).map(([n, e]) => [n, (e as { models: { m: { description: string } } }).models.m.description]));
      expect(descriptions).toEqual({
        'old.jpg': 'Regenerated here.', // the fallback's is newer
        'theirs.jpg': 'Theirs.', // only in the folder
        'mine.jpg': 'Their newer take.', // the folder's is newer
        'new.jpg': 'About kn.',
      });
      // No local path in the synced file, and the fallback copy is gone.
      expect(file.folder).toBeUndefined();
      expect(readdirSync(join(fallbackDir, 'phototool-tags'))).toEqual([]);
    });
  });

  describe('a read error is not a missing file', () => {
    it('is not cached: the folder is read again later', () => {
      seed({ 'a.jpg': { m: { contentKey: 'k', description: 'Here.' } } });
      let fail = true;
      const store = make({ unreadableRetryMs: 0, readFile: (p) => { if (fail && p === tagsFile()) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return readFileSync(p, 'utf8'); } });
      const view = store.lookup(dir);
      expect(view.status).toBe('unreadable');
      expect(view.find('m', { fileName: 'a.jpg', contentKey: 'k' })).toBeUndefined();
      fail = false;
      expect(store.lookup(dir).find('m', { fileName: 'a.jpg', contentKey: 'k' })?.description).toBe('Here.');
    });

    it('a file that could not be read is never written over', () => {
      seed({ 'a.jpg': { m: { contentKey: 'k', description: 'Here.' } } });
      const before = readFileSync(tagsFile(), 'utf8');
      let writes = 0;
      const store = make({
        readFile: (p) => { if (p === tagsFile()) throw Object.assign(new Error('offline'), { code: 'EIO' }); return readFileSync(p, 'utf8'); },
        writeFile: (t, text) => { writes++; writeFileSync(t, text); },
      });
      store.put(dir, 'b.jpg', 'm', r('kb'));
      store.flush();
      expect(writes).toBe(0);
      expect(readFileSync(tagsFile(), 'utf8')).toBe(before);
      expect(store.hasPending(dir)).toBe(true);
    });
  });

  describe('new tagging output never replaces the folder entry for the same picture', () => {
    it('keeps a regenerated (or any) folder entry for the same picture; Regenerate replaces it', () => {
      seed({ 'a.jpg': { m: { contentKey: 'k', description: 'Regenerated elsewhere.', madeAt: '2026-01-01T00:00:00.000Z', mood: 'calm' } } });
      const store = make();
      store.put(dir, 'a.jpg', 'm', r('k', 'Fresh model output.'));
      store.flush();
      expect(json(tagsFile()).photos['a.jpg'].models.m.description).toBe('Regenerated elsewhere.');
      store.put(dir, 'a.jpg', 'm', r('k', 'Regenerated here.'), 'replace');
      store.flush();
      expect(json(tagsFile()).photos['a.jpg'].models.m).toMatchObject({ description: 'Regenerated here.', mood: 'calm' });
    });

    it('the same picture by file key (another computer content key) counts too; its file key is added when missing', () => {
      seed({ 'a.jpg': { m: { contentKey: 'their-key', fileKey: 'fk1:abc', description: 'Theirs.' } }, 'b.jpg': { m: { contentKey: 'kb', description: 'Old format.' } } });
      const store = make();
      store.put(dir, 'a.jpg', 'm', { ...r('my-key', 'Mine.'), fileKey: 'fk1:abc' });
      store.put(dir, 'b.jpg', 'm', { ...r('kb', 'Mine.'), fileKey: 'fk1:bbb' });
      store.flush();
      const photos = json(tagsFile()).photos;
      expect(photos['a.jpg'].models.m).toMatchObject({ contentKey: 'their-key', description: 'Theirs.' });
      expect(photos['b.jpg'].models.m).toMatchObject({ contentKey: 'kb', description: 'Old format.', fileKey: 'fk1:bbb' });
    });

    it('a result for another picture (the photo was replaced) still replaces the old one', () => {
      seed({ 'a.jpg': { m: { contentKey: 'old', fileKey: 'fk1:old', description: 'Old picture.' } } });
      const store = make();
      store.put(dir, 'a.jpg', 'm', { ...r('new', 'New picture.'), fileKey: 'fk1:new' });
      store.flush();
      expect(json(tagsFile()).photos['a.jpg'].models.m.description).toBe('New picture.');
    });
  });

  describe('finding a photo result', () => {
    it('by its name and content key, by content key under another name, or by file key', () => {
      seed({
        'a.jpg': { m: { contentKey: 'ka', description: 'A.' } },
        'old-name.jpg': { m: { contentKey: 'kr', description: 'Renamed.' } },
        'c.jpg': { m: { contentKey: 'other-computer', fileKey: 'fk1:c', description: 'C.' } },
      });
      const view = make().lookup(dir);
      expect(view.status).toBe('ok');
      expect(view.find('m', { fileName: 'A.JPG', contentKey: 'ka' })?.description).toBe('A.');
      expect(view.find('m', { fileName: 'new-name.jpg', contentKey: 'kr' })?.fileName).toBe('old-name.jpg');
      let asked = 0;
      expect(view.find('m', { fileName: 'c.jpg', contentKey: 'mine', fileKey: () => (asked++, 'fk1:c') })?.description).toBe('C.');
      expect(view.find('m', { fileName: 'a.jpg', contentKey: 'ka', fileKey: () => (asked++, 'x') })).toBeTruthy();
      expect(asked).toBe(1); // only worked out when the content key did not match
      expect(view.find('m', { fileName: 'c.jpg', contentKey: 'mine', fileKey: () => 'fk1:different' })).toBeUndefined();
    });

    it('builds its index once per change of the file, however many photos are looked up', () => {
      const photos: Record<string, Record<string, Record<string, unknown>>> = {};
      for (let i = 0; i < 3000; i++) photos[`p${i}.jpg`] = { m: { contentKey: `k${i}`, description: `P${i}.` } };
      seed(photos);
      const store = make();
      const t = Date.now();
      for (let i = 0; i < 3000; i++) expect(store.lookup(dir).find('m', { fileName: `p${i}.jpg`, contentKey: `k${i}` })?.description).toBe(`P${i}.`);
      expect(store.stats.indexBuilds).toBe(1);
      expect(Date.now() - t).toBeLessThan(3000);
    });
  });

  describe('leftovers and odd cases', () => {
    it('the temp file has a name sync engines skip (~$... .tmp), and old leftovers are cleaned up on the next write', () => {
      const renames: string[] = [];
      writeFileSync(join(dir, '~$phototool-tags.json.1234.abcd.tmp'), 'left by a crash');
      writeFileSync(join(dir, '.phototool-tags.json.1234.abcd.tmp'), 'left by an older version');
      writeFileSync(join(dir, 'someone-else.tmp'), 'not ours');
      const store = make({ rename: (from, to) => { renames.push(from); renameSync(from, to); } });
      store.put(dir, 'a.jpg', 'm', r('k'));
      store.flush();
      expect(basename(renames[0])).toMatch(/^~\$phototool-tags\.json\.[0-9a-f]+\.tmp$/);
      expect(readdirSync(dir).sort()).toEqual([PHOTOTAGS_NAME, 'someone-else.tmp']);
    });

    it('an entry under our name that this version cannot read is left alone', () => {
      writeFileSync(tagsFile(), JSON.stringify({ format: 'phototool-tags/1', photos: { 'a.jpg': 'future shape', 'b.jpg': { models: [1, 2] } } }));
      const store = make();
      store.put(dir, 'a.jpg', 'm', r('k'));
      store.put(dir, 'b.jpg', 'm', r('k2'));
      store.put(dir, 'c.jpg', 'm', r('k3'));
      store.flush();
      const photos = json(tagsFile()).photos;
      expect(photos['a.jpg']).toBe('future shape');
      expect(photos['b.jpg']).toEqual({ models: [1, 2] });
      expect(photos['c.jpg']).toBeTruthy();
    });

    it('a result kept after close() is written at once', () => {
      const store = make();
      store.close();
      store.put(dir, 'a.jpg', 'm', r('k'));
      expect(json(tagsFile()).photos['a.jpg']).toBeTruthy();
    });
  });
});

describe('AlbumTagsStore: invalidate', () => {
  it('a file written just after a lookup is seen once the store is told a folder is being opened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phototags-inv-'));
    const store = new AlbumTagsStore({ fallbackDir: join(dir, 'fb'), onError: () => {} });
    try {
      expect(store.lookup(dir).status).toBe('none');
      writeFileSync(join(dir, PHOTOTAGS_NAME), JSON.stringify({ format: 'phototool-tags/1', photos: { 'a.jpg': { models: { m: { contentKey: 'k', description: 'New.' } } } } }));
      store.invalidate();
      expect(store.lookup(dir).find('m', { fileName: 'a.jpg', contentKey: 'k' })?.description).toBe('New.');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
