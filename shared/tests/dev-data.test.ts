// Running from source: ./data split per program, and the old one-folder layout carried over once.
// Every test works in its own temporary project root: the project's real ./data is never touched.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarryOverError } from '../electron/dataFolders';
import { carryOverDevData, carryOverDevDataOrQuit, devCarryOverParts, devDataLayout, type DevDataPart } from '../server/devData';

const project = resolve(__dirname, '../..');
type Dirs = { dataDir: string; photoInfoFallbackDir: string; carryOver: DevDataPart[] };
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
    expect(carryOverDevData(root, () => void renames++)).toEqual({ moved: [], leftovers: [] });
    expect(renames).toBe(0);
    expect(contents(data)).toEqual(SPLIT);
  });

  it('once split, a new file at the top of data/ is not swept into the editor, but is named as left over', () => {
    oldLayout();
    carryOverDevData(root);
    put(join(data, 'notes.txt'));
    expect(carryOverDevData(root)).toEqual({ moved: [], leftovers: [join(data, 'notes.txt')] });
    expect(existsSync(join(data, 'notes.txt'))).toBe(true);
  });

  it('no old data: nothing is created', () => {
    mkdirSync(data);
    expect(carryOverDevData(root)).toEqual({ moved: [], leftovers: [] });
    expect(readdirSync(data)).toEqual([]);
    rmSync(data, { recursive: true });
    expect(carryOverDevData(root)).toEqual({ moved: [], leftovers: [] });
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

  it('never merges into a folder that is there already: the old one is left and named, the other parts still move', () => {
    oldLayout();
    put(join(data, 'photo-tool', 'catalog.db'), 'newer');
    const result = carryOverDevData(root);
    expect(result.leftovers).toEqual([join(data, 'gallery')]);
    expect(readFileSync(join(data, 'photo-tool', 'catalog.db'), 'utf8')).toBe('newer');
    expect(readFileSync(join(data, 'gallery', 'catalog.db'), 'utf8')).toBe('catalog');
    expect(contents(join(data, 'photobook-editor'))).toEqual({ 'photobook.db': 'db', 'exports/x.pdf': 'pdf' });
    expect(contents(join(data, 'photoinfo-shared'))).toEqual({ 'a.json': 'info' });
  });

  it('never overwrites inside the staging folder: a clash there throws naming it', () => {
    oldLayout();
    put(join(data, 'photobook-editor.moving', 'photobook.db'), 'staged');
    let err: CarryOverError | undefined;
    try {
      carryOverDevData(root);
    } catch (e) {
      err = e as CarryOverError;
    }
    expect(err).toBeInstanceOf(CarryOverError);
    expect(err!.from).toBe(join(data, 'photobook.db'));
    expect(err!.to).toBe(join(data, 'photobook-editor.moving', 'photobook.db'));
    expect(readFileSync(join(data, 'photobook.db'), 'utf8')).toBe('db');
    expect(readFileSync(join(data, 'photobook-editor.moving', 'photobook.db'), 'utf8')).toBe('staged');
  });

  it('photobook-editor there already: old entries, a half-filled staging folder, gallery and photoinfo are named as left over, not merged', () => {
    oldLayout();
    put(join(data, 'photobook-editor', 'photobook.db'), 'interim');
    put(join(data, 'photo-tool', 'catalog.db'), 'interim');
    put(join(data, 'photoinfo-shared', 'b.json'), 'interim');
    put(join(data, 'photobook-editor.moving', 'old.db'), 'staged');
    const before = contents(data);
    let renames = 0;
    const result = carryOverDevData(root, () => void renames++);
    expect(renames).toBe(0);
    expect(result.moved).toEqual([]);
    expect([...result.leftovers].sort()).toEqual(['exports', 'gallery', 'photobook-editor.moving', 'photobook.db', 'photoinfo'].map((n) => join(data, n)).sort());
    expect(contents(data)).toEqual(before);
  });

  it('carryOverDevDataOrQuit warns about each leftover, saying where it belongs and to move it by hand', () => {
    oldLayout();
    put(join(data, 'photobook-editor', 'photobook.db'), 'interim');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = carryOverDevDataOrQuit(root);
      expect(result.leftovers).toEqual([join(data, 'exports'), join(data, 'photobook.db')]);
      const text = warn.mock.calls.flat().join('\n');
      for (const l of result.leftovers) expect(text).toContain(l);
      expect(text).toContain(join(data, 'photobook-editor'));
      expect(text).toMatch(/by hand/);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
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

describe('a folder chosen by hand skips only its own part (Ruling B)', () => {
  it('devCarryOverParts', () => {
    expect(devCarryOverParts({})).toEqual(['editor', 'photoTool', 'photoinfo']);
    expect(devCarryOverParts({ PHOTOBOOK_DATA_DIR: 'x' })).toEqual(['photoTool', 'photoinfo']);
    expect(devCarryOverParts({ PHOTOBOOK_PROFILE_DIR: 'x' })).toEqual(['photoTool', 'photoinfo']);
    expect(devCarryOverParts({ PHOTO_TOOL_DATA_DIR: 'x' })).toEqual(['editor', 'photoinfo']);
    expect(devCarryOverParts({ PHOTO_TOOL_PROFILE_DIR: 'x' })).toEqual(['editor', 'photoinfo']);
    expect(devCarryOverParts({ PHOTOINFO_FALLBACK_DIR: 'x' })).toEqual(['editor', 'photoTool']);
    expect(devCarryOverParts({ PHOTOINFO_FALLBACK_DIR: 'x' }, ['editor', 'photoinfo'])).toEqual(['editor']);
  });

  it("the editor's PHOTOBOOK_DATA_DIR set: Photo Tool's data and the photo info still move, the editor's entries stay", () => {
    oldLayout();
    carryOverDevData(root, undefined, devCarryOverParts({ PHOTOBOOK_DATA_DIR: join(root, 'elsewhere') }));
    expect(contents(data)).toEqual({ 'photobook.db': 'db', 'exports/x.pdf': 'pdf', 'photo-tool/catalog.db': 'catalog', 'photoinfo-shared/a.json': 'info' });
  });

  it("Photo Tool's PHOTO_TOOL_DATA_DIR set: the editor's data and the photo info still move, gallery stays", () => {
    oldLayout();
    carryOverDevData(root, undefined, devCarryOverParts({ PHOTO_TOOL_DATA_DIR: join(root, 'elsewhere') }));
    expect(contents(data)).toEqual({ 'photobook-editor/photobook.db': 'db', 'photobook-editor/exports/x.pdf': 'pdf', 'gallery/catalog.db': 'catalog', 'photoinfo-shared/a.json': 'info' });
  });

  it('PHOTOINFO_FALLBACK_DIR set: photoinfo stays, both programs still move', () => {
    oldLayout();
    carryOverDevData(root, undefined, devCarryOverParts({ PHOTOINFO_FALLBACK_DIR: join(root, 'elsewhere') }));
    expect(contents(data)).toEqual({ 'photobook-editor/photobook.db': 'db', 'photobook-editor/exports/x.pdf': 'pdf', 'photo-tool/catalog.db': 'catalog', 'photoinfo/a.json': 'info' });
  });

  it('a server carries over its own part and the photo info only', async () => {
    expect((await loadDirs('photobook-editor')).resolveDirs({}, root).carryOver).toEqual(['editor', 'photoinfo']);
    expect((await loadDirs('photo-tool')).resolveDirs({}, root).carryOver).toEqual(['photoTool', 'photoinfo']);
    expect((await loadDirs('photobook-editor')).resolveDirs({ PHOTOBOOK_DATA_DIR: 'd' }, root).carryOver).toEqual(['photoinfo']);
    expect((await loadDirs('photo-tool')).resolveDirs({ PHOTOINFO_FALLBACK_DIR: 'p' }, root).carryOver).toEqual(['photoTool']);
  });

  it("Playwright's server environments carry nothing over (playwright.config.ts)", async () => {
    oldLayout();
    const before = contents(data);
    const noRename = () => {
      throw new Error('no rename expected');
    };
    const editor = (await loadDirs('photobook-editor')).resolveDirs({ PHOTOBOOK_DATA_DIR: 'test-results/e2e-data', PHOTOINFO_FALLBACK_DIR: 'test-results/e2e-photoinfo' }, root);
    const tool = (await loadDirs('photo-tool')).resolveDirs({ PHOTO_TOOL_DATA_DIR: 'test-results/e2e-photo-tool', PHOTOINFO_FALLBACK_DIR: 'test-results/e2e-photo-tool-photoinfo' }, root);
    expect(editor.carryOver).toEqual([]);
    expect(tool.carryOver).toEqual([]);
    expect(carryOverDevData(root, noRename, editor.carryOver)).toEqual({ moved: [], leftovers: [] });
    expect(carryOverDevData(root, noRename, tool.carryOver)).toEqual({ moved: [], leftovers: [] });
    expect(contents(data)).toEqual(before);
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

  it('only the _PROFILE_DIR given: the data goes beside it, not into the part its own carry-over skipped (final review, Important 1)', async () => {
    for (const [program, prefix, part] of [['photo-tool', 'PHOTO_TOOL', 'photoTool'], ['photobook-editor', 'PHOTOBOOK', 'editor']] as const) {
      const dirs = (await loadDirs(program)).resolveDirs({ [`${prefix}_PROFILE_DIR`]: join(root, 'chosen', 'profile') }, root);
      expect(dirs.carryOver, program).not.toContain(part);
      expect(dirs.dataDir, program).toBe(join(root, 'chosen', 'profile-data'));
    }
  });
});

describe('the dev entry points', () => {
  const read = (f: string) => readFileSync(resolve(project, f), 'utf8');

  it('each server main.ts takes its folders from dirs.ts and carries over before it opens them', () => {
    for (const program of ['photo-tool', 'photobook-editor']) {
      const main = read(`${program}/server/main.ts`);
      expect(main, program).toContain("from './dirs'");
      expect(main, program).toMatch(/^carryOverDevDataOrQuit\(.*, carryOver\);$/m);
      expect(main.indexOf('carryOverDevDataOrQuit('), program).toBeLessThan(main.search(/create(Gallery)?App\(/));
      expect(main, program).not.toMatch(/join\([^)]*'data'/);
    }
  });

  it("draft-from-folder.ts writes into the editor's folder from dirs.ts, after the carry-over", () => {
    const draft = read('scripts/draft-from-folder.ts');
    expect(draft).toContain("from '../photobook-editor/server/dirs'");
    expect(draft).not.toMatch(/\?\? 'data'/);
    expect(draft).toMatch(/^carryOverDevDataOrQuit\(.*, carryOver\);$/m);
    expect(draft.indexOf('carryOverDevDataOrQuit(')).toBeLessThan(draft.indexOf('createApp('));
  });

  it('the macOS launcher runs the editor on ./data/photobook-editor, after the carry-over', () => {
    const start = read('scripts/launcher/start.sh');
    const stop = read('scripts/launcher/stop.sh');
    // The shell scripts cannot import devDataLayout: pinned to it here.
    expect(devDataLayout('$PROJECT').editor.replace(/\\/g, '/')).toBe('$PROJECT/data/photobook-editor');
    const editorDefault = 'DATA="${PHOTOBOOK_DATA_DIR:-$PROJECT/data/photobook-editor}"';
    expect(start).toContain(editorDefault);
    expect(stop).toContain(editorDefault);
    const carry = start.indexOf('scripts/carry-over-dev-data.ts');
    expect(carry).toBeGreaterThan(-1);
    expect(carry).toBeLessThan(start.indexOf('mkdir -p "$DATA"'));
    // The editor's page is built where the server serves it from (webDir('photobook-editor')).
    expect(start).toContain('vite build --config photobook-editor/vite.config.ts');
    expect(start).toContain('$PROJECT/dist/photobook-editor/web/index.html');
  });

  it("dev.mjs runs the carry-over script before starting, and its folders are devDataLayout's", () => {
    const dev = read('scripts/desktop/dev.mjs');
    expect(dev).toContain('scripts/carry-over-dev-data.ts');
    expect(dev.indexOf('carry-over-dev-data')).toBeLessThan(dev.indexOf('build.mjs'));
    const names = Object.values(devDataLayout('ROOT')).map((p) => p.slice(join('ROOT', 'data').length + 1));
    for (const name of [...names, 'photobook-editor-browser', 'photo-tool-browser']) expect(dev).toContain(`join(root, 'data', '${name}')`);
  });

  it('dev.mjs: only a _PROFILE_DIR given puts the data beside it, as resolveDirs does', () => {
    const dev = read('scripts/desktop/dev.mjs');
    for (const prefix of ['PHOTOBOOK', 'PHOTO_TOOL']) expect(dev).toContain(`process.env.${prefix}_PROFILE_DIR ? \`\${resolve(process.env.${prefix}_PROFILE_DIR)}-data\``);
  });
});
