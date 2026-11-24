// The gallery's store, against a fake server: a star the server refuses is shown as an error and not
// applied, photo info changed by another program is reloaded once, and a folder the desktop app
// hands over (`--gallery <folder>`, a second launch, File > Open folder) is opened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryItem } from '../src/gallery/server/app';

const { useGallery, connectDesktop } = await import('../src/gallery/web/store');

function item(over: Partial<GalleryItem> = {}): GalleryItem {
  return {
    path: 'D:\\Trip\\a.jpg', folder: 'D:\\Trip', fileName: 'a.jpg', relDir: '', size: 1000, mtimeMs: 1, width: 400, height: 300,
    format: 'jpeg', capturedAt: null, gpsLat: null, gpsLon: null, camera: null, analysis: null, key: 'k1',
    info: {}, infoSource: 'folder', effectiveDate: null, effectiveLat: null, effectiveLon: null, ...over,
  };
}

type Route = (body: unknown) => { status?: number; json: unknown };
let routes: Record<string, Route>;
let calls: { method: string; url: string; body: unknown }[];

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  const path = url.split('?')[0];
  const route = routes[`${method} ${path}`];
  if (!route) return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 500 });
  const r = route(body);
  return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
});

const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.split('?')[0] === path).length;

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  useGallery.getState().close();
  useGallery.setState({ toasts: [] });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('gallery store', () => {
  it("shows the server's message as an error toast and leaves the star as it was", async () => {
    const message = "Can't save the star: photoinfo.json in D:\\Trip is in use by another program; try again.";
    routes['PATCH /api/gallery/info'] = () => ({ status: 409, json: { error: message } });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()] });

    const ok = await useGallery.getState().setStar('D:\\Trip\\a.jpg', true);

    expect(ok).toBe(false);
    expect(useGallery.getState().items[0].info.star).toBeUndefined();
    expect(useGallery.getState().toasts).toEqual([expect.objectContaining({ kind: 'error', text: message })]);
  });

  it('applies a star the server saved', async () => {
    routes['PATCH /api/gallery/info'] = (body) => ({ json: item({ info: { star: (body as { patch: { star: boolean } }).patch.star } }) });
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: 's2' } });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()] });

    expect(await useGallery.getState().setStar('D:\\Trip\\a.jpg', true)).toBe(true);
    expect(useGallery.getState().items[0].info.star).toBe(true);
    expect(useGallery.getState().toasts).toEqual([]);
  });

  it('fills the grid while the folder is read, then reloads photo info once when it changes', async () => {
    vi.useFakeTimers();
    let stamp = 'one';
    let polls = 0;
    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j1' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    routes['GET /api/gallery/jobs/j1'] = () => {
      polls++;
      // First poll: one photo of two; second poll: the other one, and done.
      return polls === 1
        ? { json: { total: 2, processed: 1, startedAt: 0, done: false, errors: [], items: [item()] } }
        : { json: { total: 2, processed: 2, startedAt: 0, done: true, errors: [], items: [item({ path: 'D:\\Trip\\b.jpg', fileName: 'b.jpg', key: 'k2' })] } };
    };
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp } });
    routes['GET /api/gallery/items'] = () => ({ json: [item({ info: { star: true } }), item({ path: 'D:\\Trip\\b.jpg', fileName: 'b.jpg', key: 'k2' })] });

    await useGallery.getState().open('D:\\Trip', true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(useGallery.getState().items.map((i) => i.fileName)).toEqual(['a.jpg', 'b.jpg']);
    expect(useGallery.getState().progress).toBeNull();
    // The second poll asked only for the photos it had not seen yet.
    expect(calls.filter((c) => c.url.startsWith('/api/gallery/jobs/j1')).map((c) => c.url)).toEqual(['/api/gallery/jobs/j1?since=0', '/api/gallery/jobs/j1?since=1']);

    await vi.advanceTimersByTimeAsync(3100);
    expect(count('GET', '/api/gallery/items')).toBe(0);

    stamp = 'two';
    await vi.advanceTimersByTimeAsync(3100);
    expect(count('GET', '/api/gallery/items')).toBe(1);
    expect(useGallery.getState().items[0].info.star).toBe(true);

    await vi.advanceTimersByTimeAsync(9100);
    expect(count('GET', '/api/gallery/items')).toBe(1);
  });

  it('opens a folder the desktop app hands over', async () => {
    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j9' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    routes['GET /api/gallery/jobs/j9'] = () => ({ json: { total: 0, processed: 0, startedAt: 0, done: true, errors: [], items: [] } });
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: '' } });
    let deliver: ((folder: string) => void) | undefined;
    const stop = vi.fn();
    const unsubscribe = connectDesktop({ onOpenFolder: (cb) => ((deliver = cb), stop) });

    deliver!('E:\\Photos\\2026');
    await vi.waitFor(() => expect(useGallery.getState().job).toBe('j9'));

    expect(calls.find((c) => c.method === 'POST')).toEqual(expect.objectContaining({ url: '/api/gallery/open', body: { folder: 'E:\\Photos\\2026', recursive: true } }));
    expect(useGallery.getState().root).toBe('E:\\Photos\\2026');
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the thumbnail size within 96–320 px', () => {
    useGallery.getState().setThumbSize(20);
    expect(useGallery.getState().thumbSize).toBe(96);
    useGallery.getState().setThumbSize(999);
    expect(useGallery.getState().thumbSize).toBe(320);
  });
});
