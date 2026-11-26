// Deleting photos from the gallery: only photos of the folder open now (the server's file-check) go
// to the Recycle Bin, only after the confirm, and a failure is reported rather than retried another way.
// Every dependency is a fake here: nothing on disk is touched.
import { describe, expect, it, vi } from 'vitest';
import { copyTextRequest, MAX_COPY_TEXT, MAX_TRASH_FILES, trashConfirm, trashPhotos } from '../electron/fileActions';

function fakes(o: { catalogued?: string[]; confirm?: boolean; failing?: string[]; removedFails?: boolean } = {}) {
  const catalogued = new Set(o.catalogued ?? ['C:\\p\\a.jpg', 'C:\\p\\b.jpg']);
  const calls = { checked: [] as string[][], confirmed: [] as string[][], trashed: [] as string[], removed: [] as string[][] };
  return {
    calls,
    deps: {
      check: vi.fn(async (paths: string[]) => {
        calls.checked.push(paths);
        return paths.filter((p) => catalogued.has(p));
      }),
      confirm: vi.fn(async (paths: string[]) => {
        calls.confirmed.push(paths);
        return o.confirm ?? true;
      }),
      trash: vi.fn(async (path: string) => {
        if (o.failing?.includes(path)) throw new Error('The Recycle Bin is not available on this drive');
        calls.trashed.push(path);
      }),
      removed: vi.fn(async (paths: string[]) => {
        calls.removed.push(paths);
        if (o.removedFails) throw new Error('server down');
      }),
    },
  };
}

describe('trashPhotos', () => {
  it('trashes only checked paths', async () => {
    const { deps, calls } = fakes();
    const r = await trashPhotos(['C:\\p\\a.jpg', 'C:\\Windows\\win.ini', 'C:\\p\\b.jpg'], deps);
    expect(calls.checked).toEqual([['C:\\p\\a.jpg', 'C:\\Windows\\win.ini', 'C:\\p\\b.jpg']]);
    expect(calls.confirmed).toEqual([['C:\\p\\a.jpg', 'C:\\p\\b.jpg']]);
    expect(calls.trashed).toEqual(['C:\\p\\a.jpg', 'C:\\p\\b.jpg']);
    expect(calls.removed).toEqual([['C:\\p\\a.jpg', 'C:\\p\\b.jpg']]);
    expect(r).toEqual({ trashed: ['C:\\p\\a.jpg', 'C:\\p\\b.jpg'], failed: [], cancelled: false });
  });

  it('cancel trashes nothing', async () => {
    const { deps, calls } = fakes({ confirm: false });
    const r = await trashPhotos(['C:\\p\\a.jpg'], deps);
    expect(r).toEqual({ trashed: [], failed: [], cancelled: true });
    expect(deps.trash).not.toHaveBeenCalled();
    expect(deps.removed).not.toHaveBeenCalled();
    expect(calls.confirmed).toHaveLength(1);
  });

  it('a failing trash is reported and not passed to removed', async () => {
    const { deps, calls } = fakes({ failing: ['C:\\p\\a.jpg'] });
    const r = await trashPhotos(['C:\\p\\a.jpg', 'C:\\p\\b.jpg'], deps);
    expect(r.trashed).toEqual(['C:\\p\\b.jpg']);
    expect(r.failed).toEqual([{ path: 'C:\\p\\a.jpg', message: 'The Recycle Bin is not available on this drive' }]);
    expect(r.cancelled).toBe(false);
    expect(calls.removed).toEqual([['C:\\p\\b.jpg']]);
  });

  it('does not call removed when every trash failed', async () => {
    const { deps } = fakes({ failing: ['C:\\p\\a.jpg'] });
    const r = await trashPhotos(['C:\\p\\a.jpg'], deps);
    expect(r.trashed).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(deps.removed).not.toHaveBeenCalled();
  });

  it('still reports the trashed files when telling the server fails', async () => {
    const { deps } = fakes({ removedFails: true });
    const r = await trashPhotos(['C:\\p\\a.jpg'], deps);
    expect(r).toEqual({ trashed: ['C:\\p\\a.jpg'], failed: [], cancelled: false });
  });

  it('junk input does nothing', async () => {
    for (const junk of [undefined, null, 'C:\\p\\a.jpg', 42, {}, [1, null, ''], ['C:\\nope.jpg']]) {
      const { deps } = fakes();
      expect(await trashPhotos(junk, deps)).toEqual({ trashed: [], failed: [], cancelled: false });
      expect(deps.confirm).not.toHaveBeenCalled();
      expect(deps.trash).not.toHaveBeenCalled();
      expect(deps.removed).not.toHaveBeenCalled();
    }
  });

  it('asks the server about at most 500 paths at a time', async () => {
    const { deps, calls } = fakes();
    await trashPhotos(Array.from({ length: 600 }, (_, i) => `C:\\p\\${i}.jpg`), deps);
    expect(calls.checked[0]).toHaveLength(500);
  });

  // #9 fix round 1: Ctrl+A then Delete in a big folder. The confirm names the real count, and every
  // photo it named goes to the bin (checked and reported in batches of 500), never 500 of them only.
  it('2,000 photos: one confirm for all 2,000, all 2,000 trashed, checked and reported 500 at a time', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => `C:\\p\\${i}.jpg`);
    const { deps, calls } = fakes({ catalogued: many });
    const r = await trashPhotos(many, deps);
    expect(calls.checked.map((c) => c.length)).toEqual([500, 500, 500, 500]);
    expect(calls.confirmed).toHaveLength(1);
    expect(calls.confirmed[0]).toHaveLength(2000);
    expect(trashConfirm(calls.confirmed[0], 'win32').message).toBe('Move 2000 photos to the Recycle Bin?');
    expect(calls.trashed).toEqual(many);
    expect(calls.removed.map((c) => c.length)).toEqual([500, 500, 500, 500]);
    expect(r).toEqual({ trashed: many, failed: [], cancelled: false });
  });

  it('a failure part way is reported with what was moved, and the rest still go', async () => {
    const many = Array.from({ length: 700 }, (_, i) => `C:\\p\\${i}.jpg`);
    const { deps } = fakes({ catalogued: many, failing: ['C:\\p\\600.jpg'] });
    const r = await trashPhotos(many, deps);
    expect(r.trashed).toHaveLength(699);
    expect(r.failed).toEqual([{ path: 'C:\\p\\600.jpg', message: 'The Recycle Bin is not available on this drive' }]);
  });

  it(`more than ${MAX_TRASH_FILES} is refused before anything is asked or moved`, async () => {
    const { deps } = fakes();
    const r = await trashPhotos(Array.from({ length: MAX_TRASH_FILES + 1 }, (_, i) => `C:\\p\\${i}.jpg`), deps);
    expect(r).toEqual({ trashed: [], failed: [], cancelled: true });
    expect(deps.check).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.trash).not.toHaveBeenCalled();
  });
});

describe('trashConfirm', () => {
  it('names one file, Cancel is the default', () => {
    const c = trashConfirm(['C:\\p\\day1.jpg'], 'win32');
    expect(c).toEqual({
      type: 'warning',
      buttons: ['Move to Recycle Bin', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Move "day1.jpg" to the Recycle Bin?',
      detail: 'You can restore them from the Recycle Bin.',
    });
  });

  it('counts several, and says Trash on Linux', () => {
    expect(trashConfirm(['C:\\p\\a.jpg', 'C:\\p\\b.jpg'], 'win32').message).toBe('Move 2 photos to the Recycle Bin?');
    const linux = trashConfirm(['/home/u/a.jpg'], 'linux');
    expect(linux.message).toBe('Move "a.jpg" to the Trash?');
    expect(linux.buttons).toEqual(['Move to Trash', 'Cancel']);
    expect(linux.detail).toBe('You can restore them from the Trash.');
  });
});

describe('copyTextRequest', () => {
  it('takes a non-empty string up to the cap, nothing else', () => {
    expect(copyTextRequest('C:\\p\\a.jpg\nC:\\p\\b.jpg')).toBe('C:\\p\\a.jpg\nC:\\p\\b.jpg');
    expect(copyTextRequest('x'.repeat(MAX_COPY_TEXT))).toHaveLength(MAX_COPY_TEXT);
    expect(MAX_COPY_TEXT).toBeGreaterThanOrEqual(500 * 4096);
    for (const junk of ['', 'x'.repeat(MAX_COPY_TEXT + 1), 42, null, undefined, ['a'], {}]) expect(copyTextRequest(junk)).toBeNull();
  });
});
