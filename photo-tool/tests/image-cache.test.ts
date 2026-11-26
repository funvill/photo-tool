// The shared image cache the viewer and the preview step from (issue #5): load order, the in-flight cap,
// cancelling what is no longer wanted, and the LRU bound. A fake Image stands in for the browser's.
import { describe, expect, it } from 'vitest';
import { ImageCache, type CacheImage } from '../web/imageCache';

class FakeImage implements CacheImage {
  src = '';
  fetchPriority: 'high' | 'low' | 'auto' = 'auto';
  decoding: 'async' | 'sync' | 'auto' = 'auto';
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decodeFails = false;
  decode(): Promise<void> {
    return this.decodeFails ? Promise.reject(new Error('EncodingError')) : Promise.resolve();
  }
}

function setup(opts: { maxInFlight?: number; capacity?: number } = {}) {
  const made: FakeImage[] = [];
  /** Every url ever asked of the network, in order. */
  const requested: string[] = [];
  const cache = new ImageCache({
    ...opts,
    createImage: () => {
      const img = new FakeImage();
      made.push(img);
      return new Proxy(img, {
        set(t, k, v) {
          if (k === 'src' && v) requested.push(v);
          return Reflect.set(t, k, v);
        },
      });
    },
  });
  const loading = () => made.filter((i) => i.src && i.onload);
  const img = (url: string) => made.find((i) => i.src === url)!;
  /** The network delivers `url`; then the decode settles. */
  const arrive = async (url: string) => {
    const i = img(url);
    i.naturalWidth = 1600;
    i.naturalHeight = 1067;
    i.onload!();
    await flush();
  };
  const fail = async (url: string) => {
    img(url).onerror!();
    await flush();
  };
  return { cache, made, requested, loading, img, arrive, fail };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const urls = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `u${from + i}`);

describe('ImageCache', () => {
  it('loads what is wanted in the order given, at most maxInFlight at once', async () => {
    const t = setup({ maxInFlight: 3 });
    t.cache.want(urls(6));
    expect(t.requested).toEqual(['u0', 'u1', 'u2']);
    expect(t.cache.inFlight).toBe(3);
    await t.arrive('u1');
    expect(t.requested).toEqual(['u0', 'u1', 'u2', 'u3']);
    await t.arrive('u0');
    await t.arrive('u2');
    expect(t.requested).toEqual(urls(6));
  });

  it('asks for the first wanted at high priority, the rest at low, all decoded off the main thread', () => {
    const t = setup();
    t.cache.want(['a', 'b']);
    expect(t.img('a').fetchPriority).toBe('high');
    expect(t.img('b').fetchPriority).toBe('low');
    expect(t.img('a').decoding).toBe('async');
  });

  it('get() gives an image only once it has loaded and decoded', async () => {
    const t = setup();
    t.cache.want(['a']);
    expect(t.cache.get('a')).toBeUndefined();
    await t.arrive('a');
    expect(t.cache.get('a')?.naturalWidth).toBe(1600);
  });

  it('a new want() reorders the queue: the new first photo goes next', async () => {
    const t = setup({ maxInFlight: 2 });
    t.cache.want(urls(5));
    t.cache.want(['u4', 'u0', 'u1', 'u3']);
    // u0 and u1 are still wanted and keep loading; u4 starts though the cap is full (the photo on screen).
    expect(t.requested).toEqual(['u0', 'u1', 'u4']);
    await t.arrive('u0');
    await t.arrive('u1');
    await t.arrive('u4');
    expect(t.requested).toEqual(['u0', 'u1', 'u4', 'u3']);
  });

  it('cancels loads no longer wanted, and drops them from the queue', async () => {
    const t = setup({ maxInFlight: 2 });
    t.cache.want(['a', 'b', 'c']);
    const a = t.img('a');
    t.cache.want(['x', 'y']);
    expect(a.src).toBe('');
    expect(a.onload).toBeNull();
    // b is cancelled too; x starts at once, y fills the second slot.
    expect(t.requested).toEqual(['a', 'b', 'x', 'y']);
    expect(t.cache.inFlight).toBe(2);
    await t.arrive('x');
    await t.arrive('y');
    expect(t.requested).not.toContain('c');
    expect(t.cache.get('a')).toBeUndefined();
  });

  it('holding a key down: each step cancels the photos passed by, so the one on screen is never queued behind them', async () => {
    const t = setup({ maxInFlight: 2 });
    for (let i = 0; i < 10; i++) t.cache.want([`u${i}`, `u${i + 1}`]);
    expect(t.cache.inFlight).toBeLessThanOrEqual(3);
    expect(t.loading().map((i) => i.src)).toContain('u9');
  });

  it('a photo already loaded is not asked for again', async () => {
    const t = setup();
    t.cache.want(['a', 'b']);
    await t.arrive('a');
    await t.arrive('b');
    t.cache.want(['b', 'a', 'c']);
    expect(t.requested).toEqual(['a', 'b', 'c']);
  });

  it('keeps at most `capacity` decoded images, dropping the least recently wanted first', async () => {
    const t = setup({ capacity: 3 });
    for (const u of urls(5)) {
      t.cache.want([u]);
      await t.arrive(u);
    }
    expect(t.cache.size).toBe(3);
    expect(t.cache.get('u0')).toBeUndefined();
    expect(t.cache.get('u1')).toBeUndefined();
    expect(t.cache.get('u4')).toBeDefined();
  });

  it('never drops a photo that is still wanted, and wanting one again makes it recent', async () => {
    const t = setup({ capacity: 3 });
    t.cache.want(['a', 'b', 'c']);
    for (const u of ['a', 'b', 'c']) await t.arrive(u);
    // a is wanted again (most recent); d comes in: b, the least recent not wanted, goes.
    t.cache.want(['d', 'a']);
    await t.arrive('d');
    expect(t.cache.get('a')).toBeDefined();
    expect(t.cache.get('b')).toBeUndefined();
    expect(t.cache.get('c')).toBeDefined();
    expect(t.cache.get('d')).toBeDefined();
  });

  it('a failed load is remembered (not asked for again) and frees its slot', async () => {
    const t = setup({ maxInFlight: 1 });
    t.cache.want(['a', 'b']);
    await t.fail('a');
    expect(t.cache.failed('a')).toBe(true);
    expect(t.requested).toEqual(['a', 'b']);
    t.cache.want(['a', 'b']);
    expect(t.requested).toEqual(['a', 'b']);
  });

  it('a decode that fails still shows the picture when it has pixels', async () => {
    const t = setup();
    t.cache.want(['a']);
    t.img('a').decodeFails = true;
    await t.arrive('a');
    expect(t.cache.get('a')).toBeDefined();
  });

  it('load() resolves once decoded, and keeps its photo loading through a want() that leaves it out', async () => {
    const t = setup();
    const p = t.cache.load('a');
    t.cache.want(['b', 'c']);
    expect(t.img('a').src).toBe('a');
    await t.arrive('a');
    await expect(p).resolves.toBe(t.cache.get('a'));
    // Already there: resolves without asking again.
    await expect(t.cache.load('a')).resolves.toBeDefined();
    expect(t.requested.filter((u) => u === 'a')).toHaveLength(1);
  });

  it('load() rejects when the picture cannot be had', async () => {
    const t = setup();
    const p = t.cache.load('a');
    await t.fail('a');
    await expect(p).rejects.toThrow();
    await expect(t.cache.load('a')).rejects.toThrow();
  });
});
