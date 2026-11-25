// Where the gallery saves an edit ("When I save an edit" in Settings): the desktop app keeps the choice
// in its settings file; a plain browser keeps it in localStorage. Anything unknown reads as 'info'.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEditTarget, saveEditTarget } from '../web/editSettings';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('edit settings', () => {
  it("asks the desktop app first, and leaves localStorage alone", async () => {
    store.set('gallery.editTarget', 'info');
    const setEditTarget = vi.fn(async () => {});
    expect(await loadEditTarget({ getEditTarget: async () => 'file' })).toBe('file');
    await saveEditTarget({ setEditTarget }, 'file');
    expect(setEditTarget).toHaveBeenCalledWith('file');
    expect(store.get('gallery.editTarget')).toBe('info');
  });

  it("reads 'info' when the desktop app fails or answers something else", async () => {
    expect(await loadEditTarget({ getEditTarget: async () => { throw new Error('gone'); } })).toBe('info');
    expect(await loadEditTarget({ getEditTarget: async () => 'disk' as never })).toBe('info');
  });

  it('falls back to localStorage in a plain browser; the default is the info file', async () => {
    expect(await loadEditTarget(undefined)).toBe('info');
    await saveEditTarget(undefined, 'file');
    expect(store.get('gallery.editTarget')).toBe('file');
    expect(await loadEditTarget(undefined)).toBe('file');
    await saveEditTarget({}, 'info');
    expect(await loadEditTarget({})).toBe('info');
    store.set('gallery.editTarget', 'nonsense');
    expect(await loadEditTarget(undefined)).toBe('info');
  });

  it('storage switched off: the default, and saving does not throw', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(await loadEditTarget(undefined)).toBe('info');
    await expect(saveEditTarget(undefined, 'file')).resolves.toBeUndefined();
  });
});
