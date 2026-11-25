// The desktop shell's start-up decisions that need no Electron (shared/electron/config.ts): where each
// program keeps its data, where the shared photo info lives, the folder given on the command line, the
// self-test flags, the remembered window place, and how failures and Help > About are put into words.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, MIN_WINDOW, NOTICES_BUTTON, dataLayout, describeAbout, describeFailure, launchFolder, parseSelfTest, photoInfoFallbackDir, restoreWindow, selfTestOverlap } from '../electron/config';

const root = resolve(__dirname, '../..');

describe('launchFolder', () => {
  it('takes the first argument that is not a flag', () => {
    expect(launchFolder(['C:/PT/Photo Tool.exe', 'D:/pics'], false)).toBe('D:/pics');
    expect(launchFolder(['electron', 'dist/photo-tool/dev', 'D:/pics'], true)).toBe('D:/pics');
    expect(launchFolder(['exe', '--some-flag', 'D:/pics'], false)).toBe('D:/pics');
    expect(launchFolder(['exe'], false)).toBeNull();
  });

  it('never takes a self-test folder', () => {
    expect(launchFolder(['exe', '--self-test', 'D:/fx', '--self-test-out', 'D:/o'], false)).toBeNull();
  });
});

describe('photoInfoFallbackDir', () => {
  const appData = resolve('/appdata');

  it('is beside both programs\' folders, with " Dev" from source', () => {
    expect(photoInfoFallbackDir({ appData, packaged: true, env: {} })).toBe(join(appData, 'Photo Tools Shared', 'photoinfo'));
    expect(photoInfoFallbackDir({ appData, packaged: false, env: {} })).toBe(join(appData, 'Photo Tools Shared Dev', 'photoinfo'));
  });

  it('PHOTOINFO_FALLBACK_DIR wins', () => {
    expect(photoInfoFallbackDir({ appData, packaged: true, env: { PHOTOINFO_FALLBACK_DIR: resolve('/given') }, selfTestOut: resolve('/out') })).toBe(resolve('/given'));
  });

  it('a self-test keeps it in its output folder', () => {
    expect(photoInfoFallbackDir({ appData, packaged: true, env: {}, selfTestOut: resolve('/out') })).toBe(join(resolve('/out'), 'photoinfo-shared'));
  });

  it('is the same for both programs', () => {
    // It takes no program: the editor and Photo Tool, called the same way, share one folder.
    const editor = photoInfoFallbackDir({ appData, packaged: false, env: { PHOTOBOOK_DATA_DIR: resolve('/e') } });
    const photoTool = photoInfoFallbackDir({ appData, packaged: false, env: { PHOTO_TOOL_DATA_DIR: resolve('/p') } });
    expect(editor).toBe(photoTool);
    expect(photoInfoFallbackDir.length).toBe(1);
  });
});

describe('desktop folders', () => {
  const base = { appData: resolve('/appdata'), productName: 'Photobook Editor', packaged: true, env: {}, envPrefix: 'PHOTOBOOK' };

  it('keeps the app\'s data and Chromium\'s profile in separate folders', () => {
    const l = dataLayout(base);
    expect(l.root).toBe(join(resolve('/appdata'), 'Photobook Editor'));
    expect(l.dataDir).toBe(join(resolve('/appdata'), 'Photobook Editor', 'data'));
    expect(l.profileDir).toBe(join(resolve('/appdata'), 'Photobook Editor', 'browser'));
  });

  it('PHOTOBOOK_DATA_DIR moves the data only', () => {
    const l = dataLayout({ ...base, env: { PHOTOBOOK_DATA_DIR: resolve('/somewhere/data') } });
    expect(l.dataDir).toBe(resolve('/somewhere/data'));
    expect(l.profileDir).toBe(join(resolve('/appdata'), 'Photobook Editor', 'browser'));
  });

  it('with envPrefix PHOTO_TOOL reads PHOTO_TOOL_DATA_DIR and ignores PHOTOBOOK_DATA_DIR', () => {
    const appData = resolve('/appdata');
    const photoTool = { appData, productName: 'Photo Tool', packaged: true, envPrefix: 'PHOTO_TOOL' };
    expect(dataLayout({ ...photoTool, env: { PHOTOBOOK_DATA_DIR: resolve('/editor/data'), PHOTOBOOK_PROFILE_DIR: resolve('/editor/profile') } })).toEqual({
      root: join(appData, 'Photo Tool'),
      dataDir: join(appData, 'Photo Tool', 'data'),
      profileDir: join(appData, 'Photo Tool', 'browser'),
    });
    expect(dataLayout({ ...photoTool, env: { PHOTO_TOOL_DATA_DIR: resolve('/p/data'), PHOTO_TOOL_PROFILE_DIR: resolve('/p/profile') } })).toMatchObject({ dataDir: resolve('/p/data'), profileDir: resolve('/p/profile') });
    expect(dataLayout({ ...photoTool, packaged: false, env: {} }).dataDir).toBe(join(appData, 'Photo Tool Dev', 'data'));
  });

  it('a self-test keeps its data inside its output folder, never in a real user\'s', () => {
    for (const packaged of [true, false]) {
      const l = dataLayout({ ...base, packaged, selfTestOut: resolve('/out') });
      expect(l.dataDir).toBe(join(resolve('/out'), 'data'));
      expect(l.dataDir.startsWith(resolve('/appdata'))).toBe(false);
    }
    // Only an explicit PHOTOBOOK_DATA_DIR points a self-test anywhere else.
    expect(dataLayout({ ...base, env: { PHOTOBOOK_DATA_DIR: resolve('/somewhere/data') }, selfTestOut: resolve('/out') }).dataDir).toBe(resolve('/somewhere/data'));
  });

  it('a self-test uses its own profile, and a copy run from source its own name', () => {
    expect(dataLayout({ ...base, selfTestOut: resolve('/out') }).profileDir).toBe(join(resolve('/out'), 'profile'));
    expect(dataLayout({ ...base, env: { PHOTOBOOK_PROFILE_DIR: resolve('/p') }, selfTestOut: resolve('/out') }).profileDir).toBe(resolve('/p'));
    expect(dataLayout({ ...base, packaged: false }).dataDir).toBe(join(resolve('/appdata'), 'Photobook Editor Dev', 'data'));
  });
});

describe('self-test flags', () => {
  it('needs both folders, given explicitly', () => {
    expect(parseSelfTest(['app.exe'])).toBeNull();
    expect(parseSelfTest(['app.exe', '--self-test', 'photos'])).toBeNull();
    expect(parseSelfTest(['app.exe', '--self-test-out', 'out'])).toBeNull();
    expect(parseSelfTest(['app.exe', '--self-test', '--self-test-out', 'out'])).toBeNull();
    expect(parseSelfTest(['app.exe', '--self-test', 'photos', '--self-test-out', 'out'])).toEqual({ photos: resolve('photos'), out: resolve('out') });
    // Other flags around them change nothing.
    expect(parseSelfTest(['app.exe', '--gallery', 'D:\\Pics', '--self-test', 'photos', '--self-test-out', 'out'])).toEqual({ photos: resolve('photos'), out: resolve('out') });
  });

  describe("the photos and output folder must not overlap", () => {
    it('refuses the same folder', () => {
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x\\photos', 'win32')).toMatch(/same folder/);
      expect(selfTestOverlap('/home/a/photos', '/home/a/photos/', 'linux')).toMatch(/same folder/);
    });

    it('refuses an output folder inside the photos', () => {
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x\\photos\\out', 'win32')).toMatch(/inside/);
      expect(selfTestOverlap('/home/a/photos', '/home/a/photos/out', 'linux')).toMatch(/inside/);
    });

    it('refuses photos inside the output folder (its photos copy would replace them)', () => {
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x', 'win32')).toMatch(/inside/);
      expect(selfTestOverlap('D:\\', 'D:\\', 'win32')).toMatch(/same folder/);
      expect(selfTestOverlap('D:\\pics', 'D:\\', 'win32')).toMatch(/inside/);
      expect(selfTestOverlap('/home/a/photos', '/home/a', 'linux')).toMatch(/inside/);
    });

    it('allows sibling folders, even with a shared name prefix', () => {
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x\\out', 'win32')).toBeNull();
      expect(selfTestOverlap('D:\\x\\photos', 'D:\\x\\photos-out', 'win32')).toBeNull();
      expect(selfTestOverlap('/home/a/photos', '/home/a/photos-out', 'linux')).toBeNull();
    });

    it('ignores case on Windows only', () => {
      expect(selfTestOverlap('D:\\X\\Photos', 'd:\\x\\photos', 'win32')).toMatch(/same folder/);
      expect(selfTestOverlap('D:\\X\\Photos', 'd:\\x\\photos\\out', 'win32')).toMatch(/inside/);
      expect(selfTestOverlap('/home/a/Photos', '/home/a/photos', 'linux')).toBeNull();
    });
  });
});

describe('remembered window place', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  it('starts at the default size when nothing (or nonsense) was saved', () => {
    for (const saved of [null, undefined, 'x', {}, { bounds: { x: 'a', y: 0, width: 800, height: 600 } }]) {
      expect(restoreWindow(saved, screens)).toEqual({ bounds: DEFAULT_WINDOW, maximized: false });
    }
  });

  it('reopens where it was', () => {
    expect(restoreWindow({ bounds: { x: 100, y: 50, width: 1200, height: 800 }, maximized: true }, screens)).toEqual({ bounds: { x: 100, y: 50, width: 1200, height: 800 }, maximized: true });
  });

  it('keeps the size but not the place when that screen is gone', () => {
    expect(restoreWindow({ bounds: { x: 2500, y: 50, width: 1200, height: 800 } }, screens)).toEqual({ bounds: { width: 1200, height: 800 }, maximized: false });
    expect(restoreWindow({ bounds: { x: 2500, y: 50, width: 1200, height: 800 } }, [...screens, { x: 1920, y: 0, width: 1920, height: 1040 }]).bounds.x).toBe(2500);
  });

  it('never opens smaller than the minimum', () => {
    expect(restoreWindow({ bounds: { x: 0, y: 0, width: 10, height: 10 } }, screens).bounds).toMatchObject(MIN_WINDOW);
  });
});

describe('failure wording', () => {
  const ctx = { productName: 'Photobook Editor', dataDir: 'C:\\Users\\me\\AppData\\Roaming\\Photobook Editor\\data' };

  it('says what went wrong without the stack trace', () => {
    const cases: [string, 'start' | 'run' | 'page', RegExp][] = [
      ['Error: EACCES: permission denied, mkdir \'X:\\data\'', 'start', /could not save to its data folder/],
      ['Error: unable to open database file', 'start', /could not save to its data folder/],
      ['Error: Could not load the "sharp" module using the win32-x64 runtime\nERR_DLOPEN_FAILED', 'start', /reads photos could not be loaded/],
      ['Error: App files are missing:\n  C:\\x\\web\\index.html', 'start', /files are missing or damaged/],
      ['Error: something else', 'start', /ran into a problem while starting/],
      ['The local server stopped unexpectedly (exit code 1).', 'run', /stopped unexpectedly/],
      ['ERR_CONNECTION_REFUSED', 'page', /window could not load/],
    ];
    for (const [detail, phase, expected] of cases) {
      const f = describeFailure(detail, { ...ctx, phase });
      expect(f.message, detail).toMatch(expected);
      expect(f.message + f.advice + f.title).not.toMatch(/Error:|ERR_|EACCES|\bat \w+ \(/);
      expect(f.advice.length).toBeGreaterThan(10);
    }
    expect(describeFailure('EPERM', { ...ctx, phase: 'start' }).message).toContain(ctx.dataDir);
  });

  it('talks about photos, not the editor or a book, in Photo Tool', () => {
    const photoTool = { productName: 'Photo Tool', dataDir: 'C:\\Users\\me\\AppData\\Roaming\\Photo Tool\\data' };
    for (const phase of ['start', 'run', 'page'] as const) {
      for (const detail of ['Error: something else', 'EACCES', 'database is locked', 'ERR_DLOPEN_FAILED sharp']) {
        const f = describeFailure(detail, { ...photoTool, phase });
        expect(`${f.title} ${f.message} ${f.advice}`, `${phase}: ${detail}`).not.toMatch(/\beditor\b|\bbooks?\b/i);
      }
    }
    expect(describeFailure('ERR_CONNECTION_REFUSED', { ...photoTool, phase: 'page' }).title).toBe('Photo Tool could not show the gallery');
    expect(describeFailure('x', { ...ctx, phase: 'page' }).title).toBe('Photobook Editor could not show the editor');
  });
});

describe('Help > About', () => {
  const licence = readFileSync(join(root, 'LICENSE'), 'utf8');
  const base = { productName: 'Photobook Editor', version: '0.1.0', description: 'Make a photobook.', dataDir: resolve('/appdata/data'), licence, repository: 'github:someone/some_project', hasNotices: true };

  it('names the app, says it stays offline, and credits the project and its licence', () => {
    const a = describeAbout(base);
    expect(a.title).toBe('About Photobook Editor');
    expect(a.message).toBe('Photobook Editor 0.1.0');
    expect(a.detail).toContain('Everything stays on this computer. Photobook Editor never uses the network.');
    expect(a.detail).toContain(base.dataDir);
    expect(a.detail).toContain('Built from the open-source project someone/some_project on GitHub, under the MIT licence.');
    // The copyright line is the licence file's own.
    expect(a.detail).toContain(licence.split(/\r?\n/).find((l) => l.startsWith('Copyright'))!);
    expect(a.buttons).toEqual(['OK', NOTICES_BUTTON]);
  });

  it('in Photo Tool, does not talk about books', () => {
    const a = describeAbout({ ...base, productName: 'Photo Tool' });
    expect(a.detail).toContain(`Its thumbnails and recent folders are kept in:\n${base.dataDir}`);
    expect(a.detail).not.toMatch(/\bbooks?\b/i);
    expect(a.detail).toContain('uses the network only for OpenStreetMap map tiles, and only after you choose Load maps');
    expect(a.detail).not.toContain('never uses the network');
  });

  it('has no addresses in it: the app opens no links', () => {
    for (const repository of ['github:someone/some_project', 'https://example.com/someone/some_project', undefined]) {
      const a = describeAbout({ ...base, repository });
      expect(`${a.title}\n${a.message}\n${a.detail}`).not.toMatch(/https?:|www\./);
    }
  });

  it('offers the notices only when the file is there, and copes without a licence file', () => {
    const a = describeAbout({ ...base, licence: null, hasNotices: false });
    expect(a.buttons).toEqual(['OK']);
    expect(a.detail).not.toContain(NOTICES_BUTTON);
    expect(a.detail).toContain('Built from the open-source project someone/some_project on GitHub.');
    expect(a.detail).not.toMatch(/undefined|null/);
    expect(describeAbout({ ...base, repository: undefined }).detail).toContain('Free software under the MIT licence.');
  });
});
