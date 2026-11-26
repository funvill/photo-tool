// The media format registry: the format table (shared/core/mediaFormats.ts) and one handler per format
// (shared/server/mediaHandlers/). Phase 1 of #6 reproduces exactly what the scattered lists did.
// The reference uses win32's basename/extname, which split on both slashes, as the registry does on
// every platform (so this runs the same on Windows and Linux CI).
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptAttribute, extensionOf, formatById, formatOf, isSupported, MEDIA_FORMATS, SUPPORTED_EXTENSIONS } from '../core/mediaFormats';
import { handlerFor, mediaHandlers } from '../server/mediaHandlers';
import { SUPPORTED_EXTENSIONS as SERVER_EXTENSIONS, isSupported as serverIsSupported } from '../server/media';
import { editFormatFor } from '../core/photoEdit';

const { basename, extname } = win32;

// What shared/server/media.ts had before the registry, kept here to compare against.
const OLD_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
const oldIsSupported = (path: string) => OLD_EXTENSIONS.has(extname(path).toLowerCase()) && !basename(path).startsWith('._');
const oldIsHeic = (path: string) => ['.heic', '.heif'].includes(extname(path).toLowerCase());

const NAMES = [
  'a.jpg', 'a.JPG', 'a.jpeg', 'b.JpEg', 'c.png', 'd.webp', 'e.heic', 'E.HEIC', 'f.heif', 'C:\\x\\a.HEIC', '/x/y/a.png',
  '._a.jpg', 'C:\\x\\._a.jpg', '/x/._a.heic', '.jpg', '.heic', 'a.', 'a', 'a.jpg.txt', 'a.txt', 'a.gif', 'a.tiff', 'a.cr3',
  'a.mp4', 'archive.tar.gz', '..jpg', 'x/.hidden.png', 'dir.jpg/', 'C:\\x\\', 'a b.jpg', 'a.jpg ', 'IMG_0001.Heif',
];

describe('the format table', () => {
  it('reads exactly the six extensions it read before, and nothing new yet', () => {
    expect(new Set(SUPPORTED_EXTENSIONS)).toEqual(OLD_EXTENSIONS);
    expect(new Set(SERVER_EXTENSIONS)).toEqual(OLD_EXTENSIONS);
    expect(MEDIA_FORMATS.map((f) => f.id)).toEqual(['jpeg', 'png', 'webp', 'heif']);
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
    // Only HEIC can't be written: it is saved as a JPEG copy.
    expect(MEDIA_FORMATS.filter((f) => !f.capabilities.editInPlace).map((f) => f.id)).toEqual(['heif']);
    expect(formatById('heif')?.label).toBe('HEIC');
    // The editor's ALPHA_FORMATS was ['png', 'webp'], by sharp's format names (as its catalogue stores them).
    expect(MEDIA_FORMATS.filter((f) => f.capabilities.alpha).map((f) => f.id)).toEqual(['png', 'webp']);
    for (const id of ['jpeg', 'png', 'webp', 'heif']) expect(formatById(id)?.id).toBe(id);
    expect(MEDIA_FORMATS.every((f) => f.kind === 'image' && !f.capabilities.animated)).toBe(true);
  });

  it('writes an edit in the format editFormatFor always gave', () => {
    const old = (path: string) => {
      const ext = /\.[^./\\]*$/.exec(path)?.[0].toLowerCase();
      return ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpeg';
    };
    for (const n of [...NAMES, 'a.PNG', 'b.WebP', 'c.HEIC', 'd.unknown']) expect(editFormatFor(n), n).toBe(old(n));
  });

  it('builds an accept attribute from every format', () => {
    expect(acceptAttribute()).toBe('image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/heic,.heic,.heif');
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
    for (const n of ['a.txt', 'a.gif', 'a', '.jpg', 'a.mp4']) expect(handlerFor(n), n).toBeNull();
  });

  it('works from the original for the formats sharp reads, without hashing it', async () => {
    const ctx = { derivedDir: '/nowhere', contentHash: async () => { throw new Error('hashed'); } };
    for (const n of ['a.jpg', 'b.png', 'c.webp']) expect(await handlerFor(n)!.preview(n, ctx)).toBe(n);
  });
});
