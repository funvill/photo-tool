// Ctrl+C with several photos: what the page asks to copy is taken on trust only so far, and only
// photos of the open folder go on the clipboard (as files: a text/uri-list of file URLs, which
// Electron puts on the Windows clipboard as CF_HDROP, the format Explorer pastes).
import { describe, expect, it } from 'vitest';
import { copyFilesRequest, fileUrlList } from '../electron/fileActions';
import { MAX_DRAG_FILES } from '../electron/drag';

describe('copyFilesRequest', () => {
  const all = () => true;

  it('is null for anything but a list with an allowed photo in it', () => {
    expect(copyFilesRequest('C:\\a.jpg', all)).toBeNull();
    expect(copyFilesRequest(undefined, all)).toBeNull();
    expect(copyFilesRequest([], all)).toBeNull();
    expect(copyFilesRequest([1, '', null], all)).toBeNull();
    expect(copyFilesRequest(['C:\\a.jpg'], () => false)).toBeNull();
  });

  it('keeps at most 500 and says how many were left over', () => {
    const many = Array.from({ length: 600 }, (_, n) => `C:\\p\\${n}.jpg`);
    const r = copyFilesRequest(many, all)!;
    expect(MAX_DRAG_FILES).toBe(500);
    expect(r.paths).toHaveLength(500);
    expect(r.paths[0]).toBe('C:\\p\\0.jpg');
    expect(r.dropped).toBe(100);
  });

  it('leaves out what is not allowed, and the same photo twice', () => {
    expect(copyFilesRequest(['C:\\a.jpg', 'C:\\secret.txt', 'C:\\b.jpg', 'C:\\a.jpg'], (p) => p.endsWith('.jpg'))).toEqual({ paths: ['C:\\a.jpg', 'C:\\b.jpg'], dropped: 0 });
  });
});

describe('fileUrlList', () => {
  it('turns paths into file URLs, one per line, with awkward characters escaped', () => {
    const text = fileUrlList(['C:\\Trip\\a #1.jpg', 'C:\\Trip\\100% sure & more.jpg']);
    const lines = text.split('\r\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.startsWith('file:///')).toBe(true);
    expect(lines[0]).toContain('%231');
    expect(lines[1]).toContain('100%25');
  });
});
