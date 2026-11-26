// The Timeline view's grouping and layout (#10): the photos in date order under a heading per day or per
// month, "No date" last. Pure (no DOM, no React), so the view only measures and draws.
//
// A photo goes in the group of its written calendar date, the first characters `YYYY-MM-DD` of
// `effectiveDate` (the date typed in Details, else the camera's). It is never turned into a Date in the
// computer's time zone, so a photo taken at 23:30 abroad stays on its own day.

export type TimelineUnit = 'day' | 'month';

export interface TimelineGroup {
  /** '2026-07-14' (day), '2026-07' (month) or 'none'. */
  key: string;
  /** "Tuesday 14 July 2026", "July 2026" or "No date". */
  label: string;
  count: number;
  /** Where the group's photos are in the ordered list: `start` to `end`, end exclusive. */
  start: number;
  end: number;
}

export type TimelineRow = { kind: 'header'; group: number } | { kind: 'tiles'; group: number; from: number; to: number };

export interface TimelineLayout {
  rows: TimelineRow[];
  /** The top of each row, in px from the top of the timeline. */
  tops: number[];
  height: number;
  /** Each group's heading row. */
  headerRow: number[];
  /** Each group's first photo (its `start`), for finding a photo's row. */
  groupStart: number[];
  cols: number;
}

/** The key of the group with no date. */
export const NO_DATE = 'none';

const DAY = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/;
const MONTH = /^(\d{4})-(\d{2})(?!\d)/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) => (m === 2 && leap(y) ? 29 : MONTH_DAYS[m - 1]);

/** The group a photo with this date goes in: its written day or month, or 'none' when it has none. */
export function groupKey(date: string | null, unit: TimelineUnit): string {
  if (!date) return NO_DATE;
  const m = (unit === 'day' ? DAY : MONTH).exec(date);
  if (!m) return NO_DATE;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return NO_DATE;
  if (unit === 'month') return `${m[1]}-${m[2]}`;
  const d = Number(m[3]);
  if (d < 1 || d > daysIn(y, mo)) return NO_DATE;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// The page is in English; the names are spelled out rather than asked of Intl, which costs too much for
// thousands of headings (a folder of ten years by day).
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A group's heading: "Tuesday 14 July 2026", "July 2026", or "No date". */
export function groupLabel(key: string): string {
  if (key === NO_DATE) return 'No date';
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = key.length >= 10 ? Number(key.slice(8, 10)) : 0;
  if (!y || !m) return 'No date';
  // The weekday of that calendar date, worked out in UTC: nothing shifts with the computer's time zone.
  if (d) return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTH_NAMES[m - 1]} ${y}`;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/**
 * The timeline's order: the photos as the date sort leaves them (oldest first), moved only as far as it
 * takes to keep each group together, groups in calendar order and 'No date' last. The date sort orders
 * by instant, so a date with a zone (or one typed as just "2026") could otherwise sit inside another
 * group. Within a group the date sort's order stays.
 */
export function timelineOrder<T extends { effectiveDate: string | null }>(dateSorted: readonly T[], unit: TimelineUnit): T[] {
  const keyed = dateSorted.map((item, i) => ({ item, key: groupKey(item.effectiveDate, unit), i }));
  // Most folders are in group order already (dates written the same way): nothing to move.
  let inOrder = true;
  for (let i = 1; i < keyed.length && inOrder; i++) {
    const a = keyed[i - 1].key;
    const b = keyed[i].key;
    inOrder = a === b || b === NO_DATE || (a !== NO_DATE && a < b);
  }
  if (inOrder) return [...dateSorted];
  keyed.sort((a, b) => {
    if (a.key === b.key) return a.i - b.i;
    if (a.key === NO_DATE) return 1;
    if (b.key === NO_DATE) return -1;
    return a.key < b.key ? -1 : 1;
  });
  return keyed.map((k) => k.item);
}

/** The groups of an ordered list (see timelineOrder), in one pass: each run of one key is a group. */
export function groupTimeline(items: readonly { effectiveDate: string | null }[], unit: TimelineUnit): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let key: string | null = null;
  let start = 0;
  const close = (end: number) => {
    if (key !== null) groups.push({ key, label: groupLabel(key), count: end - start, start, end });
  };
  for (let i = 0; i < items.length; i++) {
    const k = groupKey(items[i].effectiveDate, unit);
    if (k === key) continue;
    close(i);
    key = k;
    start = i;
  }
  close(items.length);
  return groups;
}

/** Days between the first and last dated photo above this: grouped by month unless the user picked. */
export const MONTH_SPAN_DAYS = 90;

/** By month when the dated photos span more than 90 days, else by day. */
export function defaultUnit(items: readonly { effectiveDate: string | null }[]): TimelineUnit {
  let min = Infinity;
  let max = -Infinity;
  for (const i of items) {
    const k = groupKey(i.effectiveDate, 'day');
    if (k === NO_DATE) continue;
    const t = Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return max - min > MONTH_SPAN_DAYS * 86_400_000 ? 'month' : 'day';
}

/**
 * The rows of the timeline: per group, a heading `headerHeight` high, then its photos `cols` to a row,
 * each row `rowHeight` high (the tile and the gap under it).
 */
export function timelineLayout(groups: readonly TimelineGroup[], cols: number, rowHeight: number, headerHeight: number): TimelineLayout {
  const c = Math.max(1, Math.floor(cols) || 1);
  const rows: TimelineRow[] = [];
  const tops: number[] = [];
  const headerRow: number[] = [];
  const groupStart: number[] = [];
  let y = 0;
  groups.forEach((g, n) => {
    headerRow.push(rows.length);
    groupStart.push(g.start);
    rows.push({ kind: 'header', group: n });
    tops.push(y);
    y += headerHeight;
    for (let from = g.start; from < g.end; from += c) {
      rows.push({ kind: 'tiles', group: n, from, to: Math.min(g.end, from + c) });
      tops.push(y);
      y += rowHeight;
    }
  });
  return { rows, tops, height: y, headerRow, groupStart, cols: c };
}

/** The last index whose value is at most `v` in an ascending list (-1 when none is). */
function lastAtMost(list: readonly number[], v: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= v) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The rows to draw for this scroll position: those in view and `overscanRows` either side (inclusive). */
export function timelineWindow(layout: TimelineLayout, scrollTop: number, viewport: number, overscanRows = 2): { first: number; last: number } {
  const n = layout.rows.length;
  if (!n) return { first: 0, last: -1 };
  const top = Math.max(0, scrollTop);
  const first = Math.max(0, lastAtMost(layout.tops, top) - overscanRows);
  const last = Math.min(n - 1, Math.max(0, lastAtMost(layout.tops, top + Math.max(0, viewport))) + overscanRows);
  return { first: Math.min(first, n - 1), last };
}

/** The row that shows photo `index` of the ordered list (-1: not in the timeline). */
export function rowOfItem(layout: TimelineLayout, index: number): number {
  const g = lastAtMost(layout.groupStart, index);
  if (g < 0) return -1;
  const header = layout.headerRow[g];
  const row = header + 1 + Math.floor((index - layout.groupStart[g]) / layout.cols);
  const r = layout.rows[row];
  return r && r.kind === 'tiles' && r.group === g && index < r.to ? row : -1;
}
