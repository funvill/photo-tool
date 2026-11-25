// The editor store watches photoinfo.json: a change made right after the book opens is picked up by
// the first poll (the baseline is read with the initial photo load, not by the first poll).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBook } from '../core';
import { fakeAsset } from './helpers';

let stamp = 'one';
const assets = vi.fn();
vi.mock('../web/api', () => ({
  ApiError: class extends Error {},
  api: {
    getProject: async () => ({ doc: createBook({ title: 'Watch', pages: 8 }), revision: 1 }),
    assets: (...args: unknown[]) => assets(...args),
    photoInfoStamp: async () => stamp,
    links: async () => [],
    syncLinks: async () => ({ job: null }),
  },
}));

const { useEditor } = await import('../web/store');

describe('photo info watch', () => {
  afterEach(() => {
    useEditor.getState().unload();
    vi.useRealTimers();
  });

  it('reloads the photos on the first poll when the file changed just after opening', async () => {
    vi.useFakeTimers();
    assets.mockResolvedValue([fakeAsset({ favorite: false })]);
    await useEditor.getState().load('p1');
    expect(assets).toHaveBeenCalledTimes(1);
    stamp = 'two';
    await vi.advanceTimersByTimeAsync(3100);
    expect(assets).toHaveBeenCalledTimes(2);
  });
});
