import { create } from 'zustand';
import type { DesktopApi } from '../../shared/desktopApi';
import { filterItems, galleryFacts, sortItems, type GalleryFacts, type GalleryFilter, type GallerySortKey } from '../../core/gallerySort';
import { clickSelect, dragPaths, flagTargets, nextAfterRemoval } from '../../core/galleryViewer';
import { stackItems, type StackInfo } from '../../core/galleryStacks';
import { galleryApi, type GalleryItem, type JobUpdate, type RecentFolder } from './api';

// The gallery's state: the open folder, its photos (filled in while the folder is read), the
// selection, thumbnail size and toasts. Photo info lives in photoinfo.json files that other
// programs (the editor, a text editor) may change, so an open folder is checked every few seconds.

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface GalleryState {
  job: string | null;
  root: string | null;
  items: GalleryItem[];
  /** While the folder is being read; null once it is done. */
  progress: { total: number; processed: number; startedAt: number } | null;
  /** The photo the details panel shows. */
  selected: string | null;
  /** Every selected photo (paths, in grid order): what dragging a selected tile takes. */
  selection: string[];
  /** Where a Shift-click range starts: the last plain or Ctrl click. */
  anchor: string | null;
  /** The photo the full-screen viewer shows, or null when it is closed. */
  viewing: string | null;
  /** Tile size in px, 96–320, remembered in localStorage 'gallery.thumbSize'. */
  thumbSize: number;
  /** Order and filters of the grid, kept for the session (in memory, not saved): a new folder keeps the sort and the filters except the subfolder. */
  sort: GallerySortKey;
  filter: GalleryFilter;
  /** Fold the near-identical shots of a burst into one tile (on by default). */
  stacked: boolean;
  /** The ids of the stacks shown unfolded; cleared when a folder is opened or closed. */
  openStacks: string[];
  /** "Include subfolders" for the next folder opened. */
  recursive: boolean;
  recent: RecentFolder[];
  toasts: Toast[];
  /** The "Tidy photo info" dialog is open. */
  tidyOpen: boolean;
  /** Tiles per row in the grid as drawn now (the grid publishes it; Up/Down step by it). 1 while the grid is not shown. */
  gridCols: number;
  /** What the thumbnail column shows: the grid, or the photos on a map. Kept across folders, for the session. */
  view: 'grid' | 'map';

  loadRecent(): Promise<void>;
  open(folder: string, recursive: boolean): Promise<void>;
  /**
   * Save fields of a photo's info (a null value deletes the field). Resolves false, after an error toast
   * with the server's message, when it could not be saved; nothing is applied then.
   */
  saveInfo(path: string, patch: Record<string, unknown>): Promise<boolean>;
  setStar(path: string, star: boolean): Promise<boolean>;
  /** Reload every photo's info (after another program changed a photoinfo.json). */
  refreshInfo(): Promise<void>;
  /** Select just this photo (or nothing). */
  select(path: string | null): void;
  /** A click on a tile: plain selects it, Ctrl toggles it, Shift selects the range from the anchor (grid order). */
  clickSelect(path: string, mods: { ctrl?: boolean; shift?: boolean }): void;
  openViewer(path: string): void;
  /** The viewer moved on to this photo. */
  viewPhoto(path: string): void;
  /** Close the viewer, selecting the last photo it showed (null: leave the selection). */
  closeViewer(last: string | null): void;
  setThumbSize(px: number): void;
  setSort(sort: GallerySortKey): void;
  /** Change some filters; a key set to undefined is cleared. */
  setFilter(patch: Partial<GalleryFilter>): void;
  clearFilter(): void;
  setRecursive(recursive: boolean): void;
  setStacked(on: boolean): void;
  toggleStack(id: string): void;
  /**
   * Star or hide the selected photo (every selected one when several are): they all get the opposite of the
   * selected photo's value. A photo that then leaves the list is replaced in the selection by the next one.
   */
  toggleFlag(field: 'star' | 'hidden'): Promise<void>;
  /** Drop photos from the list (they were deleted); the selection moves on to the next one. */
  removeItems(paths: string[]): void;
  /** Stop reading and watching the open folder, and go back to the start screen. */
  close(): void;
  setTidyOpen(open: boolean): void;
  setGridCols(cols: number): void;
  setView(view: 'grid' | 'map'): void;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
}

export const THUMB_MIN = 96;
export const THUMB_MAX = 320;
const THUMB_DEFAULT = 160;
const THUMB_KEY = 'gallery.thumbSize';
const JOB_POLL_MS = 500;
/** A failed scan poll is retried this many times (1 s, 2 s, 4 s apart) before giving up. */
const JOB_RETRIES = 3;
const STAMP_POLL_MS = 3000;

const clampThumb = (px: number) => Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(Number.isFinite(px) ? px : THUMB_DEFAULT)));

function savedThumbSize(): number {
  try {
    const v = globalThis.localStorage?.getItem(THUMB_KEY);
    return v ? clampThumb(Number(v)) : THUMB_DEFAULT;
  } catch {
    return THUMB_DEFAULT;
  }
}

function saveThumbSize(px: number) {
  try {
    globalThis.localStorage?.setItem(THUMB_KEY, String(px));
  } catch {
    // Private mode or storage switched off: the size just isn't remembered.
  }
}

const withoutRelDir = ({ relDir: _dropped, ...rest }: GalleryFilter): GalleryFilter => rest;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

let toastId = 0;
// Each open() gets a new generation; timers of an older one stop at their next tick.
let generation = 0;
let jobTimer: ReturnType<typeof setTimeout> | null = null;
let stampTimer: ReturnType<typeof setInterval> | null = null;
let lastStamp: string | null = null;
// Info saved by this page while a reload is on its way, numbered, so that older reload cannot undo it.
let saveSeq = 0;
let saved: { seq: number; item: GalleryItem }[] = [];
let reloading = 0;
// A photo's saves go to the server one after another, and the photo is updated from the last reply
// only: an older reply applied while a newer save is on its way would undo it for a moment (and reset
// a field being edited to the older text).
interface SaveQueue {
  tail: Promise<unknown>;
  waiting: number;
  /** The newest reply so far, applied once the last save has finished. */
  latest: GalleryItem | null;
}
const saveQueues = new Map<string, SaveQueue>();

/** The list as it was before a change: its paths, and the stack whose face was the selected photo (null: none). */
interface Before {
  paths: string[];
  topOf: string | null;
}

const noSelection: Pick<GalleryState, 'selected' | 'selection' | 'anchor' | 'viewing'> = { selected: null, selection: [], anchor: null, viewing: null };

function stopTimers() {
  generation++;
  if (jobTimer) clearTimeout(jobTimer);
  if (stampTimer) clearInterval(stampTimer);
  jobTimer = stampTimer = null;
  lastStamp = null;
  saved = [];
}

export const useGallery = create<GalleryState>()((set, get) => {
  const current = (gen: number, job: string) => gen === generation && get().job === job;

  /** Poll the scan every 500 ms, asking only for the photos not seen yet, until it is done. */
  const pollJob = async (gen: number, job: string, failures = 0) => {
    jobTimer = null;
    let u: JobUpdate;
    try {
      u = await galleryApi.job(job, get().items.length);
    } catch (e) {
      if (!current(gen, job)) return;
      // The server may be busy for a moment: try again a few times before giving up.
      if (failures < JOB_RETRIES) {
        jobTimer = setTimeout(() => void pollJob(gen, job, failures + 1), 1000 * 2 ** failures);
        return;
      }
      set({ progress: null });
      get().toast('error', message(e));
      return;
    }
    if (!current(gen, job)) return;
    set((s) => ({
      items: u.items.length ? [...s.items, ...u.items] : s.items,
      progress: u.done ? null : { total: u.total, processed: u.processed, startedAt: u.startedAt },
    }));
    if (!u.done) {
      jobTimer = setTimeout(() => void pollJob(gen, job), JOB_POLL_MS);
      return;
    }
    // Nothing selected yet: start on the first photo, so the keys have somewhere to begin.
    if (get().selected === null) {
      const first = selectVisible(get())[0];
      if (first) get().select(first.path);
    }
    if (u.errors.length) get().toast('error', `${plural(u.errors.length, 'photo')} could not be read: ${u.errors.slice(0, 3).map((e) => e.path.split(/[\\/]/).pop()).join(', ')}${u.errors.length > 3 ? '…' : ''}`);
    await watchInfo(gen, job);
  };

  /** Tell the server to stop reading the open folder when that is still going on (it is no longer wanted). */
  const cancelScan = () => {
    const { job, progress } = get();
    // A failed cancel is harmless: the server cancels it anyway when the next folder is opened.
    if (job && progress) void galleryApi.cancel(job).catch(() => {});
  };

  /** What settleSelection needs to know of the list as it was, taken before the change. */
  const snapshot = (): Before => {
    const s = get();
    const stack = s.selected === null ? undefined : selectStackInfo(s).get(s.selected);
    return { paths: selectablePaths(s), topOf: stack?.top ? stack.id : null };
  };

  /**
   * After photos left the list (hidden, deleted, filtered out, folded away): move the selection on from
   * the list as it was. A stack's face that left gives way to the stack's new face; any other photo to
   * the one now in its place. Photos no longer shown leave the selection (what a drag would take).
   */
  const settleSelection = (before: Before) => {
    const s = get();
    const after = selectablePaths(s);
    if (s.selected !== null && !after.includes(s.selected)) {
      let next: string | null = null;
      if (before.topOf !== null && s.view === 'grid') {
        for (const [path, info] of selectStackInfo(s)) if (info.id === before.topOf && info.top) next = path;
        // One member left: a plain tile now, still the stack's photo.
        if (next === null) {
          const facts = selectFacts(s);
          next = after.find((p) => facts.get(p)?.groupId === before.topOf) ?? null;
        }
      }
      get().select(next ?? nextAfterRemoval(before.paths, after, s.selected));
      return;
    }
    const shown = new Set(after);
    const selection = s.selection.filter((p) => shown.has(p));
    if (selection.length !== s.selection.length) set({ selection });
  };

  /** Unfold the stacks of these photos where they are folded away (picked on the map), so the grid shows them. */
  const unfoldFor = (paths: string[]) => {
    const s = get();
    const ids = foldedStackIds(s, paths).filter((id) => !s.openStacks.includes(id));
    if (ids.length) set({ openStacks: [...s.openStacks, ...ids] });
  };

  /** Once the folder is read, and then every 3 s: has any photoinfo.json of this folder changed? Then reload the photos' info, once. */
  const watchInfo = async (gen: number, job: string) => {
    try {
      const stamp = await galleryApi.stamp(job);
      if (!current(gen, job)) return;
      lastStamp = stamp;
    } catch {
      // No baseline: the first successful poll takes one.
    }
    if (!current(gen, job)) return;
    // The photos came in poll by poll, each with its info as it was then, and the baseline above is
    // newer: reload once so a change another program made while the folder was read is not missed.
    // (A save made meanwhile is kept by refreshInfo's saved/saveSeq check.)
    if (get().items.length) await get().refreshInfo();
    if (!current(gen, job)) return;
    stampTimer = setInterval(async () => {
      try {
        const stamp = await galleryApi.stamp(job);
        if (!current(gen, job) || stamp === lastStamp) return;
        const first = lastStamp === null;
        lastStamp = stamp;
        if (!first) await get().refreshInfo();
      } catch {
        // The server may be busy; try again next time.
      }
    }, STAMP_POLL_MS);
  };

  return {
    job: null,
    root: null,
    items: [],
    progress: null,
    ...noSelection,
    thumbSize: savedThumbSize(),
    sort: 'date',
    filter: {},
    stacked: true,
    openStacks: [],
    recursive: true,
    recent: [],
    toasts: [],
    tidyOpen: false,
    gridCols: 1,
    view: 'grid',

    async loadRecent() {
      try {
        set({ recent: await galleryApi.recent() });
      } catch (e) {
        get().toast('error', message(e));
      }
    },

    async open(folder, recursive) {
      cancelScan();
      stopTimers();
      const gen = generation;
      // The subfolders of the old folder mean nothing in this one.
      set((s) => ({ filter: withoutRelDir(s.filter), job: null, root: folder, items: [], openStacks: [], ...noSelection, progress: { total: 0, processed: 0, startedAt: Date.now() } }));
      let job: string;
      try {
        job = (await galleryApi.open(folder, recursive)).jobId;
      } catch (e) {
        if (gen !== generation) return;
        set({ root: null, progress: null });
        get().toast('error', message(e));
        void get().loadRecent();
        return;
      }
      if (gen !== generation) return;
      set({ job });
      void get().loadRecent();
      await pollJob(gen, job);
    },

    async saveInfo(path, patch) {
      const job = get().job;
      const gen = generation;
      let queue = saveQueues.get(path);
      if (!queue) saveQueues.set(path, (queue = { tail: Promise.resolve(), waiting: 0, latest: null }));
      const q = queue;
      q.waiting++;
      const send = async (): Promise<boolean> => {
        try {
          const { stamp, ...updated } = await galleryApi.patchInfo(path, patch, job ?? undefined);
          q.latest = updated;
          // Our own write changed the stamp. Take the new one as the baseline (no reload of every
          // photo) only when nothing else had changed since the last poll; otherwise the next poll
          // sees the difference and reloads, picking up the other program's change too.
          if (job && current(gen, job) && stamp && lastStamp !== null && stamp.before === lastStamp) lastStamp = stamp.after;
          return true;
        } catch (e) {
          get().toast('error', message(e));
          return false;
        }
      };
      const run = q.tail.then(send);
      q.tail = run;
      const ok = await run;
      if (--q.waiting > 0) return ok;
      if (saveQueues.get(path) === q) saveQueues.delete(path);
      const updated = q.latest;
      if (updated) {
        set((s) => ({ items: s.items.map((i) => (i.path === path ? updated : i)) }));
        if (job && current(gen, job)) {
          saveSeq++;
          if (reloading > 0) saved.push({ seq: saveSeq, item: updated });
        }
      }
      return ok;
    },

    setStar(path, star) {
      return get().saveInfo(path, { star });
    },

    async refreshInfo() {
      const job = get().job;
      if (!job) return;
      const gen = generation;
      const since = saveSeq;
      reloading++;
      try {
        const items = await galleryApi.items(job);
        if (!current(gen, job)) return;
        // Saves that finished while this reload was on its way may be missing from it: keep them.
        saved = saved.filter((s) => s.seq > since);
        const newer = new Map(saved.map((s) => [s.item.path, s.item]));
        set({ items: newer.size ? items.map((i) => newer.get(i.path) ?? i) : items });
      } catch (e) {
        if (current(gen, job)) get().toast('error', message(e));
      } finally {
        if (--reloading === 0) saved = [];
      }
    },

    select(path) {
      set({ selected: path, selection: path === null ? [] : [path], anchor: path });
    },

    clickSelect(path, mods) {
      const s = get();
      set(clickSelect(selectVisible(s).map((i) => i.path), s, path, mods));
    },

    openViewer(path) {
      // A photo folded into a stack (picked on the map) is shown unfolded: the viewer steps through the grid's list.
      unfoldFor([path]);
      set({ viewing: path });
    },

    viewPhoto(path) {
      if (get().viewing !== null) set({ viewing: path });
    },

    closeViewer(last) {
      set(last === null ? { viewing: null } : { viewing: null, selected: last, selection: [last], anchor: last });
    },

    setThumbSize(px) {
      const thumbSize = clampThumb(px);
      set({ thumbSize });
      saveThumbSize(thumbSize);
    },

    setSort(sort) {
      set({ sort });
    },

    setFilter(patch) {
      const before = snapshot();
      set((s) => {
        const filter: GalleryFilter = { ...s.filter, ...patch };
        for (const k of Object.keys(filter) as (keyof GalleryFilter)[]) if (filter[k] === undefined) delete filter[k];
        return { filter };
      });
      settleSelection(before);
    },

    clearFilter() {
      const before = snapshot();
      set({ filter: {} });
      settleSelection(before);
    },

    setRecursive(recursive) {
      set({ recursive });
    },

    setStacked(stacked) {
      const before = snapshot();
      set({ stacked });
      settleSelection(before);
    },

    toggleStack(id) {
      const s = get();
      const before = snapshot();
      const folding = s.openStacks.includes(id);
      const member = s.selected === null ? undefined : selectStackInfo(s).get(s.selected);
      set({ openStacks: folding ? s.openStacks.filter((o) => o !== id) : [...s.openStacks, id] });
      // Folding the stack the selected photo is in: its face takes the selection.
      if (folding && member?.id === id && !member.top && s.view === 'grid') {
        for (const [path, info] of selectStackInfo(get())) if (info.id === id && info.top) get().select(path);
        return;
      }
      settleSelection(before);
    },

    async toggleFlag(field) {
      const s = get();
      const byPath = new Map(s.items.map((i) => [i.path, i]));
      const targets = flagTargets(s.selection, s.selected, (p) => byPath.get(p)?.info[field] === true);
      if (!targets) return;
      const before = snapshot();
      await Promise.all(
        targets.paths.map((p) => (field === 'star' ? get().setStar(p, targets.value) : get().saveInfo(p, { hidden: targets.value ? true : null }))),
      );
      settleSelection(before);
    },

    removeItems(paths) {
      const before = snapshot();
      const gone = new Set(paths);
      set((s) => ({ items: s.items.filter((i) => !gone.has(i.path)) }));
      settleSelection(before);
    },

    close() {
      cancelScan();
      stopTimers();
      set({ job: null, root: null, items: [], openStacks: [], progress: null, ...noSelection, tidyOpen: false });
    },

    setTidyOpen(tidyOpen) {
      set({ tidyOpen });
    },

    setGridCols(cols) {
      const gridCols = Math.max(1, Math.floor(cols) || 1);
      if (gridCols !== get().gridCols) set({ gridCols });
    },

    setView(view) {
      const s = get();
      if (view === s.view) return;
      // Photos picked on the map may be folded into a stack on the grid: their stacks unfold, so the
      // selection stays as it was and in view.
      if (view === 'grid') unfoldFor(s.selected === null ? s.selection : [...s.selection, s.selected]);
      const before = snapshot();
      set({ view });
      settleSelection(before);
    },

    toast(kind, text) {
      const id = ++toastId;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
});

// What the grid shows: the photos filtered and sorted. One list for the grid and the viewer, worked out
// again only when the photos, sort or filter change. The facts (interesting score, colour, quality flags,
// bursts) are costly on a big folder, so they are worked out only when a sort or filter reads them.
const needsFacts = (sort: GallerySortKey, f: GalleryFilter, stacked?: boolean) => !!stacked || sort === 'interesting' || sort === 'colour' || !!f.lowQuality || !!f.nearDuplicates;
const NO_FACTS = new Map<string, GalleryFacts>();
const NO_STACKS = new Map<string, StackInfo>();
let factsMemo: { items: GalleryItem[]; facts: Map<string, GalleryFacts>; at: number } | null = null;
let visibleMemo: {
  items: GalleryItem[]; sort: GallerySortKey; filter: GalleryFilter; stacked: boolean; openStacks: string[] | undefined;
  filtered: GalleryItem[]; visible: GalleryItem[]; stackOf: Map<string, StackInfo>; facts: Map<string, GalleryFacts>; stale: boolean;
} | null = null;

const sameAnalysis = (a: GalleryItem['analysis'], b: GalleryItem['analysis']) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

/**
 * True when the facts of `b` are those of `a`: the same photos in the same order, each with the same
 * name, size, date, star and analysis (all galleryFacts reads). A save (H, a description, a place)
 * replaces one photo with the server's reply and leaves these alone but for a star or a date, so the
 * costly grouping of bursts is not redone for it.
 */
function sameFactsInput(a: GalleryItem[], b: GalleryItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (
      x.path !== y.path || x.fileName !== y.fileName || x.size !== y.size || x.width !== y.width || x.height !== y.height ||
      x.effectiveDate !== y.effectiveDate || (x.info.star === true) !== (y.info.star === true) || !sameAnalysis(x.analysis, y.analysis)
    ) return false;
  }
  return true;
}
/** While a folder is still being read, facts are refreshed at most this often. */
const FACTS_SCAN_THROTTLE_MS = 2000;

type VisibleInput = Pick<GalleryState, 'items' | 'sort' | 'filter'> & { progress?: GalleryState['progress']; stacked?: boolean; openStacks?: string[] };

export function selectVisible(s: VisibleInput): GalleryItem[] {
  const stacked = !!s.stacked;
  const m = visibleMemo;
  if (m && m.items === s.items && m.sort === s.sort && m.filter === s.filter && m.stacked === stacked && m.openStacks === s.openStacks && !(m.stale && !s.progress)) return m.visible;
  const withFacts = needsFacts(s.sort, s.filter, stacked);
  let facts = NO_FACTS;
  if (withFacts) {
    const now = Date.now();
    // Mid-scan the list grows every half second: keep the last facts (new photos have none yet) for a while.
    if (factsMemo && factsMemo.items !== s.items && sameFactsInput(factsMemo.items, s.items)) factsMemo = { ...factsMemo, items: s.items };
    const fresh = factsMemo?.items === s.items || (!!s.progress && !!factsMemo && now >= factsMemo.at && now - factsMemo.at < FACTS_SCAN_THROTTLE_MS);
    if (!fresh) factsMemo = { items: s.items, facts: galleryFacts(s.items), at: now };
    facts = factsMemo!.facts;
  }
  const sorted = sortItems(filterItems(s.items, s.filter, facts), s.sort, facts);
  const folded = stacked ? stackItems(sorted, facts, new Set(s.openStacks ?? [])) : null;
  const visible = folded ? folded.items : sorted;
  // Built from stale facts: remembered (the selector must return the same list for the same state), but redone once the scan ends.
  const stale = withFacts && factsMemo?.items !== s.items;
  visibleMemo = { items: s.items, sort: s.sort, filter: s.filter, stacked, openStacks: s.openStacks, filtered: sorted, visible, stackOf: folded ? folded.stackOf : NO_STACKS, facts, stale };
  return visible;
}

/** The stacks in the visible list, by photo path (empty when stacking is off): same memo as selectVisible. */
export function selectStackInfo(s: VisibleInput): Map<string, StackInfo> {
  selectVisible(s);
  return visibleMemo!.stackOf;
}

/**
 * Every photo that passes the filter, sorted, with stacks unfolded (the map gives each one a marker):
 * same memo as selectVisible.
 */
export function selectFiltered(s: VisibleInput): GalleryItem[] {
  selectVisible(s);
  return visibleMemo!.filtered;
}

/** The facts the visible list was built from (empty when nothing needed them): same memo as selectVisible. */
export function selectFacts(s: VisibleInput): Map<string, GalleryFacts> {
  selectVisible(s);
  return visibleMemo!.facts;
}

/**
 * Where the selection may rest: the grid's tiles, or (on the map, where every shown photo has its own
 * marker) every photo that passes the filter, stacks unfolded. The list the user is looking at.
 */
export function selectablePaths(s: VisibleInput & Pick<GalleryState, 'view'>): string[] {
  return (s.view === 'map' ? selectFiltered(s) : selectVisible(s)).map((i) => i.path);
}

/**
 * What the photo menu's Copy path and Delete take when `path` is right-clicked: every selected photo,
 * in the order of the list the user is looking at (the map's list, folded members included, on the
 * map), when `path` is one of them; else just `path`.
 */
export function menuTargets(path: string): string[] {
  const s = useGallery.getState();
  const targets = dragPaths(selectablePaths(s), s.selection, path);
  return targets.length ? targets : [path];
}

/** The stacks these photos are folded away in (they pass the filter but have no tile of their own). */
function foldedStackIds(s: VisibleInput, paths: string[]): string[] {
  if (!s.stacked || !paths.length) return [];
  const tiles = new Set(selectVisible(s).map((i) => i.path));
  const shown = new Set(selectFiltered(s).map((i) => i.path));
  const facts = selectFacts(s);
  const ids = new Set<string>();
  for (const p of paths) {
    const id = facts.get(p)?.groupId;
    if (id && shown.has(p) && !tiles.has(p)) ids.add(id);
  }
  return [...ids];
}

/**
 * A photo's place in its stack, folded or not: the face is 1, the other members follow in the shown
 * order (as the grid shows them once the stack is unfolded). Null when the photo is in no stack.
 */
export function selectStackPlace(s: VisibleInput, path: string): { place: number; size: number } | null {
  if (!s.stacked) return null;
  const facts = selectFacts(s);
  const id = facts.get(path)?.groupId;
  if (!id) return null;
  let top: string | null = null;
  for (const [p, info] of selectStackInfo(s)) if (info.id === id && info.top) top = p;
  if (top === null) return null;
  const members = selectFiltered(s).filter((i) => i.path !== top && facts.get(i.path)?.groupId === id).map((i) => i.path);
  const order = [top, ...members];
  const at = order.indexOf(path);
  return at < 0 ? null : { place: at + 1, size: order.length };
}

/** The photos to show, in order: the grid and the viewer step through this one list. */
export const useVisibleItems = (): GalleryItem[] => useGallery((s) => selectVisible(s));

export const useStackInfo = (): Map<string, StackInfo> => useGallery((s) => selectStackInfo(s));

export const useFilteredItems = (): GalleryItem[] => useGallery((s) => selectFiltered(s));

/**
 * Open each folder the desktop app hands the page (`--gallery <folder>`, a second launch, File >
 * Open folder), with the current "Include subfolders" choice, and show a drag that could not start
 * as an error. Returns a function that stops listening.
 */
export function connectDesktop(d: Pick<DesktopApi, 'onOpenFolder' | 'onDragFailed'> | undefined): () => void {
  const stopFolders = d?.onOpenFolder?.((folder) => void useGallery.getState().open(folder, useGallery.getState().recursive));
  const stopDrags = d?.onDragFailed?.((message) => useGallery.getState().toast('error', message));
  return () => {
    stopFolders?.();
    stopDrags?.();
  };
}
