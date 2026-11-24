// The gallery's store, against a fake server: a star the server refuses is shown as an error and not
// applied, photo info changed by another program is reloaded once, and a folder the desktop app
// hands over (`--gallery <folder>`, a second launch, File > Open folder) is opened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryItem } from '../src/gallery/server/app';

const { useGallery, connectDesktop, selectVisible, selectStackInfo, selectFiltered, selectFacts, selectStackPlace, menuTargets } = await import('../src/gallery/web/store');

function item(over: Partial<GalleryItem> = {}): GalleryItem {
  return {
    path: 'D:\\Trip\\a.jpg', folder: 'D:\\Trip', fileName: 'a.jpg', relDir: '', size: 1000, mtimeMs: 1, width: 400, height: 300,
    format: 'jpeg', capturedAt: null, gpsLat: null, gpsLon: null, camera: null, exif: null, analysis: null, key: 'k1',
    info: {}, infoSource: 'folder', effectiveDate: null, effectiveLat: null, effectiveLon: null, ...over,
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
