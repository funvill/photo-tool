// Running away from the source tree and off macOS: where the server finds its fonts and data files
// (from source, or from a packaged resource folder), and home / drive / UNC paths in the folder browser.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FONT_FAMILIES, fontFilePath } from '../src/core';
import { createApp } from '../src/server/app';
import { DRIVES, DRIVES_LABEL, browseParent, browsePath, expandHome } from '../src/server/folders';
import { resolveFolder } from '../src/server/importer';
import { licenceFiles } from '../scripts/make-notices';
import { fontFile, libheifFile, pdfiumDir, projectRoot, resourceRoot, setResourceRoot, webDir, worldAtlasFile } from '../src/server/resources';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), name));
const HEIC_FIXTURE = join(process.cwd(), 'fixtures', 'generated', 'trip', 'day2-06-heic-sunset.heic');

async function serve(dataDir: string, opts: Parameters<typeof createApp>[1] = {}) {
  const { app, store } = createApp(dataDir, opts);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: async (path: string) => {
      const res = await fetch(base + path);
      return { status: res.status, body: (await res.json()) as any };
    },
    post: async (path: string, body: unknown) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    },
    close: () => {
      server.close();
      store.close();
    },
  };
}

describe('resource paths', () => {
  const saved = process.env.PHOTOBOOK_RESOURCE_ROOT;
  afterEach(() => {
    setResourceRoot(null);
    if (saved === undefined) delete process.env.PHOTOBOOK_RESOURCE_ROOT;
    else process.env.PHOTOBOOK_RESOURCE_ROOT = saved;
  });

  it('from source: the project folders, with nothing configured', () => {
    delete process.env.PHOTOBOOK_RESOURCE_ROOT;
    expect(resourceRoot()).toBeNull();
    expect(projectRoot()).toBe(process.cwd());
    expect(fontFile(fontFilePath('Inter', 400))).toBe(join(process.cwd(), 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'));
    expect(existsSync(fontFile(fontFilePath('Lora', 700, true)))).toBe(true);
    expect(worldAtlasFile()).toBe(join(process.cwd(), 'node_modules/world-atlas/countries-10m.json'));
    expect(existsSync(worldAtlasFile())).toBe(true);
    expect(webDir()).toBe(join(process.cwd(), 'dist/web'));
  });

  it('with a resource root: one flat folder, set by the host or by PHOTOBOOK_RESOURCE_ROOT', () => {
    const root = tmp('res-');
    process.env.PHOTOBOOK_RESOURCE_ROOT = root;
    expect(resourceRoot()).toBe(root);
    expect(fontFile(fontFilePath('Playfair Display', 700, true))).toBe(join(root, 'fonts', 'playfair-display-latin-700-italic.woff'));
    expect(worldAtlasFile()).toBe(join(root, 'world-atlas', 'countries-10m.json'));
    expect(webDir()).toBe(join(root, 'web'));
    // The host's own setting wins over the environment.
    const other = tmp('res-');
    setResourceRoot(other);
    expect(fontFile(fontFilePath('Inter', 400))).toBe(join(other, 'fonts', 'inter-latin-400-normal.woff'));
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it('no server module looks for its files when it loads', async () => {
    // The paths are read at call time: pointing at an empty folder after import changes what is found.
    const { textOutline } = await import('../src/server/textOutline');
    const { suggestPlaces } = await import('../src/server/places');
    const empty = tmp('res-empty-');
    setResourceRoot(empty);
    expect(() => textOutline({ text: 'Hi', fontFamily: 'Amatic SC', fontWeight: 700 } as Parameters<typeof textOutline>[0])).toThrow(/ENOENT/);
    expect(() => suggestPlaces([[139.75, 35.68]])).toThrow(/ENOENT/);
    rmSync(empty, { recursive: true, force: true });
  });

  describe('collected resources (scripts/collect-resources.ts)', () => {
    let root: string;
    let data: string;
    beforeAll(() => {
      root = tmp('res-collected-');
      data = tmp('res-data-');
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/collect-resources.ts', root], { stdio: 'pipe' });
    }, 60_000);
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    });

    it('holds exactly the fonts the exporter embeds and the one world-atlas file', () => {
      const expected = FONT_FAMILIES.flatMap((f) => f.weights.flatMap((w) => [`${f.pkg}-latin-${w}-normal.woff`, ...(f.italic ? [`${f.pkg}-latin-${w}-italic.woff`] : [])])).sort();
      expect(readdirSync(join(root, 'fonts')).sort()).toEqual(expected);
      expect(readdirSync(join(root, 'world-atlas'))).toEqual(['countries-10m.json']);
      // The two WebAssembly engines, each with its licence beside it.
      expect(readdirSync(join(root, 'libheif')).sort()).toEqual(['LICENSE', 'LICENSE.libheif-js', 'libheif-bundle.js', 'package.json']);
      expect(readdirSync(join(root, 'pdfium')).sort()).toEqual(['LICENSE.md', 'index.cjs', 'pdfium.wasm']);
      expect(readdirSync(root).sort()).toEqual(['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'fonts', 'libheif', 'pdfium', 'world-atlas']);
    });

    it('carries the app\'s licence and the third-party notices (scripts/make-notices.ts)', () => {
      expect(readFileSync(join(root, 'LICENSE.txt'), 'utf8')).toBe(readFileSync('LICENSE', 'utf8'));
      const notices = readFileSync(join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8').replace(/\r\n/g, '\n');
      // Every package the app depends on directly is named with the version installed.
      const { dependencies } = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
      for (const name of Object.keys(dependencies)) {
        const { version } = JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8')) as { version: string };
        expect(notices, name).toContain(`\n${name} ${version}\n`);
      }
      // The LGPL parts: the licence text itself, and where the source of each can be had.
      expect(notices).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
      expect(notices).toContain('GNU GENERAL PUBLIC LICENSE');
      for (const source of ['github.com/lovell/sharp-libvips', 'github.com/strukturag/libheif', 'github.com/strukturag/libde265', 'pdfium.googlesource.com/pdfium']) expect(notices).toContain(source);
      expect(notices).toContain('SIL OPEN FONT LICENSE');
      // Nothing is made up: a text the installed packages do not carry is marked, not filled in.
      expect(notices).not.toMatch(/\bundefined\b|\[object Object\]/);
    });

    it('a server pointed at it draws text and places from there, and exports a PDF', async () => {
      const s = await serve(data, { resourceRoot: root });
      try {
        expect(resourceRoot()).toBe(root);
        expect((await s.post('/api/text-outline', { text: 'Hello', fontFamily: 'Playfair Display', fontWeight: 700 })).status).toBe(200);
        const places = await s.post('/api/places/suggest', { points: [[-123.1, 49.3]] });
        expect(places.status).toBe(200);
        expect(JSON.stringify(places.body)).toContain('Canada');
        const id = (await s.post('/api/projects', { title: 'Packaged', sizeId: 'sq8' })).body.doc.id;
        const exported = await s.post(`/api/projects/${id}/export`, {});
        expect(exported.status).toBe(200);
        expect(exported.body.verification.ok).toBe(true);
      } finally {
        s.close();
      }
    }, 60_000);

    it.runIf(existsSync(HEIC_FIXTURE))('a server pointed at it opens HEIC photos and renders a poster image with the engines from there', async () => {
      const photos = tmp('res-photos-');
      copyFileSync(HEIC_FIXTURE, join(photos, 'IMG_0001.HEIC'));
      const s = await serve(data, { resourceRoot: root });
      try {
        expect(libheifFile()).toBe(join(root, 'libheif', 'libheif-bundle.js'));
        expect(pdfiumDir()).toBe(join(root, 'pdfium'));
        const id = (await s.post('/api/projects', { title: 'Packaged poster', product: 'poster', sizeId: 'p11x14' })).body.doc.id;
        let job = (await s.post(`/api/projects/${id}/import`, { folder: photos })).body;
        while (job.status !== 'done' && job.status !== 'failed') {
          await new Promise((r) => setTimeout(r, 50));
          job = (await s.get(`/api/jobs/${job.id}`)).body;
        }
        expect(job).toMatchObject({ status: 'done', imported: 1, errors: [] });
        const image = await s.post(`/api/projects/${id}/export-image`, { format: 'png', dpi: 72 });
        expect(image.status).toBe(200);
        expect([image.body.widthPx, image.body.heightPx]).toEqual([792, 1008]);
      } finally {
        s.close();
        rmSync(photos, { recursive: true, force: true });
      }
    }, 60_000);
  });
});

describe('third-party notices (scripts/make-notices.ts)', () => {
  it('find a licence file under any usual name, the LICENCE spelling and a prefix included', () => {
    const dir = tmp('notices-');
    try {
      for (const f of ['MIT-LICENCE.txt', 'LICENSE', 'licence.md', 'COPYING', 'NOTICE', 'LICENSE-MIT', 'Apache-LICENSE.txt', 'license.js', 'README.md', 'licensed-things.txt', 'package.json', 'mylicense.txt']) writeFileSync(join(dir, f), 'x');
      expect(licenceFiles(dir).map((f) => f.slice(dir.length + 1)).sort()).toEqual(['Apache-LICENSE.txt', 'COPYING', 'LICENSE', 'LICENSE-MIT', 'MIT-LICENCE.txt', 'NOTICE', 'licence.md'].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('home folder and folder browser paths', () => {
  it('~ is the home folder, with either slash', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/Pictures', '/Users/sam')).toBe('/Users/sam/Pictures');
    expect(expandHome('~\\Pictures', 'C:\\Users\\sam')).toBe('C:\\Users\\sam\\Pictures');
    // Not a home path: a name that only starts with ~, and a home folder with `$` in it stays literal.
    expect(expandHome('~backup/x', '/Users/sam')).toBe('~backup/x');
    expect(expandHome('~/x', 'C:\\Users\\$&')).toBe('C:\\Users\\$&/x');
    expect(resolveFolder('~')).toBe(homedir());
    expect(resolveFolder('~/Pictures/Studio Shelf')).toBe(join(homedir(), 'Pictures', 'Studio Shelf'));
  });

  it('Windows: drives, the list of drives above them, and UNC shares', () => {
    const home = 'C:\\Users\\sam';
    const at = (raw: string) => browsePath(raw, 'win32', home);
    expect(at('')).toBe(home);
    expect(at('~')).toBe(home);
    expect(at('~\\Pictures')).toBe('C:\\Users\\sam\\Pictures');
    expect(at('~/Pictures')).toBe('C:\\Users\\sam\\Pictures');
    expect(at('C:\\Users/sam')).toBe('C:\\Users\\sam'); // the editor joins with "/"
    expect(at('d:')).toBe('d:\\'); // not "the current folder on D:"
    expect(at('/')).toBe(DRIVES);
    expect(at('\\')).toBe(DRIVES);
    // The label the path box shows there, submitted back, is the same place: not a folder of that name.
    expect(at(DRIVES_LABEL)).toBe(DRIVES);
    expect(at(' this pc ')).toBe(DRIVES);
    expect(at('C:\\This PC')).toBe('C:\\This PC');
    expect(at('//C:')).toBe('C:\\'); // a drive clicked in the list of drives
    expect(at('//C:/Users')).toBe('C:\\Users');
    expect(at('\\\\nas\\photos\\2023')).toBe('\\\\nas\\photos\\2023');
    expect(at('//nas/photos/2023')).toBe('\\\\nas\\photos\\2023');

    const up = (path: string) => browseParent(path, 'win32');
    expect(up('C:\\Users\\sam')).toBe('C:\\Users');
    expect(up('C:\\Users')).toBe('C:\\');
    expect(up('C:\\')).toBe(DRIVES);
    expect(up(DRIVES)).toBeNull();
    expect(up('\\\\nas\\photos\\2023')).toBe('\\\\nas\\photos\\');
    expect(up('\\\\nas\\photos\\')).toBe(DRIVES);
  });

  it('macOS and Linux: unchanged, / is the top', () => {
    const at = (raw: string) => browsePath(raw, 'darwin', '/Users/sam');
    expect(at('')).toBe('/Users/sam');
    expect(at('~/Pictures')).toBe('/Users/sam/Pictures');
    expect(at('/Volumes/Photos/')).toBe('/Volumes/Photos');
    expect(at('/')).toBe('/');
    expect(at('/This PC')).toBe('/This PC'); // only Windows has a list of drives
    expect(browseParent('/Users/sam', 'linux')).toBe('/Users');
    expect(browseParent('/Users', 'linux')).toBe('/');
    expect(browseParent('/', 'linux')).toBeNull();
  });

  describe('GET /api/fs', () => {
    let s: Awaited<ReturnType<typeof serve>>;
    let data: string;
    let photos: string;
    beforeAll(async () => {
      data = tmp('fs-data-');
      photos = tmp('fs-photos-');
      mkdirSync(join(photos, 'album'));
      mkdirSync(join(photos, '.hidden'));
      writeFileSync(join(photos, 'a.jpg'), '');
      s = await serve(data);
    });
    afterAll(() => {
      s.close();
      rmSync(data, { recursive: true, force: true });
      rmSync(photos, { recursive: true, force: true });
    });
    const fs = (path?: string) => s.get(`/api/fs${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`);

    it('opens the home folder by default and for ~', async () => {
      expect((await fs()).body.path).toBe(homedir());
      expect((await fs('~')).body.path).toBe(homedir());
      expect((await fs('~')).body.parent).toBeTruthy();
    });

    it('lists a folder, and a subfolder joined the way the editor does it', async () => {
      const top = await fs(photos);
      expect(top.body).toMatchObject({ path: photos, folders: ['album'], photos: 1 });
      const inner = await fs(`${top.body.path}/album`);
      expect(inner.body).toMatchObject({ path: join(photos, 'album'), parent: photos, folders: [], photos: 0 });
      expect((await fs(join(photos, 'nope'))).status).toBe(404);
    });

    it.runIf(process.platform === 'win32')('Windows: going up from a drive reaches the list of drives, and each one opens', async () => {
      const drive = homedir().slice(0, 2); // "C:"
      const root = await fs(`${drive}\\`);
      expect(root.status).toBe(200);
      expect(root.body.parent).toBe(DRIVES);
      const drives = await fs(root.body.parent);
      // Not a folder: flagged so the editor offers nothing to choose, and labelled for the path box.
      expect(drives.body).toMatchObject({ path: DRIVES, label: DRIVES_LABEL, drives: true, parent: null, photos: 0 });
      expect((await fs(DRIVES_LABEL)).body).toEqual(drives.body);
      expect(root.body.drives).toBeUndefined();
      expect(root.body.label).toBeUndefined();
      expect(drives.body.folders.map((d: string) => d.toUpperCase())).toContain(drive.toUpperCase());
      // What the editor asks for when a drive is clicked.
      const opened = await fs(`${drives.body.path}/${drive}`);
      expect(opened.body.path.toUpperCase()).toBe(`${drive}\\`.toUpperCase());
      expect(opened.body.folders.length).toBeGreaterThan(0);
    });

    it.runIf(process.platform !== 'win32')('macOS and Linux: / has no parent', async () => {
      const top = (await fs('/')).body;
      expect(top).toMatchObject({ path: '/', parent: null });
      // A real folder that can be chosen: no drive-list flag and no label.
      expect(top.drives).toBeUndefined();
      expect(top.label).toBeUndefined();
    });
  });
});
