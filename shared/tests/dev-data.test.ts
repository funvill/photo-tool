// Running from source: ./data split per program, and the old one-folder layout carried over once.
// Every test works in its own temporary project root: the project's real ./data is never touched.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CarryOverError } from '../electron/dataFolders';
import { carryOverDevData, devCarryOverSkipped, devDataLayout } from '../server/devData';

const project = resolve(__dirname, '../..');
type Dirs = { dataDir: string; photoInfoFallbackDir: string; carryOver: boolean };
// Loaded by a computed path: shared must not import the programs, and the boundary rule would flag a static import.
const loadDirs = (program: string) =>
  import(/* @vite-ignore */ pathToFileURL(resolve(project, program, 'server/dirs.ts')).href) as Promise<{ resolveDirs(env: Record<string, string | undefined>, root: string): Dirs }>;

let root: string;
let data: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dev-data-'));
  data = join(root, 'data');
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
const oldLayout = () => {
  put(join(data, 'photobook.db'), 'db');
  put(join(data, 'exports', 'x.pdf'), 'pdf');
  put(join(data, 'gallery', 'catalog.db'), 'catalog');
  put(join(data, 'photoinfo', 'a.json'), 'info');
};
const SPLIT = {
  'photobook-editor/photobook.db': 'db',
  'photobook-editor/exports/x.pdf': 'pdf',
  'photo-tool/catalog.db': 'catalog',
  'photoinfo-shared/a.json': 'info',
};
/** A rename that fails for one source folder (named by its last part) and works for the rest. */
const failingOn = (name: string) => (a: string, b: string) => {
  if (a.endsWith(join('data', name))) throw new Error('EBUSY: in use');
  renameSync(a, b);
};

describe('devDataLayout', () => {
  it('is <root>/data/{photobook-editor,photo-tool,photoinfo-shared}', () => {
    expect(devDataLayout(root)).toEqual({
      editor: join(root, 'data', 'photobook-editor'),
      photoTool: join(root, 'data', 'photo-tool'),
      photoinfo: join(root, 'data', 'photoinfo-shared'),
    });
  });
});

describe('carryOverDevData', () => {
  it('splits the old layout', () => {
    oldLayout();
    const { moved } = carryOverDevData(root);
    expect(contents(data)).toEqual(SPLIT);
    expect(readdirSync(data).sort()).toEqual(['photo-tool', 'photobook-editor', 'photoinfo-shared']);
    expect(moved.sort()).toEqual(['exports', 'gallery', 'photobook.db', 'photoinfo']);
  });

  it('runs once', () => {
    oldLayout();
    carryOverDevData(root);
    let renames = 0;
    expect(carryOverDevData(root, () => void renames++)).toEqual({ moved: [] });
    expect(renames).toBe(0);
    expect(contents(data)).toEqual(SPLIT);
  });

  it('once split, a new file at the top of data/ is not swept into the editor', () => {
    oldLayout();
    carryOverDevData(root);
    put(join(data, 'notes.txt'));
    expect(carryOverDevData(root)).toEqual({ moved: [] });
    expect(existsSync(join(data, 'notes.txt'))).toBe(true);
  });

  it('no old data: nothing is created', () => {
    mkdirSync(data);
    expect(carryOverDevData(root)).toEqual({ moved: [] });
    expect(readdirSync(data)).toEqual([]);
    rmSync(data, { recursive: true });
    expect(carryOverDevData(root)).toEqual({ moved: [] });
    expect(existsSync(data)).toBe(false);
  });

  it('half done (photoinfo): throws naming data/photoinfo, and a second call finishes', () => {
    oldLayout();
    let err: unknown;
    try {
      carryOverDevData(root, failingOn('photoinfo'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CarryOverError);
    expect((err as CarryOverError).from).toBe(join(data, 'photoinfo'));
    expect((err as CarryOverError).step).toBe('photoinfo');
    expect((err as Error).message).toContain(join('data', 'photoinfo'));
    expect(existsSync(join(data, 'photoinfo', 'a.json'))).toBe(true); // nothing lost
    expect(carryOverDevData(root).moved.length).toBeGreaterThan(0);
    expect(contents(data)).toEqual(SPLIT);
    expect(readdirSync(data).sort()).toEqual(['photo-tool', 'photobook-editor', 'photoinfo-shared']);
  });

  it("half done (the editor's entries): a second call finishes, though some were already moved", () => {
    oldLayout();
    expect(() => carryOverDevData(root, failingOn('photobook.db'))).toThrow(CarryOverError);
    // photobook-editor itself is made last, so the next call still sees work left to do.
    expect(existsSync(join(data, 'photobook-editor'))).toBe(false);
    expect(existsSync(join(data, 'photobook.db'))).toBe(true);
    carryOverDevData(root);
    expect(contents(data)).toEqual(SPLIT);
    expect(readdirSync(data).sort()).toEqual(['photo-tool', 'photobook-editor', 'photoinfo-shared']);
  });

  it('half done (the last step, naming photobook-editor): a second call finishes', () => {
    oldLayout();
    const failLast = (a: string, b: string) => {
      if (b === join(data, 'photobook-editor')) throw new Error('EPERM');
      renameSync(a, b);
    };
    expect(() => carryOverDevData(root, failLast)).toThrow(CarryOverError);
    expect(existsSync(join(data, 'photobook-editor'))).toBe(false);
    carryOverDevData(root);
    expect(contents(data)).toEqual(SPLIT);
    expect(readdirSync(data).sort()).toEqual(['photo-tool', 'photobook-editor', 'photoinfo-shared']);
  });

  it('never merges into a folder that is there already: it throws naming it', () => {
    oldLayout();
    put(join(data, 'photo-tool', 'catalog.db'), 'newer');
    let err: CarryOverError | undefined;
    try {
      carryOverDevData(root);
    } catch (e) {
      err = e as CarryOverError;
    }
    expect(err).toBeInstanceOf(CarryOverError);
    expect(err!.from).toBe(join(data, 'gallery'));
    expect(err!.to).toBe(join(data, 'photo-tool'));
    expect(readFileSync(join(data, 'photo-tool', 'catalog.db'), 'utf8')).toBe('newer');
    expect(readFileSync(join(data, 'gallery', 'catalog.db'), 'utf8')).toBe('catalog');
  });

  it('leaves dotfiles and the dev browser profiles where they are', () => {
    oldLayout();
    put(join(data, '.gitkeep'), '');
    put(join(data, 'photobook-editor-browser', 'Preferences'), 'p');
    put(join(data, 'photo-tool-browser', 'Preferences'), 'q');
    carryOverDevData(root);
    expect(readdirSync(data).sort()).toEqual(['.gitkeep', 'photo-tool', 'photo-tool-browser', 'photobook-editor', 'photobook-editor-browser', 'photoinfo-shared']);
    expect(contents(join(data, 'photobook-editor'))).toEqual({ 'photobook.db': 'db', 'exports/x.pdf': 'pdf' });
  });

  it('only gallery and photoinfo: no editor folder is made', () => {
    put(join(data, 'gallery', 'catalog.db'), 'catalog');
    put(join(data, 'photoinfo', 'a.json'), 'info');
    carryOverDevData(root);
    expect(readdirSync(data).sort()).toEqual(['photo-tool', 'photoinfo-shared']);
  });
});

describe('when the data folders were chosen by hand, nothing is carried over', () => {
  it('devCarryOverSkipped', () => {
    expect(devCarryOverSkipped({})).toBe(false);
    for (const v of ['PHOTOBOOK_DATA_DIR', 'PHOTO_TOOL_DATA_DIR', 'PHOTOINFO_FALLBACK_DIR', 'PHOTOBOOK_PROFILE_DIR', 'PHOTO_TOOL_PROFILE_DIR']) {
      expect(devCarryOverSkipped({ [v]: join(root, 'x') }), v).toBe(true);
    }
  });

  it('each server carries over only on the default ./data paths', async () => {
    for (const program of ['photo-tool', 'photobook-editor']) {
      const { resolveDirs } = await loadDirs(program);
      const prefix = program === 'photo-tool' ? 'PHOTO_TOOL' : 'PHOTOBOOK';
      expect(resolveDirs({}, root).carryOver, program).toBe(true);
      expect(resolveDirs({ [`${prefix}_DATA_DIR`]: join(root, 'd') }, root).carryOver, program).toBe(false);
      expect(resolveDirs({ PHOTOINFO_FALLBACK_DIR: join(root, 'p') }, root).carryOver, program).toBe(false);
    }
  });
});

describe('resolveDirs', () => {
  it('both servers get the same fallback', async () => {
    const tool = (await loadDirs('photo-tool')).resolveDirs;
    const editor = (await loadDirs('photobook-editor')).resolveDirs;
    expect(tool({}, root).photoInfoFallbackDir).toBe(devDataLayout(root).photoinfo);
    expect(editor({}, root).photoInfoFallbackDir).toBe(devDataLayout(root).photoinfo);
    const env = { PHOTOINFO_FALLBACK_DIR: join(root, 'elsewhere') };
    expect(tool(env, root).photoInfoFallbackDir).toBe(join(root, 'elsewhere'));
    expect(editor(env, root).photoInfoFallbackDir).toBe(join(root, 'elsewhere'));
  });

  it("each server's own data folder is its part of the dev layout, or its _DATA_DIR", async () => {
    expect((await loadDirs('photo-tool')).resolveDirs({}, root).dataDir).toBe(devDataLayout(root).photoTool);
    expect((await loadDirs('photobook-editor')).resolveDirs({}, root).dataDir).toBe(devDataLayout(root).editor);
    expect((await loadDirs('photo-tool')).resolveDirs({ PHOTO_TOOL_DATA_DIR: join(root, 'd') }, root).dataDir).toBe(join(root, 'd'));
    expect((await loadDirs('photobook-editor')).resolveDirs({ PHOTOBOOK_DATA_DIR: join(root, 'd') }, root).dataDir).toBe(join(root, 'd'));
  });
});

describe('the dev entry points', () => {
  const read = (f: string) => readFileSync(resolve(project, f), 'utf8');

  it('each server main.ts takes its folders from dirs.ts and carries over before it opens them', () => {
    for (const program of ['photo-tool', 'photobook-editor']) {
      const main = read(`${program}/server/main.ts`);
      expect(main, program).toContain("from './dirs'");
      expect(main, program).toContain('carryOverDevDataOrQuit(');
      expect(main.indexOf('carryOverDevDataOrQuit('), program).toBeLessThan(main.search(/create(Gallery)?App\(/));
      expect(main, program).not.toMatch(/join\([^)]*'data'/);
    }
  });

  it("dev.mjs runs the carry-over script before starting, and its folders are devDataLayout's", () => {
    const dev = read('scripts/desktop/dev.mjs');
    expect(dev).toContain('scripts/carry-over-dev-data.ts');
    expect(dev.indexOf('carry-over-dev-data')).toBeLessThan(dev.indexOf('build.mjs'));
    const names = Object.values(devDataLayout('ROOT')).map((p) => p.slice(join('ROOT', 'data').length + 1));
    for (const name of [...names, 'photobook-editor-browser', 'photo-tool-browser']) expect(dev).toContain(`join(root, 'data', '${name}')`);
  });
});
