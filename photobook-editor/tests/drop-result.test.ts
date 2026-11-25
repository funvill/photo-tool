// What a drop onto the page places: only the photos from dropped files. A dropped folder's photos go
// to the library only, and are summed up per folder for a toast.
import { describe, expect, it } from 'vitest';
import { splitDropResult } from '../web/dropResult';
import type { ImportJob } from '../web/backend/types';

const job = (assetIds: string[], assetFolders?: string[]): ImportJob => ({
  id: 'j', kind: 'paths', status: 'done', folder: 'f', total: assetIds.length, processed: assetIds.length, imported: assetIds.length, alreadyInLibrary: 0,
  exactDuplicates: 0, moved: 0, removed: 0, missingFolders: [], failed: 0, assetIds, assetFolders, errors: [], startedAt: new Date(0).toISOString(),
});

describe('splitDropResult', () => {
  it('places dropped files and only imports a dropped folder', () => {
    const out = splitDropResult(job(['f1', 'd1', '', 'd2', 'f2'], ['', 'C:\\Trip\\Day 1', 'C:\\Trip\\Day 1', 'C:\\Trip\\Day 1', '']));
    expect(out.placed).toEqual(['f1', 'f2']);
    expect(out.folders).toEqual([{ folder: 'C:\\Trip\\Day 1', name: 'Day 1', count: 2 }]);
  });

  it('treats every photo as a dropped file when the job does not say (web version)', () => {
    expect(splitDropResult(job(['a', '', 'b']))).toEqual({ placed: ['a', 'b'], folders: [] });
  });

  it('keeps folders apart, in drop order', () => {
    const out = splitDropResult(job(['a', 'b', 'c'], ['/p/x', '/p/y/', '/p/x']));
    expect(out.folders).toEqual([{ folder: '/p/x', name: 'x', count: 2 }, { folder: '/p/y/', name: 'y', count: 1 }]);
  });
});
