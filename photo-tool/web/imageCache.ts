import { useEffect, useRef, useState } from 'react';

// One image cache shared by the viewer and the preview pane (issue #5). The photos around the one on
// screen are loaded and decoded ahead of time, so a step shows the next photo from memory: no network
// wait, no decode stall. At most a few loads run at once, a new want() list reorders the queue and
// cancels what is no longer wanted (holding an arrow key never piles up stale loads), and the decoded
// images are bounded by a least-recently-used limit.

/** What the cache needs of an image: the parts of HTMLImageElement it uses (a fake one in the tests). */
export interface CacheImage {
  src: string;
  fetchPriority: string;
  decoding: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  decode(): Promise<void>;
}

export interface ImageCacheOptions {
  /** Loads running at once (default 6, the browser's connections per host). The most wanted photo may make it one more. */
  maxInFlight?: number;
  /** Decoded images kept (default 40). A 1600 px picture is about 10 MB decoded. */
  capacity?: number;
  createImage?: () => CacheImage;
}

interface Entry {
  img: CacheImage;
  ready: boolean;
  waiters: { ok(img: CacheImage): void; fail(e: Error): void }[];
}

/** Failed addresses remembered (so they are not asked for on every step), oldest forgotten first. */
const FAILED_KEPT = 500;

export class ImageCache {
  private readonly maxInFlight: number;
  private readonly capacity: number;
  private readonly createImage: () => CacheImage;
  /** Loading and loaded images, least recently wanted first (a Map keeps insertion order). */
  private readonly entries = new Map<string, Entry>();
  private readonly failedUrls = new Set<string>();
  /** The last want() list, most wanted first. */
  private wanted: string[] = [];
  private wantedSet = new Set<string>();
  /** Addresses a load() is waiting on, with how many: loaded whatever want() says. */
  private readonly pinned = new Map<string, number>();
  private loads = 0;

  constructor(opts: ImageCacheOptions = {}) {
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? 6);
    this.capacity = Math.max(1, opts.capacity ?? 40);
    this.createImage = opts.createImage ?? (() => new Image() as unknown as CacheImage);
  }

  /** Loads running now. */
  get inFlight(): number {
    return this.loads;
  }

  /** Decoded images held now. */
  get size(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.ready) n++;
    return n;
  }

  /** The decoded image for `url`, if it is here. */
  get(url: string): CacheImage | undefined {
    const e = this.entries.get(url);
    return e?.ready ? e.img : undefined;
  }

  /** Whether `url` failed to load (a missing picture). */
  failed(url: string): boolean {
    return this.failedUrls.has(url);
  }

  /**
   * The photos to have ready, most wanted first (the one on screen, then preloadOrder's). Replaces the
   * last list: loads no longer wanted are cancelled, the queue follows the new order, and the wanted
   * photos already here become the most recent (the last to be dropped).
   */
  want(urls: readonly string[]): void {
    this.wanted = [...new Set(urls)];
    this.wantedSet = new Set(this.wanted);
    for (const [url, e] of this.entries) {
      if (!e.ready && !this.keep(url)) this.cancel(url, e);
    }
    for (let i = this.wanted.length - 1; i >= 0; i--) this.touch(this.wanted[i]);
    this.pump();
  }

  /**
   * The decoded image for `url`, loaded first (ahead of everything wanted) when it is not here yet. Kept
   * loading whatever want() says until it settles or `signal` aborts (the photo was stepped past): then
   * the next want() may cancel it like any other, and the promise rejects.
   */
  load(url: string, signal?: AbortSignal): Promise<CacheImage> {
    const e = this.entries.get(url);
    if (e?.ready) {
      this.touch(url);
      return Promise.resolve(e.img);
    }
    if (this.failedUrls.has(url)) return Promise.reject(new Error(`Could not load ${url}`));
    if (signal?.aborted) return Promise.reject(new Error(`Not wanted: ${url}`));
    this.pinned.set(url, (this.pinned.get(url) ?? 0) + 1);
    let pinned = true;
    const unpin = () => {
      if (!pinned) return;
      pinned = false;
      const n = (this.pinned.get(url) ?? 1) - 1;
      if (n > 0) this.pinned.set(url, n);
      else this.pinned.delete(url);
    };
    return new Promise<CacheImage>((ok, fail) => {
      const entry = this.entries.get(url) ?? this.start(url, true);
      const waiter = {
        ok: (img: CacheImage) => {
          unpin();
          ok(img);
        },
        fail: (err: Error) => {
          unpin();
          fail(err);
        },
      };
      entry.waiters.push(waiter);
      signal?.addEventListener('abort', () => {
        const at = entry.waiters.indexOf(waiter);
        if (at < 0) return;
        entry.waiters.splice(at, 1);
        unpin();
        fail(new Error(`Not wanted: ${url}`));
      }, { once: true });
    });
  }

  private keep(url: string): boolean {
    return this.wantedSet.has(url) || this.pinned.has(url);
  }

  /** Moves `url` to the most recent end. */
  private touch(url: string): void {
    const e = this.entries.get(url);
    if (!e) return;
    this.entries.delete(url);
    this.entries.set(url, e);
  }

  private start(url: string, high: boolean): Entry {
    const img = this.createImage();
    const entry: Entry = { img, ready: false, waiters: [] };
    this.entries.set(url, entry);
    this.loads++;
    img.decoding = 'async';
    img.fetchPriority = high ? 'high' : 'low';
    img.onload = () => {
      img.onload = img.onerror = null;
      // Decoded now, off the main thread, rather than on the frame that first shows it.
      img.decode().then(
        () => this.settle(url, entry, true),
        () => this.settle(url, entry, img.naturalWidth > 0),
      );
    };
    img.onerror = () => {
      img.onload = img.onerror = null;
      this.settle(url, entry, false);
    };
    img.src = url;
    return entry;
  }

  private settle(url: string, entry: Entry, ok: boolean): void {
    // Cancelled while it decoded.
    if (this.entries.get(url) !== entry) return;
    this.loads--;
    if (ok) {
      entry.ready = true;
      for (const w of entry.waiters.splice(0)) w.ok(entry.img);
      this.evict();
    } else {
      this.entries.delete(url);
      this.failedUrls.add(url);
      if (this.failedUrls.size > FAILED_KEPT) this.failedUrls.delete(this.failedUrls.values().next().value!);
      for (const w of entry.waiters.splice(0)) w.fail(new Error(`Could not load ${url}`));
    }
    this.pump();
  }

  private cancel(url: string, e: Entry): void {
    e.img.onload = e.img.onerror = null;
    e.img.src = '';
    this.entries.delete(url);
    this.loads--;
  }

  /** Starts the most wanted photo not loading yet (even past the cap), then more up to the cap. */
  private pump(): void {
    let first = true;
    for (const url of this.wanted) {
      if (this.entries.has(url) || this.failedUrls.has(url)) {
        first = false;
        continue;
      }
      if (!first && this.loads >= this.maxInFlight) break;
      this.start(url, first);
      first = false;
    }
  }

  /** Drops the least recently wanted decoded images past the capacity; never one still wanted. */
  private evict(): void {
    let over = this.size - this.capacity;
    if (over <= 0) return;
    for (const [url, e] of this.entries) {
      if (over <= 0) break;
      if (!e.ready || this.keep(url)) continue;
      this.entries.delete(url);
      over--;
    }
  }
}

/** The one cache the page shares: the viewer, the preview pane and the grid all feed it. */
export const imageCache = new ImageCache();

/**
 * What to put on screen for `url` (with `value`, what it shows): at once when it is decoded already; else
 * the last one shown stays until it is (no blank frame between photos), then it comes in. When `url`
 * fails, `fallback` is tried. The first photo, with nothing shown before it, is shown straight away.
 */
export function useDecodedSwap<T>(url: string, fallback: string | undefined, value: T, cache: ImageCache = imageCache): { url: string; value: T } {
  const [shown, setShown] = useState<{ url: string; value: T; for: string } | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const ready = cache.get(url) ? url : fallback && cache.failed(url) && cache.get(fallback) ? fallback : null;

  useEffect(() => {
    if (ready) {
      setShown({ url: ready, value: latest.current, for: url });
      return;
    }
    // Stepped past before it came: the load is let go, so the next want() can cancel it.
    const gone = new AbortController();
    const show = (u: string) => !gone.signal.aborted && setShown({ url: u, value: latest.current, for: url });
    cache.load(url, gone.signal).then(
      () => show(url),
      () => {
        if (gone.signal.aborted) return;
        if (!fallback) return show(url);
        cache.load(fallback, gone.signal).then(
          () => show(fallback),
          () => show(fallback),
        );
      },
    );
    return () => gone.abort();
  }, [url, fallback, ready, cache]);

  if (ready) return { url: ready, value };
  if (shown === null) return { url, value };
  // This photo's own picture: with its latest value (a star given since).
  if (shown.for === url) return { url: shown.url, value };
  return { url: shown.url, value: shown.value };
}
