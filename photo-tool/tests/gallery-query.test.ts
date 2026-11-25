import { describe, expect, it } from 'vitest';
import { FILTERS } from '../core/galleryFilters';
import { queryExamples, searchTextOf, takeQueryWords } from '../core/galleryQuery';

const ctx = { dirs: ['', 'Day 2', 'day3'] };
const take = (box: string, final = true) => takeQueryWords(box, ctx, final);

describe('query words in the search box', () => {
  it('takes known words out on Enter', () => {
    expect(take('star:yes lake shape:Portrait')).toEqual({ patch: { starred: 'yes', orientation: 'portrait' }, tags: [], rest: 'lake', error: null });
  });

  it('every word', () => {
    expect(take('from:2024-06-01').patch).toEqual({ from: '2024-06-01' });
    expect(take('to:2024-06-09').patch).toEqual({ to: '2024-06-09' });
    expect(take('hidden:only').patch).toEqual({ hidden: 'only' });
    expect(take('hidden:show').patch).toEqual({ hidden: 'show' });
    expect(take('star:no').patch).toEqual({ starred: 'no' });
    expect(take('shape:landscape').patch).toEqual({ orientation: 'landscape' });
    expect(take('folder:top').patch).toEqual({ relDir: '' });
    expect(take('folder:"day 2"').patch).toEqual({ relDir: 'Day 2' });
    expect(take('folder:DAY3').patch).toEqual({ relDir: 'day3' });
    expect(take('has:location').patch).toEqual({ hasLocation: true });
    expect(take('HAS:People').patch).toEqual({ hasPeople: true });
    expect(take('is:lowquality').patch).toEqual({ lowQuality: true });
    expect(take('is:duplicate').patch).toEqual({ nearDuplicates: true });
    expect(take('tag:Lake')).toEqual({ patch: {}, tags: [{ kind: 'keyword', value: 'lake' }], rest: '', error: null });
    expect(take('object:boat').tags).toEqual([{ kind: 'object', value: 'boat' }]);
    expect(take('tag:"ice cream"').tags).toEqual([{ kind: 'keyword', value: 'ice cream' }]);
  });

  it('the same tag twice is added once', () => {
    expect(take('tag:lake tag:LAKE object:lake').tags).toEqual([
      { kind: 'keyword', value: 'lake' },
      { kind: 'object', value: 'lake' },
    ]);
  });

  it('last one wins', () => {
    const r = take('star:yes star:no');
    expect(r.patch.starred).toBe('no');
    expect(r.error).toBeNull();
  });

  it('bad words stay as text with a reason', () => {
    expect(take('star:maybe lake')).toEqual({ patch: {}, tags: [], rest: 'star:maybe lake', error: '"star:maybe" isn\'t a filter: try star:yes or star:no' });
    expect(take('from:june').error).toBe('"from:june" isn\'t a filter: try from:YYYY-MM-DD');
    expect(take('to:2024-13-40').error).toBe('"to:2024-13-40" isn\'t a filter: try to:YYYY-MM-DD');
    expect(take('folder:nowhere').error).toBe('"folder:nowhere" isn\'t a filter: no folder named nowhere');
    expect(take('has:dogs').error).toBe('"has:dogs" isn\'t a filter: try has:location or has:people');
    expect(take('is:pretty').error).toBe('"is:pretty" isn\'t a filter: try is:lowquality or is:duplicate');
    expect(take('tag:').error).toBe('"tag:" isn\'t a filter: try tag:<word>');
  });

  it('the first bad word gives the message; good words are still taken', () => {
    const r = take('star:maybe shape:portrait has:dogs');
    expect(r.patch).toEqual({ orientation: 'portrait' });
    expect(r.rest).toBe('star:maybe has:dogs');
    expect(r.error).toContain('star:maybe');
  });

  it('a value naming an Object.prototype member is a bad word, not swallowed', () => {
    expect(take('star:constructor')).toEqual({ patch: {}, tags: [], rest: 'star:constructor', error: '"star:constructor" isn\'t a filter: try star:yes or star:no' });
    expect(take('shape:__proto__')).toEqual({ patch: {}, tags: [], rest: 'shape:__proto__', error: '"shape:__proto__" isn\'t a filter: try shape:portrait or shape:landscape' });
    expect(take('has:toString')).toEqual({ patch: {}, tags: [], rest: 'has:toString', error: '"has:toString" isn\'t a filter: try has:location or has:people' });
    expect(take('hidden:valueOf').rest).toBe('hidden:valueOf');
    expect(take('is:hasOwnProperty').rest).toBe('is:hasOwnProperty');
  });

  it('unknown keys are plain text', () => {
    expect(take('http://x a:b')).toEqual({ patch: {}, tags: [], rest: 'http://x a:b', error: null });
  });

  it('while typing, the last word waits', () => {
    const r = take('star:yes shape:por', false);
    expect(r.patch).toEqual({ starred: 'yes' });
    expect(r.rest).toBe('shape:por');
    const r2 = take('star:yes ', false);
    expect(r2.patch).toEqual({ starred: 'yes' });
    expect(r2.rest).toBe('');
  });

  it("a space inside quotes doesn't finish the word", () => {
    const open = take('folder:"Day ', false);
    expect(open.patch).toEqual({});
    expect(open.rest).toBe('folder:"Day ');
    expect(take('folder:"Day 2" ', false).patch).toEqual({ relDir: 'Day 2' });
  });

  it('search text leaves out an unfinished filter word', () => {
    expect(searchTextOf('lake star:ye')).toBe('lake');
    expect(searchTextOf('star:')).toBeUndefined();
    expect(searchTextOf('lake ')).toBe('lake');
    expect(searchTextOf('a:b')).toBe('a:b');
    expect(searchTextOf('')).toBeUndefined();
    expect(searchTextOf('  ')).toBeUndefined();
  });

  it('examples', () => {
    expect(queryExamples()).toEqual(['star:yes', 'shape:portrait', 'from:2024-06-01', 'has:people', 'tag:lake']);
  });

  it('every panel filter has a query word', () => {
    for (const d of FILTERS) if (d.group !== null) expect(d.query?.length, d.id).toBeGreaterThan(0);
  });
});
