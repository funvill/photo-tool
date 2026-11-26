// Saving a photo's edit from the gallery: into the photo file (the original goes to the Recycle Bin
// first) or as a copy, and the warning before closing with unsaved edits. Every dependency is a fake:
// nothing on disk is touched except the settings file, which lives in a temp folder.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyablePatch, MOVE_RETRY_MS, MOVE_TRIES, saveAs, saveToFile, letPageClose, shouldQuit, unsavedClosePrompt } from '../electron/editActions';
import { readEditTarget, readMapConsent, writeEditTarget, writeMapConsent } from '../electron/mapTiles';

const edit = { rotate: 90 as const, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
const ORIGINAL = 'C:\\p\\IMG_1.jpg';
const TEMP = 'C:\\data\\edits\\abc.jpg';

function fakes(o: { catalogued?: string[]; trashFails?: boolean; renderFails?: boolean; moveFails?: boolean; ask?: string | null; refreshEmpty?: boolean; format?: string; existing?: string[]; clearFails?: boolean; refreshFails?: boolean; renderFormat?: string; copyFails?: boolean } = {}) {
  const calls: string[] = [];
  const catalogued = new Set(o.catalogued ?? [ORIGINAL, 'C:\\p\\IMG_1.HEIC']);
  const deps = {
    platform: 'win32' as NodeJS.Platform,
    check: vi.fn(async (paths: string[]) => paths.filter((p) => catalogued.has(p))),
    render: vi.fn(async (path: string) => {
      calls.push('render');
      if (o.renderFails) throw new Error('render broke');
      return { file: o.format ? `C:\\data\\edits\\abc.${o.format}` : TEMP, format: o.renderFormat };
    }),
    trash: vi.fn(async () => {
      calls.push('trash');
      if (o.trashFails) throw new Error('no bin');
    }),
    move: vi.fn(async () => {
      calls.push('move');
      if (o.moveFails) throw new Error('disk full');
    }),
    removeTemp: vi.fn(async () => void calls.push('removeTemp')),
    clearEdit: vi.fn(async () => {
      calls.push('clearEdit');
      if (o.clearFails) throw new Error('info locked');
    }),
    refresh: vi.fn(async (paths: string[]) => {
      calls.push('refresh');
      if (o.refreshFails) throw new Error('server down');
      return o.refreshEmpty ? [] : paths.map((p) => ({ path: p }));
    }),
    ask: vi.fn(async (_default: string) => {
      calls.push('ask');
      return o.ask === undefined ? 'C:\\p\\copy.jpg' : o.ask;
    }),
    exists: vi.fn(async (p: string) => (o.existing ?? []).includes(p)),
    copyInfo: vi.fn(async () => {
      calls.push('copyInfo');
      if (o.copyFails) throw new Error('info locked');
    }),
  };
  return { deps, calls };
}

describe('saveToFile', () => {
  it('renders, trashes the original, moves the copy in, clears the edit, refreshes', async () => {
    const { deps, calls } = fakes();
    const r = await saveToFile(ORIGINAL, edit, deps);
    expect(r).toEqual({ ok: true, item: { path: ORIGINAL } });
    expect(calls).toEqual(['render', 'trash', 'move', 'clearEdit', 'refresh']);
    expect(deps.move).toHaveBeenCalledWith(TEMP, ORIGINAL);
  });

  it('refuses a path that is not in the open folder, before rendering', async () => {
    const { deps } = fakes();
    const r = await saveToFile('C:\\elsewhere\\x.jpg', edit, deps);
    expect(r.ok).toBe(false);
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('refuses a HEIC photo before rendering', async () => {
    const { deps } = fakes();
    const r = await saveToFile('C:\\p\\IMG_1.HEIC', edit, deps);
    expect(r).toEqual({ ok: false, error: 'HEIC photos can only be saved as a copy.' });
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('does nothing else when the render fails', async () => {
    const { deps, calls } = fakes({ renderFails: true });
    const r = await saveToFile(ORIGINAL, edit, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('render broke');
    expect(calls).toEqual(['render']);
  });

  it('leaves the original when it cannot be trashed, and removes the temp file', async () => {
    const { deps, calls } = fakes({ trashFails: true });
    const r = await saveToFile(ORIGINAL, edit, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Couldn't move the original to the Recycle Bin, so nothing was changed: no bin");
    expect(deps.move).not.toHaveBeenCalled();
    expect(calls).toEqual(['render', 'trash', 'removeTemp']);
  });

  it('says where the edited copy is when it cannot be moved in after the trash, and keeps it', async () => {
    const { deps, calls } = fakes({ moveFails: true });
    const r = await saveToFile(ORIGINAL, edit, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Recycle Bin');
    expect(r.error).toContain(TEMP);
    expect(r.error).toContain('disk full');
    expect(r.error).toContain('Restore the original from the Recycle Bin');
    expect(r.error).not.toContain('Save again');
    expect(deps.removeTemp).not.toHaveBeenCalled();
    expect(calls).toEqual(['render', 'trash', 'move']);
  });

  it('tries a busy move again a few times, waiting between tries', async () => {
    const { deps, calls } = fakes();
    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    deps.move.mockRejectedValueOnce(busy).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EPERM' }));
    const wait = vi.fn(async () => undefined);
    const r = await saveToFile(ORIGINAL, edit, { ...deps, wait });
    expect(r.ok).toBe(true);
    expect(deps.move).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(MOVE_RETRY_MS);
    // The two refused tries are the mocked ones; only the third reaches the fake's own move.
    expect(calls).toEqual(['render', 'trash', 'move', 'clearEdit', 'refresh']);
  });

  it('gives up on a move that stays busy, and does not retry other failures', async () => {
    const a = fakes();
    a.deps.move.mockRejectedValue(Object.assign(new Error('locked'), { code: 'EACCES' }));
    const wait = vi.fn(async () => undefined);
    const ra = await saveToFile(ORIGINAL, edit, { ...a.deps, wait });
    expect(ra.ok).toBe(false);
    expect(ra.error).toContain('locked');
    expect(a.deps.move).toHaveBeenCalledTimes(MOVE_TRIES);
    expect(wait).toHaveBeenCalledTimes(MOVE_TRIES - 1);
    const b = fakes({ moveFails: true });
    const rb = await saveToFile(ORIGINAL, edit, { ...b.deps, wait: vi.fn(async () => undefined) });
    expect(rb.ok).toBe(false);
    expect(b.deps.move).toHaveBeenCalledTimes(1);
  });

  it('says the photo was saved when the edit cannot be cleared or the photo read again', async () => {
    const a = fakes({ clearFails: true });
    const ra = await saveToFile(ORIGINAL, edit, a.deps);
    expect(ra).toEqual({ ok: false, saved: true, error: 'The photo was saved, but its old edit could not be cleared from the photo info: info locked' });
    const b = fakes({ refreshFails: true });
    const rb = await saveToFile(ORIGINAL, edit, b.deps);
    expect(rb).toEqual({ ok: false, saved: true, error: 'The photo was saved, but Photo Tool could not read it again: server down' });
  });

  it('stops, removing the temp file, when the server wrote another format than expected', async () => {
    const { deps, calls } = fakes({ renderFormat: 'png' });
    const r = await saveToFile(ORIGINAL, edit, deps);
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['render', 'removeTemp']);
  });
});

describe('saveAs', () => {
  it('offers <name>-edited.jpg for a HEIC photo, and keeps the original extension otherwise', async () => {
    const heic = fakes({ ask: null });
    await saveAs('C:\\p\\IMG_1.HEIC', edit, heic.deps);
    expect(heic.deps.ask).toHaveBeenCalledWith('C:\\p\\IMG_1-edited.jpg');
    const png = fakes({ ask: null, catalogued: ['C:\\p\\a.png'] });
    await saveAs('C:\\p\\a.png', edit, png.deps);
    expect(png.deps.ask).toHaveBeenCalledWith('C:\\p\\a-edited.png');
  });

  it('does nothing when the dialog is cancelled', async () => {
    const { deps, calls } = fakes({ ask: null });
    const r = await saveAs(ORIGINAL, edit, deps);
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(calls).toEqual(['ask']);
  });

  it('refuses the original path, whatever its case on Windows', async () => {
    const { deps } = fakes({ ask: 'c:\\P\\img_1.JPG' });
    const r = await saveAs(ORIGINAL, edit, deps);
    expect(r).toEqual({ ok: false, error: 'Choose a different name: Save as keeps the original.' });
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('keeps case differences apart off Windows', async () => {
    const { deps } = fakes({ ask: '/p/img_1.jpg', catalogued: ['/p/IMG_1.jpg'] });
    deps.platform = 'linux';
    const r = await saveAs('/p/IMG_1.jpg', edit, deps);
    expect(r.ok).toBe(true);
  });

  it('forces the render format as the extension, keeping .jpeg', async () => {
    const a = fakes({ ask: 'C:\\p\\copy.png' });
    expect((await saveAs(ORIGINAL, edit, a.deps)).savedPath).toBe('C:\\p\\copy.jpg');
    const b = fakes({ ask: 'C:\\p\\copy.jpeg' });
    expect((await saveAs(ORIGINAL, edit, b.deps)).savedPath).toBe('C:\\p\\copy.jpeg');
    const c = fakes({ ask: 'C:\\p\\copy' });
    expect((await saveAs(ORIGINAL, edit, c.deps)).savedPath).toBe('C:\\p\\copy.jpg');
    const d = fakes({ ask: 'C:\\p\\copy.jpg', catalogued: ['C:\\p\\a.webp'] });
    expect((await saveAs('C:\\p\\a.webp', edit, d.deps)).savedPath).toBe('C:\\p\\copy.webp');
  });

  it('renders, moves, then refreshes and copies the info when the copy is in the open folder', async () => {
    const { deps, calls } = fakes();
    const r = await saveAs(ORIGINAL, edit, deps, { star: true, people: ['Ann'] });
    expect(r).toEqual({ ok: true, savedPath: 'C:\\p\\copy.jpg', item: { path: 'C:\\p\\copy.jpg' } });
    expect(calls).toEqual(['ask', 'render', 'move', 'refresh', 'copyInfo']);
    expect(deps.move).toHaveBeenCalledWith(TEMP, 'C:\\p\\copy.jpg');
    expect(deps.copyInfo).toHaveBeenCalledWith('C:\\p\\copy.jpg', { edit: null, star: true, people: ['Ann'] });
  });

  it('does not copy the info when the copy is outside the open folder', async () => {
    const { deps } = fakes({ refreshEmpty: true });
    const r = await saveAs(ORIGINAL, edit, deps, { star: true });
    expect(r).toEqual({ ok: true, savedPath: 'C:\\p\\copy.jpg' });
    expect(deps.copyInfo).not.toHaveBeenCalled();
  });

  it('removes the temp file when it cannot be moved', async () => {
    const { deps, calls } = fakes({ moveFails: true });
    const r = await saveAs(ORIGINAL, edit, deps);
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['ask', 'render', 'move', 'removeTemp']);
  });

  it('refuses a changed name that would replace an existing file, before rendering', async () => {
    const { deps } = fakes({ ask: 'C:\\p\\copy.png', existing: ['C:\\p\\copy.jpg'] });
    const r = await saveAs(ORIGINAL, edit, deps);
    expect(r).toEqual({ ok: false, error: 'A file with that name already exists. Choose another name.' });
    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.move).not.toHaveBeenCalled();
  });

  it('leaves the replace question to the dialog when the name was not changed', async () => {
    const { deps } = fakes({ ask: 'C:\\p\\copy.jpg', existing: ['C:\\p\\copy.jpg'] });
    expect((await saveAs(ORIGINAL, edit, deps)).ok).toBe(true);
    expect(deps.exists).not.toHaveBeenCalled();
  });

  it('does nothing else when the render fails', async () => {
    const { deps, calls } = fakes({ renderFails: true });
    const r = await saveAs(ORIGINAL, edit, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('render broke');
    expect(calls).toEqual(['ask', 'render']);
  });

  it('says the copy was saved when it cannot be read again or its info cannot be copied', async () => {
    const a = fakes({ refreshFails: true });
    const ra = await saveAs(ORIGINAL, edit, a.deps);
    expect(ra.ok).toBe(false);
    expect(ra.saved).toBe(true);
    expect(ra.error).toContain('could not read it');
    const b = fakes({ copyFails: true });
    const rb = await saveAs(ORIGINAL, edit, b.deps);
    expect(rb.saved).toBe(true);
    expect(rb.error).toBe('The copy was saved as C:\\p\\copy.jpg, but its star, people, date, location, description and notes could not be copied to it: info locked');
  });

  it('refuses a path that is not in the open folder, before asking', async () => {
    const { deps } = fakes();
    const r = await saveAs('C:\\x\\y.jpg', edit, deps);
    expect(r.ok).toBe(false);
    expect(deps.ask).not.toHaveBeenCalled();
  });
});

describe('copyablePatch', () => {
  it('takes only the person-made fields, and removes any edit the copy had', () => {
    expect(copyablePatch({ star: true, people: ['A'], date: 'd', location: { lat: 1, lon: 2 }, description: 'x', notes: 'n', edit: { rotate: 90 }, other: 1 })).toEqual({
      edit: null,
      star: true,
      people: ['A'],
      date: 'd',
      location: { lat: 1, lon: 2 },
      description: 'x',
      notes: 'n',
    });
    expect(copyablePatch(undefined)).toEqual({ edit: null });
  });
});

describe('unsavedClosePrompt', () => {
  it('names the count and defaults to keep editing', () => {
    const p = unsavedClosePrompt(3);
    expect(p.message).toContain('3 photos');
    expect(unsavedClosePrompt(1).message).toContain('1 photo ');
    expect(p.buttons).toEqual(['Close without saving', 'Keep editing']);
    expect(p.defaultId).toBe(1);
    expect(p.cancelId).toBe(1);
  });
});

describe('shouldQuit', () => {
  it('quits without asking when nothing is unsaved', () => {
    const ask = vi.fn(() => false);
    expect(shouldQuit(0, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks with the count, and quits only on Close without saving', () => {
    const yes = vi.fn(() => true);
    expect(shouldQuit(2, yes)).toBe(true);
    expect(yes).toHaveBeenCalledWith(2);
    expect(shouldQuit(2, () => false)).toBe(false);
  });
});

describe('letPageClose', () => {
  it('lets the page go without asking when the close was already confirmed (Restart now asked once)', () => {
    const ask = vi.fn(() => false);
    expect(letPageClose({ count: 3, confirmed: true }, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('otherwise asks as quitting does', () => {
    const ask = vi.fn(() => false);
    expect(letPageClose({ count: 0, confirmed: false }, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(letPageClose({ count: 2, confirmed: false }, ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith(2);
    expect(letPageClose({ count: 2, confirmed: false }, () => true)).toBe(true);
  });
});

describe('the edit target setting', () => {
  const dirs: string[] = [];
  const fileIn = () => {
    const d = mkdtempSync(join(tmpdir(), 'edit-target-'));
    dirs.push(d);
    return join(d, 'settings.json');
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("defaults to 'info' for a missing or garbled file, and for anything but 'file'", () => {
    const f = fileIn();
    expect(readEditTarget(f)).toBe('info');
    writeFileSync(f, '{nope');
    expect(readEditTarget(f)).toBe('info');
    writeFileSync(f, JSON.stringify({ editTarget: 'both' }));
    expect(readEditTarget(f)).toBe('info');
  });

  it('keeps mapsOnline when the target is written, and the other way round', () => {
    const f = fileIn();
    writeMapConsent(f, true);
    writeEditTarget(f, 'file');
    expect(readEditTarget(f)).toBe('file');
    expect(readMapConsent(f)).toBe(true);
    writeMapConsent(f, false);
    expect(readEditTarget(f)).toBe('file');
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ mapsOnline: false, editTarget: 'file' });
  });
});
