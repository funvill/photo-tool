// The editor store: a star the server refuses to save is shown as an error, not lost as an unhandled rejection.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAsset } from './helpers';

const patchAsset = vi.fn();
vi.mock('../src/web/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return { api: { patchAsset: (...args: unknown[]) => patchAsset(...args) }, ApiError };
});

const { useEditor } = await import('../src/web/store');
const { ApiError } = await import('../src/web/api');

describe('patchAsset', () => {
  beforeEach(() => {
    patchAsset.mockReset();
    const a = fakeAsset({ favorite: false });
    useEditor.setState({ projectId: 'p1', assets: [a], assetMap: new Map([[a.id, a]]), toasts: [] });
  });

  it("shows the server's message as an error toast and leaves the star as it was", async () => {
    const message = "Can't save the star: photoinfo.json in D:\\Trip is in use by another program; try again.";
    patchAsset.mockRejectedValue(new ApiError(409, message));
    const [a] = useEditor.getState().assets;
    const ok = await useEditor.getState().patchAsset(a.id, { favorite: true });
    expect(ok).toBe(false);
    expect(useEditor.getState().assets[0].favorite).toBe(false);
    expect(useEditor.getState().toasts).toEqual([expect.objectContaining({ kind: 'error', text: message })]);
  });

  it('updates the photo when the server accepts the change', async () => {
    const [a] = useEditor.getState().assets;
    patchAsset.mockResolvedValue({ ...a, favorite: true });
    expect(await useEditor.getState().patchAsset(a.id, { favorite: true })).toBe(true);
    expect(useEditor.getState().assets[0].favorite).toBe(true);
    expect(useEditor.getState().toasts).toEqual([]);
  });
});
