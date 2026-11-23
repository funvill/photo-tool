// The web version's bookkeeping for dropped files: unsupported files are reported, and ids line up
// with the dropped files (drop order), whatever order the importer worked in.
import { describe, expect, it } from 'vitest';
import { alignDropped, splitDropped } from '../src/web/backend/browser/drop';
import type { ImportJob } from '../src/web/backend/types';

const file = (name: string) => new File(['x'], name);
const job = (assetIds: string[], errors: ImportJob['errors'] = []): ImportJob => ({
  id: 'j', kind: 'import', status: 'done', folder: 'f', total: assetIds.length, processed: assetIds.length, imported: assetIds.length, alreadyInLibrary: 0,
  exactDuplicates: 0, moved: 0, removed: 0, missingFolders: [], failed: 0, assetIds, errors, startedAt: new Date(0).toISOString(),
});

describe('web drop bookkeeping', () => {
  it('reports unsupported files instead of dropping them silently', () => {
    const files = [file('b.jpg'), file('notes.txt'), file('a.png')];
    expect(splitDropped(files).photos.map((f) => f.name)).toEqual(['b.jpg', 'a.png']);
    const out = alignDropped(files, job(['id-b', 'id-a']));
    expect(out.errors).toEqual([{ file: 'notes.txt', error: 'notes.txt: not a photo this app can read' }]);
    expect(out.failed).toBe(0);
  });

  it('puts each id at its file\'s position, in drop order', () => {
    const files = [file('z.jpg'), file('notes.txt'), file('a.jpg')];
    expect(alignDropped(files, job(['id-z', 'id-a'])).assetIds).toEqual(['id-z', '', 'id-a']);
  });

  it('leaves a photo that has no id yet (still importing or failed) empty', () => {
    const files = [file('z.jpg'), file('a.jpg')];
    expect(alignDropped(files, job(['', 'id-a'])).assetIds).toEqual(['', 'id-a']);
  });
});
