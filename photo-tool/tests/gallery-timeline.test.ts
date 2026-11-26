// The Timeline's grouping and layout (#10): pure, so a folder of 20,000 photos over ten years is grouped
// in one pass and only the rows on screen are drawn.
import { describe, expect, it } from 'vitest';
import { defaultUnit, groupKey, groupLabel, groupTimeline, rowOfItem, timelineLayout, timelineOrder, timelineWindow } from '../core/timeline';

const at = (effectiveDate: string | null, path = effectiveDate ?? 'undated') => ({ path, effectiveDate });

describe('groupKey', () => {
  it('takes the written calendar date, never shifted through a time zone', () => {
    expect(groupKey('2026-07-14T23:30:00', 'day')).toBe('2026-07-14');
    expect(groupKey('2026-07-14T23:30:00+09:00', 'day')).toBe('2026-07-14');
    expect(groupKey('2026-07-14T00:10:00-11:00', 'day')).toBe('2026-07-14');
    expect(groupKey('2026-07-14', 'day')).toBe('2026-07-14');
    expect(groupKey('2026-07-14T23:30:00', 'month')).toBe('2026-07');
  });

  it('puts a date typed by hand without a day in "No date" by day, in its month by month', () => {
    expect(groupKey('2026-07', 'day')).toBe('none');
    expect(groupKey('2026-07', 'month')).toBe('2026-07');
    expect(groupKey('2026', 'day')).toBe('none');
    expect(groupKey('2026', 'month')).toBe('none');
    expect(groupKey('July 2026', 'month')).toBe('none');
    expect(groupKey('July 2026', 'day')).toBe('none');
    expect(groupKey(null, 'day')).toBe('none');
    expect(groupKey('', 'month')).toBe('none');
  });

  it('refuses a date that is not on the calendar', () => {
    expect(groupKey('2026-13-01', 'day')).toBe('none');
    expect(groupKey('2026-13-01', 'month')).toBe('none');
    expect(groupKey('2026-02-30', 'day')).toBe('none');
    expect(groupKey('2024-02-29', 'day')).toBe('2024-02-29');
    expect(groupKey('20260714', 'day')).toBe('none');
  });
});

describe('groupLabel', () => {
  it('names a day with its weekday, a month with its year, and the rest "No date"', () => {
    expect(groupLabel('2026-07-14')).toBe('Tuesday 14 July 2026');
    expect(groupLabel('2026-03-01')).toBe('Sunday 1 March 2026');
    expect(groupLabel('2026-07')).toBe('July 2026');
    expect(groupLabel('none')).toBe('No date');
  });
});

describe('timelineOrder', () => {
  it('keeps each group together, in date order, "No date" last, whatever Date.parse makes of the dates', () => {
    // As the date sort leaves them: by instant. 23:30 at +09:00 is 14:30 UTC, before 20:00 UTC the day before.
    const sorted = [at('2026-07-15T01:00:00+09:00', 'a'), at('2026-07-14T20:00:00Z', 'b'), at('2026-07-14T21:00:00Z', 'c'), at('2026', 'd'), at(null, 'e')];
    expect(timelineOrder(sorted, 'day').map((i) => i.path)).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('places a month-only date in its month by month, and in "No date" by day', () => {
    const sorted = [at('2026-07', 'm'), at('2026-07-02T10:00:00', 'x'), at('2026-08-01T10:00:00', 'y'), at(null, 'n')];
    expect(timelineOrder(sorted, 'month').map((i) => i.path)).toEqual(['m', 'x', 'y', 'n']);
    expect(timelineOrder(sorted, 'day').map((i) => i.path)).toEqual(['x', 'y', 'm', 'n']);
  });
});

describe('groupTimeline', () => {
  it('groups photos by day with counts and their places in the list, "No date" last', () => {
    const items = [at('2026-07-14T09:00:00'), at('2026-07-14T23:30:00'), at('2026-07-15T08:00:00'), at(null)];
    const groups = groupTimeline(items, 'day');
    expect(groups.map((g) => g.key)).toEqual(['2026-07-14', '2026-07-15', 'none']);
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1]);
    expect(groups.map((g) => [g.start, g.end])).toEqual([[0, 2], [2, 3], [3, 4]]);
    expect(groups.map((g) => g.label)).toEqual(['Tuesday 14 July 2026', 'Wednesday 15 July 2026', 'No date']);
  });

  it('groups by month', () => {
    const groups = groupTimeline([at('2026-07-14T09:00:00'), at('2026-07-30T09:00:00'), at('2026-08-01T00:00:00')], 'month');
    expect(groups.map((g) => [g.key, g.label, g.count])).toEqual([['2026-07', 'July 2026', 2], ['2026-08', 'August 2026', 1]]);
  });

  it('is empty for no photos', () => {
    expect(groupTimeline([], 'day')).toEqual([]);
  });
});

describe('defaultUnit', () => {
  it('is month for dates spanning more than 90 days, day otherwise', () => {
    expect(defaultUnit([at('2026-01-01T10:00:00'), at('2026-04-02T10:00:00')])).toBe('month'); // 91 days
    expect(defaultUnit([at('2026-01-01T10:00:00'), at('2026-04-01T10:00:00')])).toBe('day'); // 90 days
    expect(defaultUnit([at(null), at('2026')])).toBe('day');
    expect(defaultUnit([])).toBe('day');
  });
});

describe('timelineLayout and timelineWindow', () => {
  const groups = [
    { key: '2026-07-14', label: '', count: 9, start: 0, end: 9 },
    { key: '2026-07-15', label: '', count: 2, start: 9, end: 11 },
  ];

  it('gives each group a heading row, then rows of tiles', () => {
    const l = timelineLayout(groups, 4, 100, 30);
    expect(l.rows).toEqual([
      { kind: 'header', group: 0 },
      { kind: 'tiles', group: 0, from: 0, to: 4 },
      { kind: 'tiles', group: 0, from: 4, to: 8 },
      { kind: 'tiles', group: 0, from: 8, to: 9 },
      { kind: 'header', group: 1 },
      { kind: 'tiles', group: 1, from: 9, to: 11 },
    ]);
    expect(l.tops).toEqual([0, 30, 130, 230, 330, 360]);
    expect(l.height).toBe(460);
    expect(l.headerRow).toEqual([0, 4]);
  });

  it('draws only the rows in view and a few either side', () => {
    const many = Array.from({ length: 100 }, (_, g) => ({ key: `k${g}`, label: '', count: 8, start: g * 8, end: g * 8 + 8 }));
    const l = timelineLayout(many, 4, 100, 30); // each group: 30 + 2 × 100 = 230 px
    const w = timelineWindow(l, 2300, 500, 2);
    // 2300 is the top of group 10's heading (row 30); 2800 falls in group 12's first tile row (row 37).
    expect(l.tops[30]).toBe(2300);
    expect(w).toEqual({ first: 28, last: 39 });
    expect(timelineWindow(l, 0, 500, 0).first).toBe(0);
    expect(timelineWindow(l, l.height + 1000, 500, 0).last).toBe(l.rows.length - 1);
  });

  it('finds the row of a photo, for scrolling it into view', () => {
    const l = timelineLayout(groups, 4, 100, 30);
    expect(rowOfItem(l, 0)).toBe(1);
    expect(rowOfItem(l, 5)).toBe(2);
    expect(rowOfItem(l, 8)).toBe(3);
    expect(rowOfItem(l, 9)).toBe(5);
    expect(rowOfItem(l, 10)).toBe(5);
    expect(rowOfItem(l, 11)).toBe(-1);
  });

  it('lays out nothing for no groups', () => {
    const l = timelineLayout([], 4, 100, 30);
    expect(l.rows).toEqual([]);
    expect(l.height).toBe(0);
    expect(timelineWindow(l, 0, 500)).toEqual({ first: 0, last: -1 });
  });
});

describe('a folder of 20,000 photos over ten years', () => {
  it('is ordered, grouped and laid out by day in well under 200 ms', () => {
    const start = Date.UTC(2016, 0, 1);
    const items = Array.from({ length: 20_000 }, (_, i) => {
      const d = new Date(start + Math.floor((i * 3650) / 20_000) * 86_400_000).toISOString().slice(0, 10);
      return at(`${d}T12:00:00`, `p${i}`);
    });
    const t0 = performance.now();
    const ordered = timelineOrder(items, 'day');
    const groups = groupTimeline(ordered, 'day');
    const layout = timelineLayout(groups, 5, 120, 32);
    const elapsed = performance.now() - t0;
    expect(groups.length).toBe(3650);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(20_000);
    expect(layout.rows.length).toBeGreaterThan(3650 * 2 - 1);
    expect(elapsed).toBeLessThan(200);
  });
});
