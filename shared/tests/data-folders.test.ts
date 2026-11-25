// Moving a program's data folder from its old name to its new one, and the editor's photo info to the
// shared fallback. Every test works in its own temporary folder: a real %APPDATA% is never touched.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CarryOverError, carryOver, carryOverAll } from '../electron/dataFolders';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'data-folders-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (file: string, text = 'x') => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
/** Every file under `dir`, relative path → contents. */
const contents = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out[join(e.parentPath, e.name).slice(dir.length + 1).replace(/\\/g, '/')] = readFileSync(join(e.parentPath, e.name), 'utf8');
  }
  return out;
};

describe('carryOver', () => {
  it('moves the old folder when the new one is missing', () => {
    const from = join(root, 'Old');
    const to = join(root, 'deeper', 'New');
    put(join(from, 'data', 'x.txt'), 'hello');
    expect(carryOver(from, to)).toBe('moved');
    expect(readFileSync(join(to, 'data', 'x.txt'), 'utf8')).toBe('hello');
    expect(existsSync(from)).toBe(false);
  });

  it('leaves both alone when both exist', () => {
    const from = join(root, 'Old');
    const to = join(root, 'New');
    put(join(from, 'data', 'old.txt'), 'old');
    put(join(to, 'data', 'new.txt'), 'new');
    expect(carryOver(from, to)).toBe('already-there');
    expect(contents(from)).toEqual({ 'data/old.txt': 'old' });
    expect(contents(to)).toEqual({ 'data/new.txt': 'new' });
  });

  it('nothing to move', () => {
    const to = join(root, 'New');
    expect(carryOver(join(root, 'Old'), to)).toBe('nothing-to-move');
    expect(existsSync(to)).toBe(false);
  });

  it('refuses when the old folder is in use', () => {
    const from = join(root, 'Old');
    const to = join(root, 'New');
    put(join(from, 'data', 'x.txt'), 'hello');
    const busy = () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    let thrown: unknown;
    try {
      carryOver(from, to, busy);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CarryOverError);
    expect((thrown as CarryOverError).from).toBe(from);
    expect((thrown as CarryOverError).to).toBe(to);
    expect(contents(from)).toEqual({ 'data/x.txt': 'hello' });
    expect(existsSync(to)).toBe(false);
  });
});

describe('carryOverAll', () => {
  const editor = { oldProductName: 'Photobook Studio', productName: 'Photobook Editor', envPrefix: 'PHOTOBOOK' };
  const photoTool = { oldProductName: 'Photobook Gallery', productName: 'Photo Tool', envPrefix: 'PHOTO_TOOL' };

  for (const [name, order] of [
    ['editor first', [editor, photoTool]],
    ['Photo Tool first', [photoTool, editor]],
  ] as const) {
    it(`carryOverAll moves the editor's photoinfo to the shared fallback (${name})`, () => {
      put(join(root, 'Photobook Studio Dev', 'data', 'photoinfo', 'a.json'), '{"a":1}');
      put(join(root, 'Photobook Studio Dev', 'data', 'books.sqlite'), 'db');
      for (const names of order) carryOverAll({ appData: root, packaged: false, env: {}, ...names });
      expect(readFileSync(join(root, 'Photo Tools Shared Dev', 'photoinfo', 'a.json'), 'utf8')).toBe('{"a":1}');
      expect(existsSync(join(root, 'Photobook Editor Dev', 'data'))).toBe(true);
      expect(existsSync(join(root, 'Photobook Editor Dev', 'data', 'photoinfo'))).toBe(false);
      expect(readFileSync(join(root, 'Photobook Editor Dev', 'data', 'books.sqlite'), 'utf8')).toBe('db');
      expect(existsSync(join(root, 'Photobook Studio Dev'))).toBe(false);
    });
  }

  it("moves Photo Tool's old folder under its new name, and reports both steps", () => {
    put(join(root, 'Photobook Gallery', 'data', 'thumbs.sqlite'), 't');
    put(join(root, 'Photobook Studio', 'data', 'photoinfo', 'b.json'), 'b');
    expect(carryOverAll({ appData: root, packaged: true, env: {}, ...photoTool })).toEqual({ data: 'moved', photoinfo: 'moved' });
    expect(readFileSync(join(root, 'Photo Tool', 'data', 'thumbs.sqlite'), 'utf8')).toBe('t');
    expect(readFileSync(join(root, 'Photo Tools Shared', 'photoinfo', 'b.json'), 'utf8')).toBe('b');
  });

  describe('never moves a folder in a test run or when the folders are given', () => {
    const seed = () => {
      put(join(root, 'Photobook Studio Dev', 'data', 'photoinfo', 'a.json'), 'a');
      put(join(root, 'Photobook Gallery Dev', 'data', 'g.txt'), 'g');
    };
    const untouched = () => {
      expect(contents(join(root, 'Photobook Studio Dev'))).toEqual({ 'data/photoinfo/a.json': 'a' });
      expect(contents(join(root, 'Photobook Gallery Dev'))).toEqual({ 'data/g.txt': 'g' });
      for (const made of ['Photobook Editor Dev', 'Photo Tool Dev', 'Photo Tools Shared Dev']) expect(existsSync(join(root, made)), made).toBe(false);
    };

    it('skips the data folder when the program\'s DATA_DIR or PROFILE_DIR is set', () => {
      seed();
      const elsewhere = join(root, 'elsewhere');
      const fallback = { PHOTOINFO_FALLBACK_DIR: join(elsewhere, 'photoinfo') };
      expect(carryOverAll({ appData: root, packaged: false, env: { PHOTO_TOOL_DATA_DIR: join(elsewhere, 'd'), ...fallback }, ...photoTool })).toEqual({ data: 'skipped', photoinfo: 'skipped' });
      expect(carryOverAll({ appData: root, packaged: false, env: { PHOTO_TOOL_PROFILE_DIR: join(elsewhere, 'p'), ...fallback }, ...photoTool })).toEqual({ data: 'skipped', photoinfo: 'skipped' });
      expect(carryOverAll({ appData: root, packaged: false, env: { PHOTOBOOK_DATA_DIR: join(elsewhere, 'd'), ...fallback }, ...editor })).toEqual({ data: 'skipped', photoinfo: 'skipped' });
      expect(carryOverAll({ appData: root, packaged: false, env: { PHOTOBOOK_PROFILE_DIR: join(elsewhere, 'p'), ...fallback }, ...editor })).toEqual({ data: 'skipped', photoinfo: 'skipped' });
      untouched();
    });

    it('reads only its own prefix: the other program\'s DATA_DIR does not stop the move', () => {
      seed();
      const r = carryOverAll({ appData: root, packaged: false, env: { PHOTOBOOK_DATA_DIR: join(root, 'elsewhere'), PHOTOINFO_FALLBACK_DIR: join(root, 'fb') }, ...photoTool });
      expect(r).toEqual({ data: 'moved', photoinfo: 'skipped' });
      expect(contents(join(root, 'Photo Tool Dev'))).toEqual({ 'data/g.txt': 'g' });
    });

    it('skips the photo info when PHOTOINFO_FALLBACK_DIR is set', () => {
      seed();
      const fallback = join(root, 'given', 'photoinfo');
      const r = carryOverAll({ appData: root, packaged: false, env: { PHOTO_TOOL_DATA_DIR: join(root, 'd'), PHOTOINFO_FALLBACK_DIR: fallback }, ...photoTool });
      expect(r.photoinfo).toBe('skipped');
      expect(existsSync(fallback)).toBe(false);
      untouched();
    });

    it('skips both during a self-test, whatever the environment says', () => {
      seed();
      for (const names of [editor, photoTool]) expect(carryOverAll({ appData: root, packaged: false, env: {}, selfTest: true, ...names })).toEqual({ data: 'skipped', photoinfo: 'skipped' });
      untouched();
    });
  });
});
