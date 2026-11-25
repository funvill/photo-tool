// The gallery's store, against a fake server: a star the server refuses is shown as an error and not
// applied, photo info changed by another program is reloaded once, and a folder the desktop app
// hands over (`--gallery <folder>`, a second launch, File > Open folder) is opened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryItem } from '../src/gallery/server/app';

const { useGallery, connectDesktop, guardUnload, selectVisible, selectStackInfo, selectFiltered, selectFacts, selectStackPlace, menuTargets, shownEdit, selectMeaningStart } = await import('../src/gallery/web/store');
const { IDENTITY_EDIT } = await import('../src/core/photoEdit');

function item(over: Partial<GalleryItem> = {}): GalleryItem {
  return {
    path: 'D:\\Trip\\a.jpg', folder: 'D:\\Trip', fileName: 'a.jpg', relDir: '', size: 1000, mtimeMs: 1, width: 400, height: 300,
    format: 'jpeg', capturedAt: null, gpsLat: null, gpsLon: null, camera: null, exif: null, analysis: null, key: 'k1', contentKey: null,
    info: {}, tags: { state: 'off', description: null, keywords: [], objects: [] }, infoSource: 'folder', effectiveDate: null, effectiveLat: null, effectiveLon: null, ...over,
  };
}

type Reply = { status?: number; json: unknown };
type Route = (body: unknown) => Reply | Promise<Reply>;
let routes: Record<string, Route>;
let calls: { method: string; url: string; body: unknown }[];

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  const path = url.split('?')[0];
  const route = routes[`${method} ${path}`];
  if (!route) return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 500 });
  const r = await route(body);
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

    // Once when the scan ends (info may have changed while the folder was read), then only on a change.
    expect(count('GET', '/api/gallery/items')).toBe(1);
    await vi.advanceTimersByTimeAsync(3100);
    expect(count('GET', '/api/gallery/items')).toBe(1);

    stamp = 'two';
    await vi.advanceTimersByTimeAsync(3100);
    expect(count('GET', '/api/gallery/items')).toBe(2);
    expect(useGallery.getState().items[0].info.star).toBe(true);

    await vi.advanceTimersByTimeAsync(9100);
    expect(count('GET', '/api/gallery/items')).toBe(2);
  });

  /** Open D:\Trip (two photos, read at once) and let the info watch take its baseline (and reload once: 1 GET /items). */
  async function openTrip(stamp: () => string) {
    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j1' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    routes['GET /api/gallery/jobs/j1'] = () => ({ json: { total: 1, processed: 1, startedAt: 0, done: true, errors: [], items: [item()] } });
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: stamp() } });
    routes['GET /api/gallery/items'] = () => ({ json: [item()] });
    await useGallery.getState().open('D:\Trip', true);
    expect(count('GET', '/api/gallery/items')).toBe(1);
  }

  it("does not reload after its own star, but still reloads for another program's change made just before it", async () => {
    vi.useFakeTimers();
    let stamp = 'one';
    await openTrip(() => stamp);
    routes['GET /api/gallery/items'] = () => ({ json: [item({ info: { star: true, notes: 'from the editor' } })] });
    const starAs = (before: string, after: string) => {
      routes['PATCH /api/gallery/info'] = (body) => {
        expect(body).toEqual({ path: 'D:\Trip\a.jpg', patch: { star: true }, job: 'j1' });
        stamp = after;
        return { json: { ...item({ info: { star: true } }), stamp: { before, after } } };
      };
      return useGallery.getState().setStar('D:\Trip\a.jpg', true);
    };

    // Our own star only: the poll sees nothing new.
    expect(await starAs('one', 'two')).toBe(true);
    expect(useGallery.getState().items[0]).not.toHaveProperty('stamp');
    await vi.advanceTimersByTimeAsync(3100);
    expect(count('GET', '/api/gallery/items')).toBe(1);

    // Another program writes, and we star before the next poll: that change is still picked up, once.
    stamp = 'three';
    expect(await starAs('three', 'four')).toBe(true);
    await vi.advanceTimersByTimeAsync(3100);
    expect(count('GET', '/api/gallery/items')).toBe(2);
    expect(useGallery.getState().items[0].info.notes).toBe('from the editor');
    await vi.advanceTimersByTimeAsync(9100);
    expect(count('GET', '/api/gallery/items')).toBe(2);
  });

  it('keeps a star saved while an older reload was on its way', async () => {
    useGallery.setState({ job: 'j1', root: 'D:\Trip', items: [item()] });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    routes['GET /api/gallery/items'] = async () => {
      await held;
      return { json: [item({ info: { notes: 'n' } })] };
    };
    routes['PATCH /api/gallery/info'] = () => ({ json: item({ info: { star: true } }) });

    const refresh = useGallery.getState().refreshInfo();
    await vi.waitFor(() => expect(count('GET', '/api/gallery/items')).toBe(1));
    expect(await useGallery.getState().setStar('D:\Trip\a.jpg', true)).toBe(true);
    release();
    await refresh;

    expect(useGallery.getState().items[0].info.star).toBe(true);
  });

  it('keeps reading the folder after a failed poll, and gives up with a message after a few', async () => {
    vi.useFakeTimers();
    let failures = 2;
    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j1' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: 's' } });
    routes['GET /api/gallery/items'] = () => ({ json: [item()] });
    routes['GET /api/gallery/jobs/j1'] = () =>
      failures-- > 0 ? { status: 500, json: { error: 'busy' } } : { json: { total: 1, processed: 1, startedAt: 0, done: true, errors: [], items: [item()] } };
    await useGallery.getState().open('D:\Trip', true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useGallery.getState().items).toHaveLength(1);
    expect(useGallery.getState().progress).toBeNull();
    expect(useGallery.getState().toasts).toEqual([]);
    expect(count('GET', '/api/gallery/stamp')).toBeGreaterThan(0);

    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j2' } });
    routes['GET /api/gallery/jobs/j2'] = () => ({ status: 500, json: { error: 'The server stopped' } });
    await useGallery.getState().open('D:\\Other', true);
    // Retries 1 s, 2 s and 4 s apart; the error toast then stays 7 s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count('GET', '/api/gallery/jobs/j2')).toBe(4);
    expect(useGallery.getState().progress).toBeNull();
    expect(useGallery.getState().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'The server stopped' })]);
  });

  it("picks up another program's change to a photo delivered while the folder was still being read, with one reload when the scan ends", async () => {
    vi.useFakeTimers();
    let polls = 0;
    let notes = 'old';
    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j1' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    routes['GET /api/gallery/jobs/j1'] = () => {
      polls++;
      if (polls === 1) return { json: { total: 2, processed: 1, startedAt: 0, done: false, cancelled: false, errors: [], items: [item({ info: { notes } })] } };
      // Between the polls another program changes a.jpg's notes: the stamp baseline is only taken after the scan.
      return { json: { total: 2, processed: 2, startedAt: 0, done: true, cancelled: false, errors: [], items: [item({ path: 'D:\\Trip\\b.jpg', fileName: 'b.jpg', key: 'k2' })] } };
    };
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: `notes=${notes}` } });
    routes['GET /api/gallery/items'] = () => ({ json: [item({ info: { notes } }), item({ path: 'D:\\Trip\\b.jpg', fileName: 'b.jpg', key: 'k2' })] });

    await useGallery.getState().open('D:\\Trip', true);
    expect(useGallery.getState().items[0].info.notes).toBe('old');
    notes = 'from the editor';
    await vi.advanceTimersByTimeAsync(600);
    expect(useGallery.getState().progress).toBeNull();
    expect(useGallery.getState().items.map((i) => i.info.notes)).toEqual(['from the editor', undefined]);
    expect(count('GET', '/api/gallery/items')).toBe(1);
    // The stamp has not changed since: no further reload.
    await vi.advanceTimersByTimeAsync(9100);
    expect(count('GET', '/api/gallery/items')).toBe(1);
  });

  it('cancels a scan still running when another folder is opened or the folder is closed', async () => {
    vi.useFakeTimers();
    let next = 'j1';
    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: next } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    const running = () => ({ json: { total: 5, processed: 1, startedAt: 0, done: false, cancelled: false, errors: [], items: [] } });
    routes['GET /api/gallery/jobs/j1'] = running;
    routes['GET /api/gallery/jobs/j2'] = running;
    routes['POST /api/gallery/jobs/j1/cancel'] = () => ({ json: { cancelled: true } });
    routes['POST /api/gallery/jobs/j2/cancel'] = () => ({ json: { cancelled: true } });

    await useGallery.getState().open('D:\\Trip', true);
    expect(useGallery.getState().progress).not.toBeNull();
    next = 'j2';
    await useGallery.getState().open('D:\\Other', true);
    expect(count('POST', '/api/gallery/jobs/j1/cancel')).toBe(1);
    // The cancel goes out before the new folder is asked for.
    expect(calls.findIndex((c) => c.url === '/api/gallery/jobs/j1/cancel')).toBeLessThan(calls.map((c) => c.url).lastIndexOf('/api/gallery/open'));

    useGallery.getState().close();
    expect(count('POST', '/api/gallery/jobs/j2/cancel')).toBe(1);
    expect(useGallery.getState().toasts).toEqual([]);
  });

  it('does not cancel a scan that has finished', async () => {
    vi.useFakeTimers();
    await openTrip(() => 's');
    useGallery.getState().close();
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
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

  it('saves any info field the way a star is saved, sending a null to delete one', async () => {
    vi.useFakeTimers();
    let stamp = 'one';
    await openTrip(() => stamp);
    routes['GET /api/gallery/items'] = () => ({ json: [item()] });
    routes['PATCH /api/gallery/info'] = (body) => {
      expect(body).toEqual({ path: 'p/a.jpg', patch: { date: null, people: ['Ann'] }, job: 'j1' });
      stamp = 'two';
      return { json: { ...item({ path: 'p/a.jpg', info: { people: ['Ann'] } }), stamp: { before: 'one', after: 'two' } } };
    };
    useGallery.setState({ items: [item({ path: 'p/a.jpg', info: { date: '2020-01-01T00:00:00' } })] });

    expect(await useGallery.getState().saveInfo('p/a.jpg', { date: null, people: ['Ann'] })).toBe(true);
    expect(useGallery.getState().items[0].info).toEqual({ people: ['Ann'] });
    // The write was ours: the poll does not reload every photo for it (the one reload is openTrip's).
    await vi.advanceTimersByTimeAsync(3100);
    expect(count('GET', '/api/gallery/items')).toBe(1);
  });

  it("shows the server's message when a field cannot be saved, and applies nothing", async () => {
    routes['PATCH /api/gallery/info'] = () => ({ status: 409, json: { error: 'photoinfo.json is in use by another program; try again.' } });
    useGallery.setState({ job: 'j1', root: 'D:\Trip', items: [item({ info: { notes: 'old' } })] });

    expect(await useGallery.getState().saveInfo('D:\Trip\a.jpg', { notes: 'new' })).toBe(false);
    expect(useGallery.getState().items[0].info.notes).toBe('old');
    expect(useGallery.getState().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'photoinfo.json is in use by another program; try again.' })]);
  });

  it('keeps a description saved while an older reload was on its way', async () => {
    useGallery.setState({ job: 'j1', root: 'D:\Trip', items: [item()] });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    routes['GET /api/gallery/items'] = async () => {
      await held;
      return { json: [item()] };
    };
    routes['PATCH /api/gallery/info'] = () => ({ json: item({ info: { description: 'Beach' } }) });

    const refresh = useGallery.getState().refreshInfo();
    await vi.waitFor(() => expect(count('GET', '/api/gallery/items')).toBe(1));
    expect(await useGallery.getState().saveInfo('D:\Trip\a.jpg', { description: 'Beach' })).toBe(true);
    release();
    await refresh;
    expect(useGallery.getState().items[0].info.description).toBe('Beach');
  });

  it("sends a photo's saves one after another and applies only the last reply, so an older reply never undoes a newer save", async () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item({ info: { description: 'old' } })] });
    const replies: ((description: string) => void)[] = [];
    routes['PATCH /api/gallery/info'] = (body) =>
      new Promise((done) => replies.push(() => done({ json: item({ info: { description: (body as { patch: { description: string } }).patch.description } }) })));

    const first = useGallery.getState().saveInfo('D:\\Trip\\a.jpg', { description: 'a' });
    const second = useGallery.getState().saveInfo('D:\\Trip\\a.jpg', { description: 'ab' });
    await vi.waitFor(() => expect(count('PATCH', '/api/gallery/info')).toBe(1));
    // The second save waits for the first: the server writes them in the order they were made.
    await new Promise((r) => setTimeout(r, 20));
    expect(count('PATCH', '/api/gallery/info')).toBe(1);

    replies[0]('a');
    expect(await first).toBe(true);
    // The newer save is still on its way: the photo (and a field showing it) is not reset to 'a'.
    expect(useGallery.getState().items[0].info.description).toBe('old');
    await vi.waitFor(() => expect(count('PATCH', '/api/gallery/info')).toBe(2));

    replies[1]('ab');
    expect(await second).toBe(true);
    expect(useGallery.getState().items[0].info.description).toBe('ab');
  });

  it('applies the last good reply when a later save of the same photo fails', async () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()] });
    let n = 0;
    routes['PATCH /api/gallery/info'] = () => (++n === 1 ? { json: item({ info: { star: true } }) } : { status: 409, json: { error: 'busy' } });

    const [a, b] = await Promise.all([useGallery.getState().setStar('D:\\Trip\\a.jpg', true), useGallery.getState().saveInfo('D:\\Trip\\a.jpg', { notes: 'x' })]);

    expect([a, b]).toEqual([true, false]);
    expect(useGallery.getState().items[0].info).toEqual({ star: true });
  });

  it('builds the selection from clicks, and a filter change drops the photos it hides', () => {
    const items = [item({ path: 'a', fileName: 'a.jpg', info: { star: true } }), item({ path: 'b', fileName: 'b.jpg' }), item({ path: 'c', fileName: 'c.jpg', info: { star: true } })];
    useGallery.setState({ items, sort: 'name', filter: {} });
    const g = () => useGallery.getState();
    g().clickSelect('a', {});
    g().clickSelect('c', { shift: true });
    expect(g().selection).toEqual(['a', 'b', 'c']);
    expect(g().selected).toBe('c');
    g().setFilter({ starred: 'yes' });
    expect(g().selection).toEqual(['a', 'c']);
    g().clearFilter();
    expect(g().selection).toEqual(['a', 'c']);
  });

  it('shows a drag the desktop app could not start as an error, until it stops listening', () => {
    let send: ((message: string) => void) | undefined;
    const stop = vi.fn();
    const unsubscribe = connectDesktop({ onDragFailed: (cb) => ((send = cb), stop) });
    send!("Couldn't drag the photos: the gallery did not answer in time. Try again.");
    expect(useGallery.getState().toasts).toEqual([expect.objectContaining({ kind: 'error', text: "Couldn't drag the photos: the gallery did not answer in time. Try again." })]);
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('closing the viewer selects the last photo viewed', () => {
    useGallery.setState({ items: [item({ path: 'a' }), item({ path: 'b' })], selected: 'a', selection: ['a', 'b'] });
    useGallery.getState().openViewer('a');
    expect(useGallery.getState().viewing).toBe('a');
    useGallery.getState().closeViewer('b');
    expect(useGallery.getState()).toMatchObject({ viewing: null, selected: 'b', selection: ['b'] });
  });

  it('keeps the thumbnail size within 96–320 px', () => {
    useGallery.getState().setThumbSize(20);
    expect(useGallery.getState().thumbSize).toBe(96);
    useGallery.getState().setThumbSize(999);
    expect(useGallery.getState().thumbSize).toBe(320);
  });

  it('keeps the grid column count the grid publishes, at least 1', () => {
    useGallery.getState().setGridCols(5);
    expect(useGallery.getState().gridCols).toBe(5);
    useGallery.getState().setGridCols(0);
    expect(useGallery.getState().gridCols).toBe(1);
  });

  it('remembers sort and filters for the session, but a new folder clears the subfolder filter', async () => {
    routes['POST /api/gallery/open'] = () => ({ json: { jobId: 'j2' } });
    routes['GET /api/gallery/job'] = () => ({ json: { done: true, total: 0, processed: 0, startedAt: 0, items: [], errors: [] } });
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: 's' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    useGallery.getState().setSort('name');
    useGallery.getState().setFilter({ starred: 'yes', relDir: 'sub' });
    await useGallery.getState().open('D:\\Other', true);
    expect(useGallery.getState().sort).toBe('name');
    expect(useGallery.getState().filter).toEqual({ starred: 'yes' });
    useGallery.getState().setFilter({ starred: undefined });
    expect(useGallery.getState().filter).toEqual({});
  });

  it('works the visible list out once per change of photos, sort or filter', () => {
    const items = [item({ path: 'b', fileName: 'b.jpg', info: { star: true } }), item({ path: 'a', fileName: 'a.jpg' })];
    const base = { items, sort: 'name' as const, filter: {} };
    const first = selectVisible(base);
    expect(first.map((i) => i.path)).toEqual(['a', 'b']);
    expect(selectVisible({ ...base })).toBe(first);
    expect(selectVisible({ ...base, filter: { starred: 'yes' } }).map((i) => i.path)).toEqual(['b']);
    expect(selectVisible({ ...base, sort: 'date' })).not.toBe(first);
  });

  it('while a folder is being read, keeps the last facts for 2 s instead of redoing them on every update', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const small = (path: string) => item({ path, fileName: path, width: 100, height: 80 });
    const analysis = { sharpness: 100, meanLuma: 0.45, clippedShadows: 0, clippedHighlights: 0, dHash: '0123456789abcdef', saliencyX: 0.5, saliencyY: 0.5 };
    const a = { ...small('a'), analysis };
    const b = { ...small('b'), analysis: { ...analysis, dHash: 'fedcba9876543210' } };
    const scanning = { total: 2, processed: 1, startedAt: 0 };
    const state = { sort: 'date' as const, filter: { lowQuality: true } };
    expect(selectVisible({ ...state, items: [a], progress: scanning }).map((i) => i.path)).toEqual(['a']);
    // A second later b has arrived but has no facts yet, so the low-quality filter leaves it out.
    vi.setSystemTime(Date.now() + 1000);
    const two = [a, b];
    expect(selectVisible({ ...state, items: two, progress: scanning }).map((i) => i.path)).toEqual(['a']);
    expect(selectVisible({ ...state, items: two, progress: scanning })).toBe(selectVisible({ ...state, items: two, progress: scanning }));
    // Scan finished (same items): facts are worked out for everything.
    expect(selectVisible({ ...state, items: two, progress: null }).map((i) => i.path)).toEqual(['a', 'b']);
    // Still scanning, but more than 2 s on: refreshed.
    const three = [a, b, { ...small('c'), analysis: { ...analysis, dHash: '00ff00ff00ff00ff' } }];
    vi.setSystemTime(Date.now() + 2500);
    expect(selectVisible({ ...state, items: three, progress: scanning }).map((i) => i.path)).toEqual(['a', 'b', 'c']);
  });
  describe('review: hidden, stacks, flags and removal', () => {
    const photos = (...names: string[]) => names.map((n) => item({ path: n, fileName: `${n}.jpg`, key: n }));
    const g = () => useGallery.getState();
    const setup = (items: GalleryItem[], selected: string | null, extra: Record<string, unknown> = {}) =>
      useGallery.setState({ job: 'j1', root: 'D:\Trip', items, sort: 'name', filter: {}, stacked: false, openStacks: [], view: 'grid', selected, selection: selected ? [selected] : [], anchor: selected, ...extra });
    /** A server that applies the patch to the photo it is for and answers with it. */
    const serve = () => {
      const saved: { path: string; patch: Record<string, unknown> }[] = [];
      routes['PATCH /api/gallery/info'] = (body) => {
        const b = body as { path: string; patch: Record<string, unknown> };
        saved.push({ path: b.path, patch: b.patch });
        const old = g().items.find((i) => i.path === b.path)!;
        const info = { ...old.info, ...b.patch } as Record<string, unknown>;
        for (const k of Object.keys(info)) if (info[k] === null) delete info[k];
        return { json: { ...old, info } };
      };
      return saved;
    };

    it("toggleFlag('hidden') hides the selected photo and selects the next one", async () => {
      setup(photos('a', 'b', 'c'), 'b');
      const saved = serve();
      await g().toggleFlag('hidden');
      expect(saved).toEqual([{ path: 'b', patch: { hidden: true } }]);
      expect(g().selected).toBe('c');
      expect(g().selection).toEqual(['c']);
    });

    it("toggleFlag('hidden') on the last shown photo selects the previous one", async () => {
      setup(photos('a', 'b', 'c'), 'c');
      serve();
      await g().toggleFlag('hidden');
      expect(g().selected).toBe('b');
    });

    it('hiding every photo leaves nothing selected', async () => {
      setup(photos('a'), 'a');
      serve();
      await g().toggleFlag('hidden');
      expect(g().selected).toBeNull();
      expect(g().selection).toEqual([]);
      expect(selectVisible(g())).toEqual([]);
    });

    it('toggleFlag on a multi-selection sets every selected photo to the opposite of the focused one', async () => {
      setup(photos('a', 'b', 'c'), 'b', { selection: ['a', 'b'] });
      const saved = serve();
      await g().toggleFlag('hidden');
      expect(saved).toEqual([{ path: 'a', patch: { hidden: true } }, { path: 'b', patch: { hidden: true } }]);
      expect(g().selected).toBe('c');
      expect(g().selection).toEqual(['c']);
    });

    it("toggleFlag('hidden') on a hidden photo with filter 'show' sends hidden: null", async () => {
      setup([item({ path: 'a', info: { hidden: true } }), ...photos('b')], 'a', { filter: { hidden: 'show' } });
      const saved = serve();
      await g().toggleFlag('hidden');
      expect(saved).toEqual([{ path: 'a', patch: { hidden: null } }]);
      expect(g().items[0].info.hidden).toBeUndefined();
      expect(g().selected).toBe('a');
    });

    it("toggleFlag('star') stars through setStar", async () => {
      setup(photos('a', 'b'), 'a');
      const saved = serve();
      await g().toggleFlag('star');
      expect(saved).toEqual([{ path: 'a', patch: { star: true } }]);
      expect(g().items[0].info.star).toBe(true);
      expect(g().selected).toBe('a');
    });

    const burst = (name: string, at: string) =>
      item({
        path: name, fileName: `${name}.jpg`, key: name, capturedAt: at,
        analysis: { sharpness: 100, meanLuma: 0.45, clippedShadows: 0, clippedHighlights: 0, dHash: '0123456789abcdef', saliencyX: 0.5, saliencyY: 0.5 },
      });

    it('stacked list folds a group and toggleStack unfolds it', () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), ...photos('z')], null, { stacked: true });
      expect(selectVisible(g()).map((i) => i.path)).toHaveLength(2);
      const info = selectStackInfo(g());
      expect([...info.values()]).toEqual([expect.objectContaining({ size: 2, open: false, top: true })]);
      const id = [...info.values()][0].id;
      g().toggleStack(id);
      expect(g().openStacks).toEqual([id]);
      expect(selectVisible(g()).map((i) => i.path).sort()).toEqual(['a', 'b', 'z']);
      expect(selectVisible(g())).toBe(selectVisible(g()));
      g().toggleStack(id);
      expect(g().openStacks).toEqual([]);
      expect(selectVisible(g())).toHaveLength(2);
    });

    it('setStacked(false) shows every photo', () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01')], null, { stacked: true });
      expect(selectVisible(g())).toHaveLength(1);
      g().setStacked(false);
      expect(selectVisible(g())).toHaveLength(2);
      expect(selectStackInfo(g()).size).toBe(0);
    });

    it('selectFiltered is the filtered, sorted list with stacks unfolded and hidden photos left out', () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), item({ path: 'h', info: { hidden: true } }), ...photos('z')], null, { stacked: true });
      expect(selectVisible(g())).toHaveLength(2);
      expect(selectFiltered(g()).map((i) => i.path).sort()).toEqual(['a', 'b', 'z']);
      expect(selectFiltered(g())).toBe(selectFiltered(g()));
    });

    it('on the map a photo folded into a stack keeps the selection when the filter changes', () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), ...photos('z')], null, { stacked: true });
      const folded = selectFiltered(g()).find((i) => !selectVisible(g()).includes(i))!.path;
      g().setView('map');
      g().select(folded);
      g().setFilter({ orientation: undefined });
      g().setStacked(true);
      g().toggleStack('nothing');
      expect(g().selected).toBe(folded);
      expect(g().selection).toEqual([folded]);
    });

    it('map to grid with a folded member selected unfolds its stack: still selected, and shown', () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), ...photos('z')], null, { stacked: true, view: 'map' });
      const folded = selectFiltered(g()).find((i) => !selectVisible(g()).includes(i))!.path;
      g().select(folded);
      expect(selectStackPlace(g(), folded)).toEqual({ place: 2, size: 2 });
      g().setView('grid');
      expect(g().selected).toBe(folded);
      expect(g().selection).toEqual([folded]);
      expect(selectVisible(g()).map((i) => i.path)).toContain(folded);
      expect(selectStackInfo(g()).get(folded)).toMatchObject({ open: true, top: false });
      expect(selectStackPlace(g(), folded)).toEqual({ place: 2, size: 2 });
      g().setFilter({ starred: undefined });
      expect(g().selection).toEqual([folded]);
    });

    it('the viewer opened on a folded member unfolds its stack, so it steps from that photo', () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), ...photos('z')], null, { stacked: true, view: 'map' });
      const folded = selectFiltered(g()).find((i) => !selectVisible(g()).includes(i))!.path;
      g().select(folded);
      g().openViewer(folded);
      expect(g().viewing).toBe(folded);
      expect(selectVisible(g()).map((i) => i.path)).toContain(folded);
    });

    it("on the map the menu's targets are the selected photos as the map lists them, folded members included", () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), ...photos('z')], null, { stacked: true, view: 'map' });
      const folded = selectFiltered(g()).find((i) => !selectVisible(g()).includes(i))!.path;
      g().select(folded);
      expect(menuTargets(folded)).toEqual([folded]);
      useGallery.setState({ selection: ['z', folded] });
      expect(menuTargets(folded)).toEqual(selectFiltered(g()).map((i) => i.path).filter((p) => p === 'z' || p === folded));
      // A photo not among the selected: just it.
      g().select(folded);
      expect(menuTargets('z')).toEqual(['z']);
    });

    it("H on a folded stack's face selects the stack's new face, not the photo after the stack", async () => {
      // By name: the burst a, b sorts first, then z. The face is a (the keeper or the first).
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), ...photos('z')], null, { stacked: true });
      const face = selectVisible(g())[0].path;
      const other = face === 'a' ? 'b' : 'a';
      g().select(face);
      serve();
      await g().toggleFlag('hidden');
      expect(g().selected).toBe(other);
      expect(selectVisible(g()).map((i) => i.path)).toEqual([other, 'z']);
    });

    it("H on a stack's face whose new face sorts elsewhere still selects the new face", async () => {
      // Starred b is the face; hiding it makes the keeper the face, wherever it sorts.
      setup([burst('a', '2026-01-01T10:00:00'), { ...burst('m', '2026-01-01T10:00:01'), info: { star: true } }, ...photos('c')], 'm', { stacked: true });
      expect(selectVisible(g()).map((i) => i.path)).toEqual(['c', 'm']);
      serve();
      await g().toggleFlag('hidden');
      expect(selectVisible(g()).map((i) => i.path)).toEqual(['a', 'c']);
      expect(g().selected).toBe('a');
    });

    it('folding an open stack while a member is selected selects its face', () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), ...photos('z')], null, { stacked: true });
      const [info] = [...selectStackInfo(g()).values()];
      const face = selectVisible(g())[0].path;
      g().toggleStack(info.id);
      const member = selectVisible(g()).find((i) => selectStackInfo(g()).get(i.path)?.top === false)!.path;
      g().select(member);
      g().toggleStack(info.id);
      expect(g().selected).toBe(face);
    });

    it('a filter that leaves out the selected photo moves the selection on', () => {
      setup([item({ path: 'a', fileName: 'a.jpg' }), item({ path: 'b', fileName: 'b.jpg', info: { star: true } }), item({ path: 'c', fileName: 'c.jpg' })], 'a');
      g().setFilter({ starred: 'yes' });
      expect(g().selected).toBe('b');
      expect(g().selection).toEqual(['b']);
      // b leaves: a is now in its place.
      g().setFilter({ starred: 'no' });
      expect(g().selected).toBe('a');
      g().clearFilter();
      expect(g().selected).toBe('a');
    });

    it('hiding one photo does not work the facts out again (only a star, a date or an analysis does)', async () => {
      setup([burst('a', '2026-01-01T10:00:00'), burst('b', '2026-01-01T10:00:01'), ...photos('z')], 'z', { stacked: true });
      const facts = selectFacts(g());
      serve();
      await g().toggleFlag('hidden');
      expect(selectFacts(g())).toBe(facts);
      await g().saveInfo('a', { description: 'x' });
      expect(selectFacts(g())).toBe(facts);
      await g().toggleFlag('star');
      expect(selectFacts(g())).not.toBe(facts);
    });

    it("view starts on the grid and stays on the map across folders", () => {
      expect(g().view).toBe('grid');
      g().setView('map');
      expect(g().view).toBe('map');
      g().close();
      expect(g().view).toBe('map');
      g().setView('grid');
      expect(g().view).toBe('grid');
    });

    it('removeItems drops the photos and moves the selection', () => {
      setup(photos('a', 'b', 'c'), 'b', { selection: ['a', 'b'] });
      g().removeItems(['a', 'b']);
      expect(g().items.map((i) => i.path)).toEqual(['c']);
      expect(g().selected).toBe('c');
      expect(g().selection).toEqual(['c']);
    });

    it('opening a folder selects the first photo', async () => {
      routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j1' } });
      routes['GET /api/gallery/recent'] = () => ({ json: [] });
      routes['GET /api/gallery/jobs/j1'] = () => ({ json: { total: 2, processed: 2, startedAt: 0, done: true, errors: [], items: photos('b', 'a') } });
      routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: 's' } });
      routes['GET /api/gallery/items'] = () => ({ json: photos('b', 'a') });
      useGallery.setState({ sort: 'name', filter: {}, stacked: false });
      await g().open('D:\Trip', true);
      expect(g().selected).toBe('a');
      expect(g().selection).toEqual(['a']);
    });
  });
});

describe('gallery store: edits', () => {
  const g = () => useGallery.getState();
  const A = 'D:\\Trip\\a.jpg';
  const cropped = { rotate: 0 as const, straighten: 0, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
  const turned = { rotate: 270 as const, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };

  it('starts with nothing being edited, nothing unsaved, edits kept in the info file', () => {
    expect(g().editing).toBeNull();
    expect(g().pendingEdits).toEqual({});
    expect(g().editTarget).toBe('info');
  });

  it('Done with a change keeps it as an unsaved edit; the shown edit is that one', () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()] });
    g().startEdit(A);
    expect(g().editing).toBe(A);
    g().finishEdit(cropped);
    expect(g().editing).toBeNull();
    expect(g().pendingEdits).toEqual({ [A]: cropped });
    expect(shownEdit(g(), g().items[0])).toEqual(cropped);
  });

  it('Done with no change from the saved edit clears the unsaved edit', () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item({ info: { edit: cropped } })], pendingEdits: { [A]: turned } });
    // The saved edit is what is shown without an unsaved one.
    expect(shownEdit(g(), g().items[0])).toEqual(turned);
    g().startEdit(A);
    g().finishEdit({ ...cropped, crop: { ...cropped.crop } });
    expect(g().pendingEdits).toEqual({});
    expect(shownEdit(g(), g().items[0])).toEqual(cropped);
  });

  it('Done with no edit, where none is saved, clears the unsaved edit; where one is saved, keeps "no edit" unsaved', () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item(), item({ path: 'D:\\Trip\\b.jpg', key: 'k2', info: { edit: cropped } })], pendingEdits: { [A]: cropped } });
    g().startEdit(A);
    g().finishEdit(null);
    expect(g().pendingEdits).toEqual({});
    g().startEdit('D:\\Trip\\b.jpg');
    g().finishEdit(null);
    expect(g().pendingEdits).toEqual({ 'D:\\Trip\\b.jpg': IDENTITY_EDIT });
  });

  it('Cancel leaves the unsaved edits as they were', () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()], pendingEdits: { [A]: cropped } });
    g().startEdit(A);
    g().cancelEdit();
    expect(g().editing).toBeNull();
    expect(g().pendingEdits).toEqual({ [A]: cropped });
  });

  it("discardEdit drops one photo's unsaved edit", () => {
    useGallery.setState({ pendingEdits: { [A]: cropped, b: turned } });
    g().discardEdit(A);
    expect(g().pendingEdits).toEqual({ b: turned });
  });

  it("in photo-file mode the info file's edit is not shown", () => {
    useGallery.setState({ editTarget: 'file' });
    try {
      expect(shownEdit(g(), item({ info: { edit: cropped } }))).toBeNull();
      expect(shownEdit({ ...g(), pendingEdits: { [A]: turned } }, item({ info: { edit: cropped } }))).toEqual(turned);
    } finally {
      useGallery.setState({ editTarget: 'info' });
    }
  });

  it('opening another folder or closing drops the unsaved edits and leaves edit mode', async () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()], pendingEdits: { [A]: cropped }, editing: A });
    g().close();
    expect(g().pendingEdits).toEqual({});
    expect(g().editing).toBeNull();

    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j2' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    routes['GET /api/gallery/jobs/j2'] = () => ({ json: { total: 1, processed: 1, startedAt: 0, done: true, errors: [], items: [item()] } });
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: 's' } });
    routes['GET /api/gallery/items'] = () => ({ json: [item()] });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()], pendingEdits: { [A]: cropped }, editing: A });
    await g().open('D:\\Other', true);
    expect(g().pendingEdits).toEqual({});
    expect(g().editing).toBeNull();
  });
});

describe('gallery store: edit mode follows the selection', () => {
  const g = () => useGallery.getState();
  const A = 'D:\\Trip\\a.jpg';
  const cropped = { rotate: 0 as const, straighten: 0, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
  const turned = { rotate: 270 as const, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
  const two = () => [item(), item({ path: 'b', fileName: 'b.jpg', key: 'k2' })];

  it('selecting another photo leaves edit mode as Done: the edit in progress becomes the unsaved edit', () => {
    useGallery.setState({ items: two(), sort: 'name', filter: {}, stacked: false, selected: 'b', selection: ['b'], anchor: 'b' });
    g().startEdit('b');
    g().clickSelect('b', {});
    expect(g().editing).toBe('b');
    g().setEditDraft(cropped);
    g().clickSelect(A, {});
    expect(g().editing).toBeNull();
    expect(g().pendingEdits).toEqual({ b: cropped });

    g().startEdit(A);
    g().setEditDraft(turned);
    g().select('b');
    expect(g().editing).toBeNull();
    expect(g().pendingEdits).toEqual({ b: cropped, [A]: turned });
  });

  it('as with Done, an edit in progress equal to the saved state leaves nothing unsaved', () => {
    useGallery.setState({ items: two(), sort: 'name', filter: {}, stacked: false, selected: A, selection: [A], anchor: A, pendingEdits: { [A]: cropped } });
    g().startEdit(A);
    g().setEditDraft(null);
    g().select('b');
    expect(g().pendingEdits).toEqual({});
  });

  it('without a reported edit in progress the unsaved edits stay as they were', () => {
    useGallery.setState({ items: two(), sort: 'name', filter: {}, stacked: false, selected: A, selection: [A], anchor: A, pendingEdits: { [A]: cropped } });
    g().startEdit(A);
    g().select('b');
    expect(g().editing).toBeNull();
    expect(g().pendingEdits).toEqual({ [A]: cropped });
  });

  it('an edit in progress reported for another photo, or after Cancel, is not applied', () => {
    useGallery.setState({ items: two(), sort: 'name', filter: {}, stacked: false, selected: A, selection: [A], anchor: A });
    g().startEdit(A);
    g().setEditDraft(cropped);
    g().cancelEdit();
    g().select('b');
    expect(g().pendingEdits).toEqual({});
  });

  it("a deleted photo's edit in progress goes with it", () => {
    useGallery.setState({ items: two(), sort: 'name', filter: {}, stacked: false, selected: A, selection: [A], anchor: A });
    g().startEdit(A);
    g().setEditDraft(cropped);
    g().removeItems([A]);
    expect(g().selected).toBe('b');
    expect(g().editing).toBeNull();
    expect(g().pendingEdits).toEqual({});
  });
});

describe('gallery store: saving edits', () => {
  const g = () => useGallery.getState();
  const A = 'D:\\Trip\\a.jpg';
  const B = 'D:\\Trip\\b.jpg';
  const H = 'D:\\Trip\\c.heic';
  const cropped = { rotate: 0 as const, straighten: 0, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
  const turned = { rotate: 270 as const, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
  const items = () => [item(), item({ path: B, fileName: 'b.jpg', key: 'k2' }), item({ path: H, fileName: 'c.heic', key: 'k3', format: 'heif' })];
  let disconnect: (() => void) | null = null;
  /** The desktop app, faked: the store reaches it through connectDesktop. */
  function desktopWith(api: Record<string, unknown>) {
    disconnect = connectDesktop(api);
  }
  /** The server saves whatever patch it is sent into the photo's info. */
  function echoInfo() {
    routes['PATCH /api/gallery/info'] = (body) => {
      const { path, patch } = body as { path: string; patch: Record<string, unknown> };
      const old = g().items.find((i) => i.path === path)!;
      const info = { ...old.info };
      for (const [k, v] of Object.entries(patch)) if (v === null) delete info[k]; else info[k] = v;
      return { json: { ...old, info } };
    };
  }
  const patches = () => calls.filter((c) => c.method === 'PATCH').map((c) => c.body);

  afterEach(() => {
    disconnect?.();
    disconnect = null;
    useGallery.setState({ editTarget: 'info' });
  });

  it('info-file mode: Save writes the edit into the photo info and the unsaved edit goes', async () => {
    echoInfo();
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), pendingEdits: { [A]: cropped, [B]: turned } });
    expect(await g().saveEdit(A)).toBe(true);
    expect(patches()).toEqual([{ path: A, patch: { edit: cropped }, job: 'j1' }]);
    expect(g().pendingEdits).toEqual({ [B]: turned });
    expect(g().items[0].info.edit).toEqual(cropped);
    expect(shownEdit(g(), g().items[0])).toEqual(cropped);
  });

  it('info-file mode: saving "no edit" removes the field', async () => {
    echoInfo();
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item({ info: { edit: cropped, star: true } })], pendingEdits: { [A]: IDENTITY_EDIT } });
    expect(await g().saveEdit(A)).toBe(true);
    expect(patches()).toEqual([{ path: A, patch: { edit: null }, job: 'j1' }]);
    expect(g().items[0].info).toEqual({ star: true });
    expect(g().pendingEdits).toEqual({});
  });

  it('info-file mode: a refused save keeps the unsaved edit and shows the error', async () => {
    routes['PATCH /api/gallery/info'] = () => ({ status: 409, json: { error: 'photoinfo.json is in use' } });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), pendingEdits: { [A]: cropped } });
    expect(await g().saveEdit(A)).toBe(false);
    expect(g().pendingEdits).toEqual({ [A]: cropped });
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'photoinfo.json is in use' })]);
  });

  it('an edit changed again while its save was on its way stays unsaved', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    routes['PATCH /api/gallery/info'] = async () => {
      await held;
      return { json: item({ info: { edit: cropped } }) };
    };
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), pendingEdits: { [A]: cropped } });
    const saving = g().saveEdit(A);
    useGallery.setState({ pendingEdits: { [A]: turned } });
    release();
    expect(await saving).toBe(true);
    expect(g().pendingEdits).toEqual({ [A]: turned });
  });

  it('photo-file mode: Save hands the edit to the desktop app and takes the photo it read again', async () => {
    const reread = item({ size: 2222, key: 'k-new', width: 150, height: 150 });
    const saveEditToFile = vi.fn(async () => ({ ok: true, item: reread }));
    desktopWith({ saveEditToFile });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), editTarget: 'file', pendingEdits: { [A]: cropped } });
    expect(await g().saveEdit(A)).toBe(true);
    expect(saveEditToFile).toHaveBeenCalledWith(A, cropped);
    expect(patches()).toEqual([]);
    expect(g().items[0]).toEqual(reread);
    expect(g().pendingEdits).toEqual({});
  });

  it('photo-file mode: a failed save keeps the unsaved edit and shows the error', async () => {
    desktopWith({ saveEditToFile: async () => ({ ok: false, error: "Couldn't move the original to the Recycle Bin." }) });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), editTarget: 'file', pendingEdits: { [A]: cropped } });
    expect(await g().saveEdit(A)).toBe(false);
    expect(g().pendingEdits).toEqual({ [A]: cropped });
    expect(g().items[0]).toEqual(items()[0]);
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: "Couldn't move the original to the Recycle Bin." })]);
  });

  it('photo-file mode: a file replaced although a later step failed drops the unsaved edit and reloads the photos', async () => {
    const reread = item({ size: 3333, key: 'k-new' });
    routes['GET /api/gallery/items'] = () => ({ json: [reread, items()[1], items()[2]] });
    desktopWith({ saveEditToFile: async () => ({ ok: false, saved: true, error: "Saved, but couldn't read the photo again." }) });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), editTarget: 'file', pendingEdits: { [A]: cropped } });
    await g().saveEdit(A);
    expect(g().pendingEdits).toEqual({});
    expect(count('GET', '/api/gallery/items')).toBe(1);
    expect(g().items[0]).toEqual(reread);
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: "Saved, but couldn't read the photo again." })]);
  });

  it('photo-file mode: a HEIC photo is not saved over (only as a copy)', async () => {
    const saveEditToFile = vi.fn();
    desktopWith({ saveEditToFile });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), editTarget: 'file', pendingEdits: { [H]: cropped } });
    expect(await g().saveEdit(H)).toBe(false);
    expect(saveEditToFile).not.toHaveBeenCalled();
    expect(g().pendingEdits).toEqual({ [H]: cropped });
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'HEIC photos can only be saved as a copy' })]);
  });

  it('Save all saves each photo one after another, then says so once', async () => {
    echoInfo();
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), pendingEdits: { [A]: cropped, [B]: turned } });
    await g().saveAllEdits();
    expect(patches().map((p) => (p as { path: string }).path)).toEqual([A, B]);
    expect(g().pendingEdits).toEqual({});
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'success', text: 'Saved 2 photos' })]);
  });

  it('Save all with failures: one toast naming them; their unsaved edits stay', async () => {
    routes['PATCH /api/gallery/info'] = (body) => {
      const { path, patch } = body as { path: string; patch: Record<string, unknown> };
      if (path !== A) return { status: 409, json: { error: 'in use' } };
      return { json: item({ info: patch }) };
    };
    const more = [...items(), item({ path: 'D:\\Trip\\d.jpg', fileName: 'd.jpg', key: 'k4' }), item({ path: 'D:\\Trip\\e.jpg', fileName: 'e.jpg', key: 'k5' }), item({ path: 'D:\\Trip\\f.jpg', fileName: 'f.jpg', key: 'k6' })];
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: more, pendingEdits: { [A]: cropped, [B]: turned, 'D:\\Trip\\d.jpg': turned, 'D:\\Trip\\e.jpg': turned, 'D:\\Trip\\f.jpg': turned } });
    await g().saveAllEdits();
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'Saved 1, 4 failed: b.jpg, d.jpg, e.jpg…' })]);
    expect(Object.keys(g().pendingEdits)).toEqual([B, 'D:\\Trip\\d.jpg', 'D:\\Trip\\e.jpg', 'D:\\Trip\\f.jpg']);
  });

  it('Save all in photo-file mode skips HEIC photos and names them', async () => {
    const saveEditToFile = vi.fn(async (path: string) => ({ ok: true, item: items().find((i) => i.path === path) }));
    desktopWith({ saveEditToFile });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), editTarget: 'file', pendingEdits: { [A]: cropped, [H]: turned } });
    await g().saveAllEdits();
    expect(saveEditToFile.mock.calls.map((c) => c[0])).toEqual([A]);
    expect(g().pendingEdits).toEqual({ [H]: turned });
    expect(g().toasts).toEqual([expect.objectContaining({ text: 'Saved 1 photo. Skipped c.heic: HEIC photos can only be saved as a copy' })]);
  });

  it('Save as hands the edit and the info to the desktop app; the unsaved edit stays; a copy in the folder joins the grid', async () => {
    const copy = item({ path: 'D:\\Trip\\a-edited.jpg', fileName: 'a-edited.jpg', key: 'k-copy', info: { star: true } });
    const saveEditAs = vi.fn(async () => ({ ok: true, savedPath: copy.path, item: copy }));
    desktopWith({ saveEditAs });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item({ info: { star: true, notes: 'n' } })], pendingEdits: { [A]: cropped } });
    expect(await g().saveEditAs(A)).toBe(true);
    expect(saveEditAs).toHaveBeenCalledWith(A, cropped, { star: true, notes: 'n' });
    expect(g().pendingEdits).toEqual({ [A]: cropped });
    expect(g().items.map((i) => i.path)).toEqual([A, copy.path]);
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'success', text: 'Saved a copy as a-edited.jpg' })]);
  });

  it('Save as: cancelled does nothing; an error is shown; no desktop app, no Save as', async () => {
    desktopWith({ saveEditAs: async () => ({ ok: false, cancelled: true }) });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()], pendingEdits: { [A]: cropped } });
    expect(await g().saveEditAs(A)).toBe(false);
    expect(g().toasts).toEqual([]);
    disconnect!();
    desktopWith({ saveEditAs: async () => ({ ok: false, error: 'That is the original.' }) });
    expect(await g().saveEditAs(A)).toBe(false);
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'That is the original.' })]);
    disconnect!();
    disconnect = null;
    useGallery.setState({ toasts: [] });
    expect(await g().saveEditAs(A)).toBe(false);
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'Save as needs the desktop app' })]);
    expect(g().pendingEdits).toEqual({ [A]: cropped });
  });

  it('Revert to original removes the saved edit from the photo info', async () => {
    echoInfo();
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item({ info: { edit: cropped } })] });
    expect(await g().revertEdit(A)).toBe(true);
    expect(patches()).toEqual([{ path: A, patch: { edit: null }, job: 'j1' }]);
    expect(g().items[0].info.edit).toBeUndefined();
  });

  it('tells the desktop app how many photos have unsaved edits, whenever that changes', () => {
    const setUnsavedEdits = vi.fn();
    desktopWith({ setUnsavedEdits });
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(0);
    useGallery.setState({ pendingEdits: { [A]: cropped, [B]: turned } });
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(2);
    g().discardEdit(A);
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(1);
    g().close();
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(0);
  });

  it('leaving the page asks first only while there are unsaved edits', () => {
    const e = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    guardUnload(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    useGallery.setState({ pendingEdits: { [A]: cropped } });
    guardUnload(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.returnValue).toBe('');
  });

  it('loads where edits go at startup; a plain browser always keeps them in the info file', async () => {
    desktopWith({ getEditTarget: async () => 'file', setEditTarget: async () => {}, saveEditToFile: async () => ({ ok: true }) });
    await g().loadEditTarget();
    expect(g().editTarget).toBe('file');
    disconnect!();
    disconnect = null;
    vi.stubGlobal('localStorage', { getItem: () => 'file', setItem: () => {} });
    await g().loadEditTarget();
    expect(g().editTarget).toBe('info');
    await g().setEditTarget('file');
    expect(g().editTarget).toBe('info');
  });

  it('no edit can start on a photo while its save is on its way; a later change that slipped in is named', async () => {
    let release!: (v: { ok: boolean; item: unknown }) => void;
    desktopWith({ saveEditToFile: () => new Promise((r) => (release = r)) });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), editTarget: 'file', pendingEdits: { [A]: cropped }, selected: A, selection: [A] });
    const saving = g().saveEdit(A);
    expect(g().savingPaths).toEqual([A]);
    g().startEdit(A);
    expect(g().editing).toBeNull();
    // Another photo can still be edited.
    g().startEdit(B);
    expect(g().editing).toBe(B);
    g().cancelEdit();
    // A change that reached the photo anyway (here set directly) is dropped with the written one, and said.
    useGallery.setState({ pendingEdits: { [A]: turned } });
    release({ ok: true, item: items()[0] });
    expect(await saving).toBe(true);
    expect(g().savingPaths).toEqual([]);
    expect(g().pendingEdits).toEqual({});
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'A later change to a.jpg was not saved' })]);
    g().startEdit(A);
    expect(g().editing).toBe(A);
  });

  it('a save already on its way for a photo is not sent twice', async () => {
    let release!: (v: { ok: boolean; item: unknown }) => void;
    const saveEditToFile = vi.fn(() => new Promise((r) => (release = r)));
    desktopWith({ saveEditToFile });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), editTarget: 'file', pendingEdits: { [A]: cropped } });
    const first = g().saveEdit(A);
    expect(await g().saveEdit(A)).toBe(false);
    const all = g().saveAllEdits();
    release({ ok: true, item: items()[0] });
    await first;
    await all;
    expect(saveEditToFile).toHaveBeenCalledTimes(1);
  });

  it('photo-file mode: "no edit" over an edit saved in the info file removes that edit from the info file', async () => {
    echoInfo();
    const saveEditToFile = vi.fn();
    desktopWith({ saveEditToFile });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item({ info: { edit: cropped } })], editTarget: 'file', pendingEdits: { [A]: IDENTITY_EDIT } });
    expect(await g().saveEdit(A)).toBe(true);
    expect(saveEditToFile).not.toHaveBeenCalled();
    expect(patches()).toEqual([{ path: A, patch: { edit: null }, job: 'j1' }]);
    expect(g().pendingEdits).toEqual({});
  });

  it('Save all cut short by another folder still says what was saved', async () => {
    let n = 0;
    desktopWith({
      saveEditToFile: async (path: string) => {
        // The folder changes while the first photo is saved.
        if (n++ === 0) g().close();
        return { ok: true, item: items().find((i) => i.path === path) };
      },
    });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), editTarget: 'file', pendingEdits: { [A]: cropped, [B]: turned } });
    await g().saveAllEdits();
    expect(n).toBe(1);
    expect(g().toasts).toEqual([expect.objectContaining({ text: 'Saved 1 photo' })]);
  });

  it('Save as with nothing to save says so', async () => {
    desktopWith({ saveEditAs: vi.fn() });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()] });
    expect(await g().saveEditAs(A)).toBe(false);
    expect(g().toasts).toEqual([expect.objectContaining({ kind: 'error', text: 'a.jpg has no edit to save as a copy' })]);
  });

  it('an edit in progress that changed something counts as one unsaved photo', () => {
    const setUnsavedEdits = vi.fn();
    desktopWith({ setUnsavedEdits });
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: items(), selected: A, selection: [A] });
    const e = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    g().startEdit(A);
    g().setEditDraft(null);
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(0);
    g().setEditDraft(cropped);
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(1);
    guardUnload(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    // Back to where it started: nothing unsaved.
    g().setEditDraft(null);
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(0);
    // A photo with an unsaved edit already is counted once.
    useGallery.setState({ pendingEdits: { [A]: turned } });
    g().setEditDraft(cropped);
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(1);
    g().cancelEdit();
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(1);
    g().discardEdit(A);
    expect(setUnsavedEdits).toHaveBeenLastCalledWith(0);
  });

  it('Settings open is kept in the store', () => {
    expect(g().settingsOpen).toBe(false);
    g().setSettingsOpen(true);
    expect(g().settingsOpen).toBe(true);
    g().setSettingsOpen(false);
  });

  it('setEditTarget saves the choice through the desktop app at once', async () => {
    const setEditTarget = vi.fn(async () => {});
    desktopWith({ setEditTarget, saveEditToFile: async () => ({ ok: true }) });
    await g().setEditTarget('file');
    expect(g().editTarget).toBe('file');
    expect(setEditTarget).toHaveBeenCalledWith('file');
  });
});

describe('gallery store: leaving a folder with unsaved edits', () => {
  const g = () => useGallery.getState();
  const A = 'D:\\Trip\\a.jpg';
  const cropped = { rotate: 0 as const, straighten: 0, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };

  function routesForOther() {
    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j2' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    routes['GET /api/gallery/jobs/j2'] = () => ({ json: { total: 1, processed: 1, startedAt: 0, done: true, errors: [], items: [item()] } });
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: 's' } });
    routes['GET /api/gallery/items'] = () => ({ json: [item()] });
  }

  it('with nothing unsaved, opening and closing go ahead at once', async () => {
    routesForOther();
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()] });
    await g().requestOpen('D:\\Other', false);
    expect(g().root).toBe('D:\\Other');
    expect(g().leaving).toBeNull();
    g().requestClose();
    expect(g().root).toBeNull();
  });

  it('with unsaved edits, opening asks first; Cancel keeps the folder and its edits', async () => {
    routesForOther();
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()], pendingEdits: { [A]: cropped } });
    await g().requestOpen('D:\\Other', false);
    expect(g().root).toBe('D:\\Trip');
    expect(g().leaving).toEqual({ folder: 'D:\\Other', recursive: false });
    g().cancelLeave();
    expect(g().leaving).toBeNull();
    expect(g().root).toBe('D:\\Trip');
    expect(g().pendingEdits).toEqual({ [A]: cropped });
    expect(count('POST', '/api/gallery/open')).toBe(0);

    await g().requestOpen('D:\\Other', false);
    await g().confirmLeave();
    expect(g().leaving).toBeNull();
    expect(g().root).toBe('D:\\Other');
    expect(g().pendingEdits).toEqual({});
  });

  it('with unsaved edits, closing asks first', async () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()], pendingEdits: { [A]: cropped } });
    g().requestClose();
    expect(g().root).toBe('D:\\Trip');
    expect(g().leaving).toBe('close');
    await g().confirmLeave();
    expect(g().root).toBeNull();
    expect(g().leaving).toBeNull();
  });

  it('an edit in progress counts: it becomes an unsaved edit first', async () => {
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()], selected: A, selection: [A] });
    g().startEdit(A);
    g().setEditDraft(cropped);
    g().requestClose();
    expect(g().editing).toBeNull();
    expect(g().pendingEdits).toEqual({ [A]: cropped });
    expect(g().leaving).toBe('close');
  });

  it('a folder handed over by the desktop app asks first too', () => {
    let deliver: (folder: string) => void = () => {};
    const stop = connectDesktop({ onOpenFolder: (cb: (f: string) => void) => ((deliver = cb), () => {}) });
    try {
      useGallery.setState({ job: 'j1', root: 'D:\\Trip', items: [item()], pendingEdits: { [A]: cropped }, recursive: true });
      deliver('D:\\Other');
      expect(g().leaving).toEqual({ folder: 'D:\\Other', recursive: true });
      expect(g().root).toBe('D:\\Trip');
    } finally {
      g().cancelLeave();
      stop();
    }
  });
});

describe('gallery store: deleted photos', () => {
  it("removeItems drops a deleted photo's unsaved edit", () => {
    const e = { rotate: 90 as const, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
    useGallery.setState({ items: [item(), item({ path: 'b', key: 'k2' })], pendingEdits: { b: e, c: e } });
    useGallery.getState().removeItems(['b']);
    expect(useGallery.getState().pendingEdits).toEqual({ c: e });
  });
});

describe('gallery store: score nudges and undo', () => {
  const g = () => useGallery.getState();
  const photos = (...names: string[]) => names.map((n) => item({ path: n, fileName: `${n}.jpg`, key: n }));
  const setup = (items: GalleryItem[], selected: string | null, extra: Record<string, unknown> = {}) =>
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items, sort: 'name', filter: {}, stacked: false, openStacks: [], view: 'grid', selected, selection: selected ? [selected] : [], anchor: selected, ...extra });
  /** A server that applies each patch to the photo (as it has it) and answers with it; `hold` keeps replies back until released. */
  const serve = (opts: { hold?: boolean; fail?: boolean } = {}) => {
    const saved: { path: string; patch: Record<string, unknown> }[] = [];
    const server = new Map<string, Record<string, unknown>>();
    const waiting: (() => void)[] = [];
    routes['PATCH /api/gallery/info'] = async (body) => {
      const b = body as { path: string; patch: Record<string, unknown> };
      saved.push({ path: b.path, patch: b.patch });
      if (opts.fail) return { status: 409, json: { error: 'in use' } };
      if (opts.hold) await new Promise<void>((r) => waiting.push(r));
      const old = g().items.find((i) => i.path === b.path)!;
      const info = { ...(server.get(b.path) ?? old.info), ...b.patch } as Record<string, unknown>;
      for (const k of Object.keys(info)) if (info[k] === null) delete info[k];
      server.set(b.path, info);
      return { json: { ...old, info } };
    };
    routes['GET /api/gallery/items'] = () => ({ json: g().items });
    return { saved, release: () => waiting.splice(0).forEach((r) => r()) };
  };

  it('Up adds 1 to the selected photo at once, shows a green toast, and saves scoreAdjust', async () => {
    setup(photos('a', 'b'), 'a');
    const { saved } = serve();
    g().nudgeScore(1);
    expect(g().items[0].info.scoreAdjust).toBe(1);
    expect(g().scoreToast).toEqual(expect.objectContaining({ delta: 1, path: 'a', count: 1 }));
    await vi.waitFor(() => expect(saved).toEqual([{ path: 'a', patch: { scoreAdjust: 1 } }]));
    expect(g().items[0].info.scoreAdjust).toBe(1);
  });

  it('a quick run of presses counts from the newest value, not the saved one', async () => {
    setup(photos('a'), 'a');
    const { saved, release } = serve({ hold: true });
    g().nudgeScore(1);
    g().nudgeScore(1);
    g().nudgeScore(1);
    g().nudgeScore(-1);
    expect(g().items[0].info.scoreAdjust).toBe(2);
    for (let n = 0; n < 4; n++) {
      await vi.waitFor(() => expect(saved.length).toBe(n + 1));
      release();
    }
    expect(saved.map((s) => s.patch.scoreAdjust)).toEqual([1, 2, 3, 2]);
    await vi.waitFor(() => expect(count('PATCH', '/api/gallery/info')).toBe(4));
    await vi.waitFor(() => expect(g().items[0].info.scoreAdjust).toBe(2));
  });

  it('back to 0 removes the field; several selected photos are each nudged from their own value', async () => {
    setup([item({ path: 'a', key: 'a', info: { scoreAdjust: 1 } }), item({ path: 'b', key: 'b', info: { scoreAdjust: 5 } })], 'a', { selection: ['a', 'b'] });
    const { saved } = serve();
    g().nudgeScore(-1);
    expect(g().scoreToast).toEqual(expect.objectContaining({ delta: -1, count: 2 }));
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    expect(saved).toEqual([{ path: 'a', patch: { scoreAdjust: null } }, { path: 'b', patch: { scoreAdjust: 4 } }]);
    expect('scoreAdjust' in g().items[0].info).toBe(false);
  });

  it('the toast goes by itself', async () => {
    vi.useFakeTimers();
    setup(photos('a'), 'a');
    serve();
    g().nudgeScore(1);
    expect(g().scoreToast).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(g().scoreToast).toBeNull();
  });

  it('a nudge the server refuses reloads the photo info', async () => {
    setup(photos('a'), 'a');
    serve({ fail: true });
    g().nudgeScore(1);
    await vi.waitFor(() => expect(count('GET', '/api/gallery/items')).toBe(1));
  });

  it('Ctrl+Z undoes nudges one at a time, newest first, and says so', async () => {
    setup(photos('a'), 'a');
    const { saved } = serve();
    g().nudgeScore(1);
    g().nudgeScore(1);
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    await g().undo();
    expect(g().items[0].info.scoreAdjust).toBe(1);
    await g().undo();
    expect('scoreAdjust' in g().items[0].info).toBe(false);
    await vi.waitFor(() => expect(saved.map((s) => s.patch.scoreAdjust)).toEqual([1, 2, 1, null]));
    expect(g().toasts.map((t) => t.text)).toEqual(['Undid: score', 'Undid: score']);
    await g().undo();
    expect(g().toasts.at(-1)?.text).toBe('Nothing to undo');
  });

  it('undoes a hide: the photo comes back, selected again', async () => {
    setup(photos('a', 'b', 'c'), 'b');
    const { saved } = serve();
    await g().toggleFlag('hidden');
    expect(g().selected).toBe('c');
    await g().undo();
    expect(saved.at(-1)).toEqual({ path: 'b', patch: { hidden: null } });
    expect(g().items[1].info.hidden).toBeUndefined();
    expect(g().selected).toBe('b');
  });

  it('undoes a favourite of several photos in one step, each as it was', async () => {
    setup([item({ path: 'a', key: 'a' }), item({ path: 'b', key: 'b', info: { star: true } }), item({ path: 'c', key: 'c' })], 'a', { selection: ['a', 'b', 'c'] });
    const { saved } = serve();
    await g().toggleFlag('star');
    expect(g().undoStack).toHaveLength(1);
    await g().undo();
    expect(saved.slice(-2)).toEqual([{ path: 'a', patch: { star: null } }, { path: 'c', patch: { star: null } }]);
    expect(g().items.map((i) => i.info.star ?? null)).toEqual([null, true, null]);
    expect(g().toasts.at(-1)?.text).toBe('Undid: favourite');
  });

  it('undoes a field typed in the details panel, and a revert to original', async () => {
    const cropped = { rotate: 0 as const, straighten: 0, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
    setup([item({ path: 'a', key: 'a', info: { description: 'old', edit: cropped } })], 'a');
    const { saved } = serve();
    await g().saveInfo('a', { description: 'new' });
    await g().revertEdit('a');
    await g().undo();
    expect(saved.at(-1)).toEqual({ path: 'a', patch: { edit: cropped } });
    expect(g().toasts.at(-1)?.text).toBe('Undid: revert to original');
    await g().undo();
    expect(saved.at(-1)).toEqual({ path: 'a', patch: { description: 'old' } });
    expect(g().items[0].info.description).toBe('old');
  });

  it('a save that changes nothing, or fails, is not recorded', async () => {
    setup([item({ path: 'a', key: 'a', info: { star: true } })], 'a');
    serve();
    await g().setStar('a', true);
    expect(g().undoStack).toEqual([]);
    serve({ fail: true });
    await g().setStar('a', false);
    expect(g().undoStack).toEqual([]);
  });

  it('undoes Done in edit mode: the unsaved edit goes back to what it was', async () => {
    const cropped = { rotate: 0 as const, straighten: 0, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
    setup(photos('a'), 'a');
    serve();
    g().startEdit('a');
    g().finishEdit(cropped);
    expect(g().pendingEdits).toEqual({ a: cropped });
    await g().undo();
    expect(g().pendingEdits).toEqual({});
    expect(g().toasts.at(-1)?.text).toBe('Undid: crop and rotate');
  });

  it('does nothing while a photo is being edited; closing the folder forgets the changes', async () => {
    setup(photos('a'), 'a');
    const { saved } = serve();
    g().nudgeScore(1);
    g().startEdit('a');
    await g().undo();
    expect(g().undoStack).toHaveLength(1);
    g().cancelEdit();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    g().close();
    expect(g().undoStack).toEqual([]);
  });

  it('keeps at most 100 changes', async () => {
    setup(photos('a'), 'a');
    serve();
    for (let n = 0; n < 105; n++) g().nudgeScore(1);
    expect(g().undoStack).toHaveLength(100);
    await vi.waitFor(() => expect(count('PATCH', '/api/gallery/info')).toBe(105));
  });
});

describe('gallery store: undo while saves are on their way, and after saving into the file', () => {
  const g = () => useGallery.getState();
  const photos = (...names: string[]) => names.map((n) => item({ path: n, fileName: `${n}.jpg`, key: n }));
  const setup = (items: GalleryItem[], selected: string | null) =>
    useGallery.setState({ job: 'j1', root: 'D:\\Trip', items, sort: 'name', filter: {}, stacked: false, openStacks: [], view: 'grid', selected, selection: selected ? [selected] : [], anchor: selected });
  /** Replies held until released, one at a time, in order. */
  const heldServer = () => {
    const saved: { path: string; patch: Record<string, unknown> }[] = [];
    const server = new Map<string, Record<string, unknown>>();
    const waiting: (() => void)[] = [];
    routes['PATCH /api/gallery/info'] = async (body) => {
      const b = body as { path: string; patch: Record<string, unknown> };
      saved.push({ path: b.path, patch: b.patch });
      await new Promise<void>((r) => waiting.push(r));
      const old = g().items.find((i) => i.path === b.path)!;
      const info = { ...(server.get(b.path) ?? old.info), ...b.patch } as Record<string, unknown>;
      for (const k of Object.keys(info)) if (info[k] === null) delete info[k];
      server.set(b.path, info);
      return { json: { ...old, info } };
    };
    const releaseAll = async () => {
      for (let n = 0; n < 20; n++) {
        waiting.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    return { saved, releaseAll };
  };

  it('H then Ctrl+Z before the server replies takes back the hide, not the change before it', async () => {
    setup(photos('a', 'b'), 'a');
    const { saved, releaseAll } = heldServer();
    g().nudgeScore(1);
    const hiding = g().toggleFlag('hidden');
    expect(g().undoStack.map((st) => st.label)).toEqual(['score', 'hide']);
    const undoing = g().undo();
    await releaseAll();
    await hiding;
    await undoing;
    expect(saved.map((s) => s.patch)).toEqual([{ scoreAdjust: 1 }, { hidden: true }, { hidden: null }]);
    expect(g().items[0].info).toEqual({ scoreAdjust: 1 });
    expect(g().undoStack.map((st) => st.label)).toEqual(['score']);
  });

  it('two quick clicks on a star make one undo step, not two', async () => {
    setup(photos('a'), 'a');
    const { releaseAll } = heldServer();
    const one = g().setStar('a', true);
    const two = g().setStar('a', true);
    await releaseAll();
    await Promise.all([one, two]);
    expect(g().undoStack).toHaveLength(1);
  });

  it('H pressed twice quickly hides, then shows again (it counts from what was sent)', async () => {
    setup(photos('a', 'b'), 'a');
    const { saved, releaseAll } = heldServer();
    useGallery.setState({ filter: { hidden: 'show' } });
    const one = g().toggleFlag('hidden');
    const two = g().toggleFlag('hidden');
    await releaseAll();
    await Promise.all([one, two]);
    expect(saved.map((s) => s.patch)).toEqual([{ hidden: true }, { hidden: null }]);
  });

  it('a hide the server refuses is not left on the undo stack', async () => {
    setup(photos('a', 'b'), 'a');
    routes['PATCH /api/gallery/info'] = () => ({ status: 409, json: { error: 'in use' } });
    await g().toggleFlag('hidden');
    expect(g().undoStack).toEqual([]);
  });

  it('after Save into the photo file, Ctrl+Z does not put an older crop back over it', async () => {
    const cropped = { rotate: 0 as const, straighten: 0, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
    const turned = { rotate: 270 as const, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
    const stop = connectDesktop({ saveEditToFile: async () => ({ ok: true, item: item({ path: 'a', key: 'a2' }) }) });
    try {
      setup(photos('a'), 'a');
      useGallery.setState({ editTarget: 'file', pendingEdits: { a: cropped } });
      g().startEdit('a');
      g().finishEdit(turned);
      expect(g().undoStack).toHaveLength(1);
      expect(await g().saveEdit('a')).toBe(true);
      expect(g().undoStack).toEqual([]);
      await g().undo();
      expect(g().pendingEdits).toEqual({});
      expect(g().toasts.at(-1)?.text).toBe('Nothing to undo');
    } finally {
      stop();
      useGallery.setState({ editTarget: 'info' });
    }
  });

  it('undoing a change to a photo that has since gone says so and changes nothing', async () => {
    setup(photos('a', 'b'), 'a');
    routes['PATCH /api/gallery/info'] = (body) => ({ json: { ...g().items[0], info: (body as { patch: Record<string, unknown> }).patch } });
    await g().setStar('a', true);
    g().removeItems(['a']);
    await g().undo();
    expect(count('PATCH', '/api/gallery/info')).toBe(1);
    expect(g().toasts.at(-1)?.text).toBe("Couldn't undo favourite: the photo is no longer in the folder");
  });
});

describe('gallery store: sort by photo score', () => {
  it('puts the highest score first; a favourite jumps up, a nudge moves it', () => {
    const a = item({ path: 'a', fileName: 'a.jpg', key: 'a' });
    const b = item({ path: 'b', fileName: 'b.jpg', key: 'b', info: { star: true } });
    const c = item({ path: 'c', fileName: 'c.jpg', key: 'c', info: { scoreAdjust: 1 } });
    const state = { items: [a, b, c], sort: 'score' as const, filter: {}, stacked: false };
    expect(selectVisible(state).map((i) => i.path)).toEqual(['b', 'c', 'a']);
    const nudged = { ...state, items: [{ ...a, info: { scoreAdjust: 2 } }, b, c] };
    expect(selectVisible(nudged).map((i) => i.path)).toEqual(['b', 'a', 'c']);
  });
});

describe('gallery store: photo tagging', () => {
  const status = (over: Record<string, unknown> = {}) => ({ job: 'j1', total: 2, done: 0, failed: 0, paused: false, running: true, notWorking: [], stamp: 0, ...over });

  async function openTagged(reply: () => ReturnType<typeof status>) {
    routes['POST /api/gallery/open'] = () => ({ status: 202, json: { jobId: 'j1' } });
    routes['GET /api/gallery/recent'] = () => ({ json: [] });
    routes['GET /api/gallery/jobs/j1'] = () => ({
      json: { total: 2, processed: 2, startedAt: 0, done: true, errors: [], items: [item(), item({ path: 'D:\\Trip\\b.jpg', fileName: 'b.jpg', key: 'k2' })] },
    });
    routes['GET /api/gallery/stamp'] = () => ({ json: { stamp: 's' } });
    routes['GET /api/gallery/items'] = () => ({ json: [item(), item({ path: 'D:\\Trip\\b.jpg', fileName: 'b.jpg', key: 'k2' })] });
    routes['GET /api/gallery/tagging/status'] = () => ({ json: reply() });
    routes['POST /api/gallery/tagging/focus'] = () => ({ json: {} });
    await useGallery.getState().open('D:\\Trip', true);
  }

  it('toggleTagFilter adds then removes', () => {
    useGallery.getState().toggleTagFilter({ kind: 'keyword', value: 'lake' });
    useGallery.getState().toggleTagFilter({ kind: 'object', value: 'person' });
    expect(useGallery.getState().filter.tags).toEqual([{ kind: 'keyword', value: 'lake' }, { kind: 'object', value: 'person' }]);
    useGallery.getState().toggleTagFilter({ kind: 'keyword', value: 'lake' });
    expect(useGallery.getState().filter.tags).toEqual([{ kind: 'object', value: 'person' }]);
    useGallery.getState().toggleTagFilter({ kind: 'object', value: 'person' });
    expect(useGallery.getState().filter).toEqual({});
  });

  it('a stamp change reloads the photos, at most every 10 s while tagging runs, and once when it stops', async () => {
    vi.useFakeTimers();
    let stamp = 0;
    let running = true;
    await openTagged(() => status({ stamp, running, done: stamp }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(useGallery.getState().tagging).toEqual(expect.objectContaining({ job: 'j1', running: true }));
    const base = count('GET', '/api/gallery/items');
    // A photo is tagged every 0.5 s for 20 s: two or three reloads, not forty.
    for (let t = 0; t < 40; t++) {
      stamp++;
      await vi.advanceTimersByTimeAsync(500);
    }
    const during = count('GET', '/api/gallery/items') - base;
    expect(during).toBeGreaterThanOrEqual(1);
    expect(during).toBeLessThanOrEqual(3);
    // Done: one more reload brings the last photos' tags in.
    stamp++;
    running = false;
    await vi.advanceTimersByTimeAsync(3100);
    expect(count('GET', '/api/gallery/items') - base).toBe(during + 1);
    expect(useGallery.getState().tagging?.running).toBe(false);
    // Nothing changes after that: no more reloads.
    await vi.advanceTimersByTimeAsync(9100);
    expect(count('GET', '/api/gallery/items') - base).toBe(during + 1);
  });

  it('tagging that finished before the page first looked still brings its tags in (one reload)', async () => {
    vi.useFakeTimers();
    await openTagged(() => status({ running: false, done: 2, stamp: 20 }));
    await vi.advanceTimersByTimeAsync(3200);
    // One reload for the info watch's baseline, one for tagging's new tags; none after.
    expect(count('GET', '/api/gallery/items')).toBe(2);
    await vi.advanceTimersByTimeAsync(9100);
    expect(count('GET', '/api/gallery/items')).toBe(2);
  });

  it('focus posts the selected photo first', async () => {
    vi.useFakeTimers();
    await openTagged(() => status());
    // After tagging's first reload of the photos (a reload starts the half second again).
    await vi.advanceTimersByTimeAsync(1600);
    useGallery.getState().select('D:\\Trip\\b.jpg');
    await vi.advanceTimersByTimeAsync(600);
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/gallery/tagging/focus');
    expect(posts.at(-1)?.body).toEqual({ job: 'j1', paths: ['D:\\Trip\\b.jpg', 'D:\\Trip\\a.jpg'] });
    // Debounced: several quick changes post once.
    const before = posts.length;
    useGallery.getState().select('D:\\Trip\\a.jpg');
    useGallery.getState().select('D:\\Trip\\b.jpg');
    useGallery.getState().select('D:\\Trip\\a.jpg');
    await vi.advanceTimersByTimeAsync(600);
    const after = calls.filter((c) => c.method === 'POST' && c.url === '/api/gallery/tagging/focus');
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.body).toEqual({ job: 'j1', paths: ['D:\\Trip\\a.jpg', 'D:\\Trip\\b.jpg'] });
  });
});

describe('gallery store: search by meaning', () => {
  const on = { state: 'done' as const, description: null, keywords: [], objects: [] };
  const photo = (n: string, over: Partial<GalleryItem> = {}) => item({ path: `D:/Trip/${n}.jpg`, fileName: `${n}.jpg`, key: `k-${n}`, tags: on, ...over });

  it('meaning matches follow the word matches, without repeats; a stale reply is dropped', async () => {
    vi.useFakeTimers();
    const replies = new Map<string, { paths: string[]; delay: number }>([
      ['harbour', { paths: ['D:/Trip/c.jpg', 'D:/Trip/a.jpg', 'D:/Trip/d.jpg'], delay: 0 }],
      ['harb', { paths: ['D:/Trip/d.jpg'], delay: 2000 }],
      ['harbor', { paths: ['D:/Trip/b.jpg'], delay: 0 }],
    ]);
    routes['GET /api/gallery/search'] = () => ({ json: {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push({ method: 'GET', url, body: undefined });
      const q = new URL(url, 'http://x').searchParams.get('q')!;
      const r = replies.get(q)!;
      await new Promise((res) => setTimeout(res, r.delay));
      return new Response(JSON.stringify({ paths: r.paths }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    useGallery.setState({ job: 'j1', root: 'D:/Trip', items: [photo('a', { info: { notes: 'harbour walk' } }), photo('b'), photo('c'), photo('d')], filter: {}, stacked: false });
    const shown = () => selectVisible(useGallery.getState()).map((i) => i.fileName);

    useGallery.getState().setFilter({ text: 'harbour' });
    expect(shown()).toEqual(['a.jpg']);
    expect(selectMeaningStart(useGallery.getState())).toBeNull();
    await vi.advanceTimersByTimeAsync(350);
    // a matched the words already: not repeated; c and d follow in the order of meaning.
    expect(shown()).toEqual(['a.jpg', 'c.jpg', 'd.jpg']);
    expect(selectMeaningStart(useGallery.getState())).toBe(1);

    // "harb" is slow, "harbor" answers first: harb's late reply must not replace it.
    useGallery.getState().setFilter({ text: 'harb' });
    await vi.advanceTimersByTimeAsync(350);
    useGallery.getState().setFilter({ text: 'harbor' });
    await vi.advanceTimersByTimeAsync(350);
    expect(shown()).toEqual(['b.jpg']);
    await vi.advanceTimersByTimeAsync(2500);
    expect(useGallery.getState().meaning).toEqual({ q: 'harbor', paths: ['D:/Trip/b.jpg'] });
    expect(shown()).toEqual(['b.jpg']);
    expect(selectMeaningStart(useGallery.getState())).toBe(0);

    // Cleared: nothing by meaning, and no search for under 3 letters.
    const asked = calls.filter((c) => c.url.startsWith('/api/gallery/search')).length;
    useGallery.getState().setFilter({ text: 'ha' });
    await vi.advanceTimersByTimeAsync(350);
    expect(calls.filter((c) => c.url.startsWith('/api/gallery/search')).length).toBe(asked);
    expect(selectMeaningStart(useGallery.getState())).toBeNull();
    useGallery.getState().clearFilter();
  });

  it('does not search by meaning while tagging is off', async () => {
    vi.useFakeTimers();
    useGallery.setState({ job: 'j1', root: 'D:/Trip', items: [item()], filter: {} });
    useGallery.getState().setFilter({ text: 'harbour' });
    await vi.advanceTimersByTimeAsync(350);
    expect(calls.filter((c) => c.url.startsWith('/api/gallery/search'))).toEqual([]);
    useGallery.getState().clearFilter();
  });
});
