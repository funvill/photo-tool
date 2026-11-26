// The media format registry: the format table (shared/core/mediaFormats.ts) and one handler per format
// (shared/server/mediaHandlers/). Phase 1 of #6 reproduces exactly what the scattered lists did.
// The reference uses win32's basename/extname, which split on both slashes, as the registry does on
// every platform (so this runs the same on Windows and Linux CI).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { acceptAttribute, extensionOf, formatById, formatOf, isSidecar, isSupported, MEDIA_FORMATS, pairRawTwins, SUPPORTED_EXTENSIONS } from '../core/mediaFormats';
import { handlerFor, mediaHandlers } from '../server/mediaHandlers';
import { SUPPORTED_EXTENSIONS as SERVER_EXTENSIONS, isSupported as serverIsSupported } from '../server/media';
import { editFormatFor } from '../core/photoEdit';

const { basename, extname } = win32;

// What shared/server/media.ts had before the registry, kept here to compare against.
const OLD_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
// Phase 2 of #6: the formats sharp decodes itself (AVIF, TIFF, GIF, SVG), and BMP and ICO through a
// small decoder of our own.
const NEW_EXTENSIONS = new Set(['.avif', '.tif', '.tiff', '.gif', '.svg', '.bmp', '.ico']);
// Phase 3 of #6: camera RAW files, shown through the JPEG preview each one carries.
const RAW_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2', '.pef', '.srw', '.rwl', '.dng',
  '.3fr', '.iiq', '.erf', '.mef', '.mos', '.kdc', '.dcr', '.x3f',
]);
const ALL_EXTENSIONS = new Set([...OLD_EXTENSIONS, ...NEW_EXTENSIONS, ...RAW_EXTENSIONS]);
const oldIsSupported = (path: string) => ALL_EXTENSIONS.has(extname(path).toLowerCase()) && !basename(path).startsWith('._');
const oldIsHeic = (path: string) => ['.heic', '.heif'].includes(extname(path).toLowerCase());

const NAMES = [
  'a.jpg', 'a.JPG', 'a.jpeg', 'b.JpEg', 'c.png', 'd.webp', 'e.heic', 'E.HEIC', 'f.heif', 'C:\\x\\a.HEIC', '/x/y/a.png',
  '._a.jpg', 'C:\\x\\._a.jpg', '/x/._a.heic', '.jpg', '.heic', 'a.', 'a', 'a.jpg.txt', 'a.txt', 'a.gif', 'a.tiff', 'a.cr3',
  'a.mp4', 'archive.tar.gz', '..jpg', 'x/.hidden.png', 'dir.jpg/', 'C:\\x\\', 'a b.jpg', 'a.jpg ', 'IMG_0001.Heif',
  'a.avif', 'A.AVIF', 'a.tif', 'a.TIF', 'a.Tiff', 'a.gif', 'a.GIF', 'a.svg', 'a.SVG', 'a.svgz', 'a.bmp', 'a.ico', 'a.ICO',
  '._a.tif', '/x/._a.svg', '.gif', 'a.gif.txt', 'a.jxl', 'a.cr2',
];

describe('the format table', () => {
  it('reads the six extensions it read before, plus AVIF, TIFF, GIF, SVG, BMP, ICO and camera RAW', () => {
    expect(new Set(SUPPORTED_EXTENSIONS)).toEqual(ALL_EXTENSIONS);
    expect(new Set(SERVER_EXTENSIONS)).toEqual(ALL_EXTENSIONS);
    expect(MEDIA_FORMATS.filter((f) => f.kind === 'image').map((f) => f.id)).toEqual(['jpeg', 'png', 'webp', 'heif', 'avif', 'tiff', 'gif', 'svg', 'bmp', 'ico']);
  });

  it('knows each new format by every spelling of its extension', () => {
    const cases: [string, string, string][] = [
      ['a.avif', 'avif', 'image/avif'], ['A.AVIF', 'avif', 'image/avif'],
      ['a.tif', 'tiff', 'image/tiff'], ['a.TIFF', 'tiff', 'image/tiff'],
      ['a.gif', 'gif', 'image/gif'], ['C:\\x\\A.GIF', 'gif', 'image/gif'],
      ['a.svg', 'svg', 'image/svg+xml'], ['/x/A.Svg', 'svg', 'image/svg+xml'],
      ['a.bmp', 'bmp', 'image/bmp'], ['a.BMP', 'bmp', 'image/bmp'],
      ['a.ico', 'ico', 'image/x-icon'], ['a.ICO', 'ico', 'image/x-icon'],
    ];
    for (const [name, id, mime] of cases) {
      expect(formatOf(name)?.id, name).toBe(id);
      expect(formatOf(name)?.mime, name).toBe(mime);
      expect(formatOf(name)?.kind, name).toBe('image');
      expect(isSupported(name), name).toBe(true);
      expect(formatById(id)?.id).toBe(id);
    }
    for (const n of ['a.svgz', 'a.jxl', '._a.tif', '/x/._a.svg', '.gif']) expect(isSupported(n), n).toBe(false);
  });

  it('saves edits of every new format only as a copy, in a format it can write', () => {
    // SaveFormat is jpeg/png/webp, and Save writes that into the photo's own path: a .tif must never
    // end up holding JPEG bytes, so none of the new formats is edited in place.
    const expected: Record<string, { saveAs: string; alpha: boolean; animated: boolean; label: string }> = {
      avif: { saveAs: 'jpeg', alpha: true, animated: false, label: 'AVIF' },
      tiff: { saveAs: 'jpeg', alpha: true, animated: false, label: 'TIFF' },
      gif: { saveAs: 'png', alpha: true, animated: true, label: 'GIF' },
      svg: { saveAs: 'png', alpha: true, animated: false, label: 'SVG' },
      bmp: { saveAs: 'png', alpha: true, animated: false, label: 'BMP' },
      ico: { saveAs: 'png', alpha: true, animated: false, label: 'ICO' },
    };
    for (const [id, want] of Object.entries(expected)) {
      const f = formatById(id)!;
      expect(f.capabilities, id).toEqual({ editInPlace: false, alpha: want.alpha, saveAs: want.saveAs, animated: want.animated });
      expect(f.label, id).toBe(want.label);
    }
    expect(editFormatFor('C:\\x\\scan.TIF')).toBe('jpeg');
    expect(editFormatFor('/x/logo.svg')).toBe('png');
    expect(editFormatFor('a.gif')).toBe('png');
  });

  it('gives every extension to exactly one format, lower case with its dot', () => {
    const all = MEDIA_FORMATS.flatMap((f) => f.extensions);
    expect(new Set(all).size).toBe(all.length);
    for (const e of all) expect(e).toMatch(/^\.[a-z0-9]+$/);
  });

  it('agrees with the old isSupported on every kind of name', () => {
    for (const n of NAMES) {
      expect(isSupported(n), n).toBe(oldIsSupported(n));
      expect(serverIsSupported(n), n).toBe(oldIsSupported(n));
    }
  });

  it('finds extensions the way Node does', () => {
    for (const n of NAMES) expect(extensionOf(n), n).toBe(extname(n).toLowerCase());
  });

  it('tells HEIC apart exactly as the old checks did', () => {
    for (const n of NAMES) expect(formatOf(n)?.id === 'heif', n).toBe(oldIsHeic(n));
  });

  it('has the capabilities the old special cases spelled out', () => {
    const old = MEDIA_FORMATS.filter((f) => ['jpeg', 'png', 'webp', 'heif'].includes(f.id));
    // Of the old formats only HEIC can't be written: it is saved as a JPEG copy.
    expect(old.filter((f) => !f.capabilities.editInPlace).map((f) => f.id)).toEqual(['heif']);
    expect(formatById('heif')?.label).toBe('HEIC');
    // The editor's ALPHA_FORMATS was ['png', 'webp'], by sharp's format names (as its catalogue stores them).
    expect(old.filter((f) => f.capabilities.alpha).map((f) => f.id)).toEqual(['png', 'webp']);
    for (const id of ['jpeg', 'png', 'webp', 'heif']) expect(formatById(id)?.id).toBe(id);
    expect(MEDIA_FORMATS.filter((f) => f.kind !== 'raw').every((f) => f.kind === 'image')).toBe(true);
    // GIF is the only moving image so far (shown, and edited, as its first frame).
    expect(MEDIA_FORMATS.filter((f) => f.capabilities.animated).map((f) => f.id)).toEqual(['gif']);
  });

  it('writes an edit of an old format in the format editFormatFor always gave', () => {
    const old = (path: string) => {
      const ext = /\.[^./\\]*$/.exec(path)?.[0].toLowerCase();
      return ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpeg';
    };
    const names = [...NAMES, 'a.PNG', 'b.WebP', 'c.HEIC', 'd.unknown'].filter((n) => !NEW_EXTENSIONS.has(extname(n).toLowerCase()) && !RAW_EXTENSIONS.has(extname(n).toLowerCase()));
    for (const n of names) expect(editFormatFor(n), n).toBe(old(n));
  });

  it('builds an accept attribute from every format', () => {
    expect(acceptAttribute().startsWith(
      'image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/heic,.heic,.heif,image/avif,.avif,image/tiff,.tif,.tiff,image/gif,.gif,image/svg+xml,.svg,image/bmp,.bmp,image/x-icon,.ico,',
    )).toBe(true);
    const parts = acceptAttribute().split(',');
    for (const e of RAW_EXTENSIONS) expect(parts, e).toContain(e);
    expect(parts).toContain('image/x-adobe-dng');
  });
});

describe('the handlers', () => {
  it('has exactly one handler per format', () => {
    const ids = mediaHandlers().map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(MEDIA_FORMATS.map((f) => f.id).sort());
  });

  it('maps every extension, in any case, to its format\'s handler', () => {
    for (const f of MEDIA_FORMATS) {
      for (const e of f.extensions) {
        expect(handlerFor(`photo${e}`)?.id, e).toBe(f.id);
        expect(handlerFor(`C:\\x\\PHOTO${e.toUpperCase()}`)?.id, e).toBe(f.id);
      }
    }
  });

  it('has no handler for a file no program reads', () => {
    for (const n of ['a.txt', 'a.svgz', 'a', '.jpg', 'a.mp4', 'a.jxl']) expect(handlerFor(n), n).toBeNull();
  });

  it('works from the original for the formats sharp reads safely, without hashing it', async () => {
    const ctx = { derivedDir: '/nowhere', contentHash: async () => { throw new Error('hashed'); } };
    // Each handler looks at the file's first bytes, so the files exist (one binary picture serves for all).
    const dir = mkdtempSync(join(tmpdir(), 'media-formats-'));
    try {
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } }).png().toBuffer();
      for (const n of ['a.jpg', 'b.png', 'c.webp', 'd.avif', 'e.tif', 'f.tiff', 'g.gif']) {
        const file = join(dir, n);
        writeFileSync(file, png);
        expect(await handlerFor(file)!.preview(file, ctx)).toBe(file);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('camera RAW formats (phase 3 of #6)', () => {
  it('knows every RAW extension the issue lists, in any case, as its own RAW format', () => {
    for (const e of RAW_EXTENSIONS) {
      for (const name of [`IMG_0001${e}`, `C:\\x\\IMG_0001${e.toUpperCase()}`, `/x/y/a${e}`]) {
        const f = formatOf(name);
        expect(f?.kind, name).toBe('raw');
        expect(f?.extensions, name).toContain(e);
        expect(isSupported(name), name).toBe(true);
      }
      expect(isSupported(`._IMG_0001${e}`)).toBe(false);
    }
    expect(MEDIA_FORMATS.filter((f) => f.kind === 'raw').flatMap((f) => f.extensions).sort()).toEqual([...RAW_EXTENSIONS].sort());
  });

  it('saves an edit of a RAW only as a JPEG copy, never into the RAW', () => {
    for (const f of MEDIA_FORMATS.filter((x) => x.kind === 'raw')) {
      expect(f.capabilities, f.id).toEqual({ editInPlace: false, alpha: false, saveAs: 'jpeg', animated: false });
      expect(f.label, f.id).toMatch(/^[A-Z0-9]+$/);
      expect(f.mime, f.id).toMatch(/^image\/x-/);
      expect(editFormatFor(`a${f.extensions[0]}`)).toBe('jpeg');
    }
    expect(formatOf('a.CR3')?.label).toBe('CR3');
    expect(formatOf('a.dng')?.label).toBe('DNG');
  });

  it('knows an .xmp sidecar, which is never a photo', () => {
    for (const n of ['IMG_0001.xmp', 'IMG_0001.XMP', 'IMG_0001.CR3.xmp', 'C:\\x\\a.Xmp', '/x/a.nef.XMP']) {
      expect(isSidecar(n), n).toBe(true);
      expect(isSupported(n), n).toBe(false);
      expect(handlerFor(n), n).toBeNull();
    }
    for (const n of ['a.jpg', 'a.cr2', 'xmp', '.xmp', 'a.xmp.jpg']) expect(isSidecar(n), n).toBe(false);
  });
});

describe('pairRawTwins: a RAW and a JPEG of the same name in one folder are one photo', () => {
  const sep = (p: string) => p.split('/').join('\\');

  it('keeps the JPEG and folds the RAW into it', () => {
    const r = pairRawTwins(['/a/IMG_0001.CR3', '/a/IMG_0001.JPG', '/a/IMG_0002.CR3', '/a/IMG_0003.jpg']);
    expect(r.shown).toEqual(['/a/IMG_0001.JPG', '/a/IMG_0002.CR3', '/a/IMG_0003.jpg']);
    expect([...r.twinOf]).toEqual([['/a/IMG_0001.JPG', '/a/IMG_0001.CR3']]);
  });

  it('matches the base name in any case, on both kinds of slash, and keeps the order given', () => {
    const r = pairRawTwins([sep('C:/p/b.jpeg'), sep('C:/p/B.NEF'), sep('C:/p/a.dng'), sep('C:/p/A.jpg')]);
    expect(r.shown).toEqual([sep('C:/p/b.jpeg'), sep('C:/p/A.jpg')]);
    expect(r.twinOf.get(sep('C:/p/b.jpeg'))).toBe(sep('C:/p/B.NEF'));
    expect(r.twinOf.get(sep('C:/p/A.jpg'))).toBe(sep('C:/p/a.dng'));
  });

  it('pairs only within one folder', () => {
    const r = pairRawTwins(['/a/x.cr2', '/b/x.jpg', '/a/sub/x.jpg']);
    expect(r.shown).toEqual(['/a/x.cr2', '/b/x.jpg', '/a/sub/x.jpg']);
    expect(r.twinOf.size).toBe(0);
  });

  it('pairs a RAW with a HEIC the camera saved beside it, but not with a PNG, a TIFF or another RAW', () => {
    expect(pairRawTwins(['/a/x.arw', '/a/x.HEIF']).shown).toEqual(['/a/x.HEIF']);
    expect(pairRawTwins(['/a/x.arw', '/a/x.png']).shown).toEqual(['/a/x.arw', '/a/x.png']);
    expect(pairRawTwins(['/a/x.arw', '/a/x.tif']).shown).toEqual(['/a/x.arw', '/a/x.tif']);
    expect(pairRawTwins(['/a/x.arw', '/a/x.dng']).shown).toEqual(['/a/x.arw', '/a/x.dng']);
  });

  it('gives each shown picture at most one RAW, and each RAW at most one picture', () => {
    // Two RAWs of one name (a DNG made from a CR2): the first by name is the twin, the other stays a photo.
    const r = pairRawTwins(['/a/x.cr2', '/a/x.dng', '/a/x.jpg']);
    expect(r.shown).toEqual(['/a/x.dng', '/a/x.jpg']);
    expect(r.twinOf.get('/a/x.jpg')).toBe('/a/x.cr2');
    // Two JPEGs of one name (x.jpg and x.jpeg): the first takes the RAW.
    const t = pairRawTwins(['/a/x.jpeg', '/a/x.jpg', '/a/x.nef']);
    expect(t.shown).toEqual(['/a/x.jpeg', '/a/x.jpg']);
    expect([...t.twinOf]).toEqual([['/a/x.jpeg', '/a/x.nef']]);
  });

  it('leaves names without an extension, dot files and unsupported files where they are', () => {
    const r = pairRawTwins(['/a/x', '/a/x.cr2', '/a/.x.jpg']);
    expect(r.shown).toEqual(['/a/x', '/a/x.cr2', '/a/.x.jpg']);
  });
});
