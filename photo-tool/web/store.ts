import { create } from 'zustand';
import type { DesktopApi } from '../../shared/desktop/desktopApi';
import { filterItems, galleryFacts, sortItems, type GalleryFacts, type GalleryFilter, type GallerySortKey, type TagFilter } from '../core/gallerySort';
import { clickSelect, dragPaths, flagTargets, nextAfterRemoval } from '../core/galleryViewer';
import { stackItems, type StackInfo } from '../core/galleryStacks';
import { IDENTITY_EDIT, isIdentityEdit, parseEdit, type PhotoEdit } from '../../shared/core/photoEdit';
import { photoScores, scoreAdjustOf, type PhotoScore } from '../core/photoScore';
import { loadEditTarget, saveEditTarget, type EditTarget } from './editSettings';
import { galleryApi, type GalleryItem, type JobUpdate, type RecentFolder, type TaggingStatus } from './api';

// The gallery's state: the open folder, its photos (filled in while the folder is read), the
// selection, thumbnail size and toasts. Photo info lives in photoinfo.json files that other
// programs (the editor, a text editor) may change, so an open folder is checked every few seconds.

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

/**
 * One change Ctrl+Z can take back: the info fields of some photos as they were before it (a field that was
 * not there is null), and/or their unsaved edits as they were (undefined: none).
 */
export interface UndoStep {
  /** Said in the toast: "Undid: hide". */
  label: string;
  info: { path: string; before: Record<string, unknown> }[];
  edits?: { path: string; before: PhotoEdit | undefined }[];
}

/** The toast on the preview after Up or Down: the change, and how many photos it was made to. */
export interface ScoreToast {
  id: number;
  delta: 1 | -1;
  /** The selected photo, whose new score the toast shows (with one photo nudged). */
  path: string;
  count: number;
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
  /** Tiles per row in the grid as drawn now (the grid publishes it). 1 while the grid is not shown. */
  gridCols: number;
  /** What the thumbnail column shows: the grid, or the photos on a map. Kept across folders, for the session. */
  view: 'grid' | 'map';
  /** The photo being cropped and turned in the preview pane (edit mode), or null. */
  editing: string | null;
  /** Edits made in the page and not saved yet, by photo path. IDENTITY_EDIT here means "remove the saved edit". */
  pendingEdits: Record<string, PhotoEdit>;
  /** Where a saved edit goes: the photo's info file (photoinfo.json's `edit`) or the photo file itself. Always 'info' without the desktop app. */
  editTarget: EditTarget;
  /** A save of edits is on its way (the save buttons wait for it). */
  saving: boolean;
  /** The photos whose save is on its way: they can't be edited (or saved again) until it is done. */
  savingPaths: string[];
  /** The edit in progress differs from where it started (it counts as an unsaved edit). */
  editDirty: boolean;
  /** The Settings dialog is open. */
  settingsOpen: boolean;
  /** Opening another folder (or closing this one) waits for "without saving?": what was asked for. */
  leaving: { folder: string; recursive: boolean } | 'close' | null;
  /** What Ctrl+Z takes back, oldest first (at most UNDO_LIMIT); emptied when a folder is opened or closed. */
  undoStack: UndoStep[];
  /** The Up/Down toast on the preview, or null. */
  scoreToast: ScoreToast | null;
  /** Photo tagging of the open folder (null: nothing known yet, or it is tagging another folder). */
  tagging: TaggingStatus | null;
  /** Photos found by meaning for the search text `q` (best first); shown after the word matches while `q` is the search text. */
  meaning: { q: string; paths: string[] } | null;

  loadRecent(): Promise<void>;
  open(folder: string, recursive: boolean): Promise<void>;
  /**
   * Save fields of a photo's info (a null value deletes the field). Resolves false, after an error toast
   * with the server's message, when it could not be saved; nothing is applied then.
   */
  saveInfo(path: string, patch: Record<string, unknown>, opts?: SaveInfoOptions): Promise<boolean>;
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
  /** Add a keyword or object filter, or take it away when it is set already. */
  toggleTagFilter(f: TagFilter): void;
  /** Pause or resume photo tagging (kept in Settings). */
  setTaggingPaused(paused: boolean): Promise<void>;
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
  setSettingsOpen(open: boolean): void;
  setGridCols(cols: number): void;
  setView(view: 'grid' | 'map'): void;
  /** Open edit mode on this photo; not while its save is on its way. */
  startEdit(path: string): void;
  /**
   * Done: the edit (null: none) becomes the photo's unsaved edit, unless it is what is saved already
   * (no edit when nothing is saved), which clears any unsaved edit instead. Leaves edit mode.
   */
  finishEdit(edit: PhotoEdit | null): void;
  /** Cancel: leave edit mode; the unsaved edits stay as they were before it opened. */
  cancelEdit(): void;
  /** Drop a photo's unsaved edit. */
  discardEdit(path: string): void;
  /**
   * Edit mode reports the edit in progress (null: none) as it changes. Selecting another photo while
   * editing is Done with it, as if Done had been pressed.
   */
  setEditDraft(edit: PhotoEdit | null): void;
  /** Read where edits are saved (the desktop app's setting, else localStorage). */
  loadEditTarget(): Promise<void>;
  /** Change where edits are saved; kept at once. 'file' needs the desktop app. */
  setEditTarget(target: EditTarget): Promise<void>;
  /**
   * Save a photo's unsaved edit: into its info file, or (photo-file mode) into the photo file itself through
   * the desktop app. Resolves false, after an error toast, when it was not saved; the unsaved edit stays then.
   */
  saveEdit(path: string): Promise<boolean>;
  /** Save the photo with its unsaved edit as a new file (desktop app). The original and its unsaved edit stay. */
  saveEditAs(path: string): Promise<boolean>;
  /** Save every unsaved edit, one after another, then say how it went in one toast. */
  saveAllEdits(): Promise<void>;
  /** Revert to original: remove the edit saved in the photo's info file. */
  revertEdit(path: string): Promise<boolean>;
  /** Open another folder, asking first (`leaving`) while there are unsaved edits. */
  requestOpen(folder: string, recursive: boolean): Promise<void>;
  /** Close the folder, asking first while there are unsaved edits. */
  requestClose(): void;
  /** "Without saving?" answered yes: open or close as asked. */
  confirmLeave(): Promise<void>;
  cancelLeave(): void;
  /**
   * Up (+1) or Down (−1): nudge the score of the selected photo, every selected one when several are
   * (photoinfo.json `scoreAdjust`). Shown at once, with a toast on the preview; saved in the background.
   */
  nudgeScore(delta: 1 | -1): void;
  /** Ctrl+Z: take back the last change in undoStack, toasting what was undone. Not while editing. */
  undo(): Promise<void>;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
}

export interface SaveInfoOptions {
  /** No error toast (the caller says it). */
  quiet?: boolean;
  /**
   * Ctrl+Z can take this save back (the default), named by this label (default: from the fields saved).
   * False: not recorded (the caller records the change itself, or this is an undo).
   */
  undo?: string | false;
}

/** Ctrl+Z goes back at most this many changes. */
export const UNDO_LIMIT = 100;
/** How long the Up/Down toast stays on the preview (ms). */
export const SCORE_TOAST_MS = 1100;

const UNDO_LABELS: Record<string, string> = {
  star: 'favourite', hidden: 'hide', scoreAdjust: 'score', edit: 'crop and rotate', people: 'people', description: 'description',
  notes: 'notes', date: 'date', location: 'location',
};
/** What an undo of a save of these fields is called. */
export const undoLabel = (patch: Record<string, unknown>) => {
  const k = Object.keys(patch)[0];
  return k === undefined ? 'change' : (UNDO_LABELS[k] ?? k);
};

/** The fields of `info` that `patch` writes, as they are now (missing: null). */
function fieldsBefore(info: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(patch).map((k) => [k, info[k] ?? null]));
}
const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The stack with this step on top (the oldest dropped past UNDO_LIMIT). */
const pushUndo = (stack: UndoStep[], step: UndoStep) => [...stack.slice(-(UNDO_LIMIT - 1)), step];

/** The undo step for what leaving edit mode did to the edited photo's unsaved edit (null: nothing changed). */
function editUndo(s: GalleryState, next: Partial<GalleryState>): UndoStep | null {
  const path = s.editing;
  if (path === null || !next.pendingEdits) return null;
  const before = s.pendingEdits[path];
  const after = next.pendingEdits[path];
  if (before === after || (before && after && sameEdit(before, after))) return null;
  return { label: 'crop and rotate', info: [], edits: [{ path, before }] };
}

/** `next` with the undo step for its change to the edited photo's unsaved edit, when there is one. */
function withEditUndo(s: GalleryState, next: Partial<GalleryState>): Partial<GalleryState> {
  const step = editUndo(s, next);
  return step ? { ...next, undoStack: pushUndo(s.undoStack, step) } : next;
}

/** `info` with the score nudges set to `n` (0: no field). */
function withAdjust<T extends Record<string, unknown>>(info: T, n: number): T {
  const { scoreAdjust: _old, ...rest } = info;
  return (n === 0 ? rest : { ...rest, scoreAdjust: n }) as T;
}

export const THUMB_MIN = 96;
export const THUMB_MAX = 320;
const THUMB_DEFAULT = 160;
const THUMB_KEY = 'gallery.thumbSize';
const JOB_POLL_MS = 500;
/** A failed scan poll is retried this many times (1 s, 2 s, 4 s apart) before giving up. */
const JOB_RETRIES = 3;
const STAMP_POLL_MS = 3000;
/** Photo tagging's status is read this often while it runs (STAMP_POLL_MS otherwise). */
const TAG_POLL_MS = 1000;
/** While tagging runs, the photos are reloaded for their new tags at most this often (and once when it stops). */
const TAG_REFRESH_MS = 10_000;
/** Each reload while tagging runs costs about this per photo, so a big folder reloads less often (10,000 photos: once a minute). */
const TAG_REFRESH_MS_PER_PHOTO = 6;
/** The photos tagging is asked to look at first: the selected one, then this many of the grid's. */
const FOCUS_COUNT = 200;
const FOCUS_DEBOUNCE_MS = 500;
/** Search by meaning is asked this long after the search text last changed. */
const MEANING_DEBOUNCE_MS = 300;
/** Search by meaning needs this many letters. */
const MEANING_MIN_LETTERS = 3;

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
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** Up to three names, then "…". */
const someNames = (paths: string[]) => `${paths.slice(0, 3).map(baseName).join(', ')}${paths.length > 3 ? '…' : ''}`;

/** HEIC can't be written: in photo-file mode such a photo is saved only as a copy (JPEG). */
export const isHeic = (path: string) => /\.(heic|heif)$/i.test(path);
export const HEIC_SAVE_NOTE = 'HEIC photos can only be saved as a copy';

/** A GalleryItem from the desktop app (it hands back the server's reply untyped). */
const asItem = (v: unknown): GalleryItem | null =>
  v && typeof v === 'object' && typeof (v as GalleryItem).path === 'string' && typeof (v as GalleryItem).key === 'string' ? (v as GalleryItem) : null;

let toastId = 0;
// Each open() gets a new generation; timers of an older one stop at their next tick.
let generation = 0;
let jobTimer: ReturnType<typeof setTimeout> | null = null;
let stampTimer: ReturnType<typeof setInterval> | null = null;
let lastStamp: string | null = null;
let tagTimer: ReturnType<typeof setTimeout> | null = null;
// The tagging stamp the photos were last reloaded for (null: no baseline yet), and when.
let tagSeen: number | null = null;
let tagRefreshedAt = 0;
let focusTimer: ReturnType<typeof setTimeout> | null = null;
let meaningTimer: ReturnType<typeof setTimeout> | null = null;
// Each search by meaning asked is numbered; only the newest one's reply is used.
let meaningSeq = 0;
let lastFocus = '';
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
// The desktop app's extras, as connectDesktop was handed them (undefined in a plain browser).
let host: Partial<DesktopApi> | undefined;
// The edit in progress in edit mode, as edit mode last reported it, for the photo being edited.
let draft: { path: string; edit: PhotoEdit | null } | null = null;
// Score nudges shown in the page and not confirmed by the server yet, by photo path, with how many saves
// of them are on their way: a quick run of Up presses counts from the newest value, not the saved one.
const pendingAdjust = new Map<string, { value: number; waiting: number }>();
// Info fields sent to the server and not confirmed yet, by photo path (the newest value of each): a change
// made while a save is on its way (a second click on a star, H then Ctrl+Z) counts from what was sent.
const inFlight = new Map<string, Record<string, unknown>>();
let scoreToastId = 0;
// Saves of edits on their way (the store's `saving` is true while any is).
let savingCount = 0;
/** Saving into the photo file needs the desktop app. */
const canSaveToFile = () => !!host?.saveEditToFile;

/** The list as it was before a change: its paths, and the stack whose face was the selected photo (null: none). */
interface Before {
  paths: string[];
  topOf: string | null;
}

const noSelection: Pick<GalleryState, 'selected' | 'selection' | 'anchor' | 'viewing'> = { selected: null, selection: [], anchor: null, viewing: null };
/** A folder opened or closed: its unsaved edits, and edit mode, go with it. */
const noEdits: Pick<GalleryState, 'editing' | 'pendingEdits' | 'leaving' | 'editDirty' | 'undoStack' | 'scoreToast'> = { editing: null, pendingEdits: {}, leaving: null, editDirty: false, undoStack: [], scoreToast: null };

const without = (edits: Record<string, PhotoEdit>, path: string) => {
  const { [path]: _dropped, ...others } = edits;
  return others;
};

/** The same edit, to 1e-4 (null is no edit). */
function sameEdit(a: PhotoEdit | null, b: PhotoEdit | null): boolean {
  const x = a ?? IDENTITY_EDIT;
  const y = b ?? IDENTITY_EDIT;
  const near = (p: number, q: number) => Math.abs(p - q) <= 1e-4;
  return (
    x.rotate === y.rotate && near(x.straighten, y.straighten) &&
    near(x.crop.x, y.crop.x) && near(x.crop.y, y.crop.y) && near(x.crop.w, y.crop.w) && near(x.crop.h, y.crop.h)
  );
}

// Read once per stored value, so a selector hands back the same object each time (and nothing re-renders for it).
const parsedEdits = new WeakMap<object, PhotoEdit | null>();
function parseSaved(raw: unknown): PhotoEdit | null {
  if (!raw || typeof raw !== 'object') return null;
  let e = parsedEdits.get(raw);
  if (e === undefined) parsedEdits.set(raw, (e = parseEdit(raw)));
  return e;
}

/** The edit saved for a photo, as the page sees it: the info file's, in info-file mode; none in photo-file mode (the file carries it). */
const savedEdit = (s: Pick<GalleryState, 'editTarget'>, item: GalleryItem): PhotoEdit | null => (s.editTarget === 'info' ? parseSaved(item.info.edit) : null);

/** The edit the page shows for a photo: its unsaved edit, else the saved one. Null: none. */
export function shownEdit(s: Pick<GalleryState, 'pendingEdits' | 'editTarget'>, item: GalleryItem): PhotoEdit | null {
  return s.pendingEdits[item.path] ?? savedEdit(s, item);
}

/** What can be done with a photo's edit now: the preview caption and the photo menu offer the same. */
export interface EditActions {
  /** It has an unsaved edit: Save and Save as… are offered. */
  save: boolean;
  /** Why Save is greyed out (a HEIC photo in photo-file mode), or null. */
  saveBlocked: string | null;
  saveTitle: string;
  /** Why Save as… is greyed out (no desktop app), or null. */
  saveAsBlocked: string | null;
  /** Photos with an unsaved edit: Save all (N) while above 0. */
  saveAll: number;
  /** Revert to original: an edit saved in the info file (info-file mode), with nothing unsaved over it. */
  revert: boolean;
}

export function editActions(s: Pick<GalleryState, 'pendingEdits' | 'editTarget'>, item: GalleryItem): EditActions {
  const pending = item.path in s.pendingEdits;
  const file = s.editTarget === 'file';
  return {
    save: pending,
    saveBlocked: file && isHeic(item.path) ? HEIC_SAVE_NOTE : null,
    saveTitle: file ? 'Save the edit into the photo file (the original goes to the Recycle Bin)' : "Save the edit in the photo's info file",
    saveAsBlocked: host?.saveEditAs ? null : 'Save as needs the desktop app',
    saveAll: Object.keys(s.pendingEdits).length,
    revert: !pending && !file && parseSaved(item.info.edit) !== null,
  };
}

/**
 * The unsaved edits after Done on `path` with `edit` (null: none): it becomes the photo's unsaved edit,
 * unless it is what is saved already, which clears any unsaved edit instead. A photo no longer in the
 * list keeps none.
 */
function afterDone(s: GalleryState, path: string, edit: PhotoEdit | null): Record<string, PhotoEdit> {
  const item = s.items.find((i) => i.path === path);
  const others = without(s.pendingEdits, path);
  if (!item || sameEdit(edit, savedEdit(s, item))) return others;
  return { ...others, [path]: edit ?? IDENTITY_EDIT };
}

/**
 * Leave edit mode as Done does, with the edit in progress edit mode last reported (when it reported
 * none, the unsaved edits stay as they were). Nothing when not editing.
 */
function endEditAsDone(s: GalleryState): Partial<GalleryState> {
  const path = s.editing;
  if (path === null) return {};
  const d = draft?.path === path ? draft : null;
  draft = null;
  if (d) return { editing: null, editDirty: false, pendingEdits: afterDone(s, path, d.edit) };
  return { editing: null, editDirty: false, pendingEdits: s.items.some((i) => i.path === path) ? s.pendingEdits : without(s.pendingEdits, path) };
}

/**
 * How many photos have edits not saved: those with an unsaved edit, and the one being edited when the edit
 * in progress changed something (once, when it has an unsaved edit already).
 */
export function unsavedCount(s: Pick<GalleryState, 'pendingEdits' | 'editing' | 'editDirty'>): number {
  const n = Object.keys(s.pendingEdits).length;
  return s.editDirty && s.editing !== null && !(s.editing in s.pendingEdits) ? n + 1 : n;
}

function stopTimers() {
  generation++;
  if (jobTimer) clearTimeout(jobTimer);
  if (stampTimer) clearInterval(stampTimer);
  if (tagTimer) clearTimeout(tagTimer);
  if (focusTimer) clearTimeout(focusTimer);
  if (meaningTimer) clearTimeout(meaningTimer);
  meaningSeq++;
  jobTimer = stampTimer = tagTimer = focusTimer = meaningTimer = null;
  lastStamp = null;
  tagSeen = null;
  tagRefreshedAt = 0;
  lastFocus = '';
  saved = [];
  draft = null;
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

  /**
   * Read photo tagging's status every 3 s (every 1 s while it runs). When photos got new tags (the stamp moved)
   * they are reloaded, at most every 10 s while tagging runs and once when it stops; not while the folder is read.
   * Tagging starts once the folder is read, so this folder's status is first seen after that.
   */
  const watchTagging = async (gen: number, job: string) => {
    tagTimer = null;
    let st: TaggingStatus | null = null;
    try {
      st = await galleryApi.taggingStatus();
    } catch {
      // Not there (an older server) or busy: try again next time.
    }
    if (!current(gen, job)) return;
    const mine = st?.job === job ? st : null;
    if (st) set({ tagging: mine });
    // The first reading of this folder's tagging reloads too: it may have finished before this page first looked.
    if (mine && mine.stamp !== tagSeen && get().progress === null) {
      if (tagSeen === null || !mine.running || Date.now() - tagRefreshedAt >= Math.max(TAG_REFRESH_MS, get().items.length * TAG_REFRESH_MS_PER_PHOTO)) {
        tagSeen = mine.stamp;
        tagRefreshedAt = Date.now();
        await get().refreshInfo();
        if (!current(gen, job)) return;
      }
    }
    tagTimer = setTimeout(() => void watchTagging(gen, job), st?.running ? TAG_POLL_MS : STAMP_POLL_MS);
  };

  /**
   * The search text changed: 300 ms later, ask which photos match it by meaning (when tagging is on for the folder
   * and the text has 3 letters). A reply for older text, or another folder, is dropped.
   */
  const searchByMeaning = () => {
    if (meaningTimer) clearTimeout(meaningTimer);
    meaningTimer = null;
    const seq = ++meaningSeq;
    const { job, filter, items } = get();
    const q = filter.text?.trim() ?? '';
    if (!job || (q.match(/\p{L}/gu)?.length ?? 0) < MEANING_MIN_LETTERS || !items.some((i) => i.tags.state !== 'off')) {
      if (get().meaning) set({ meaning: null });
      return;
    }
    const gen = generation;
    meaningTimer = setTimeout(async () => {
      meaningTimer = null;
      try {
        const { paths } = await galleryApi.search(job, q);
        if (seq === meaningSeq && current(gen, job)) set({ meaning: { q, paths } });
      } catch {
        // Only the extra matches go missing; the word matches are shown.
      }
    }, MEANING_DEBOUNCE_MS);
  };

  /** A photo's file name, as the list has it. */
  const nameOf = (path: string) => get().items.find((i) => i.path === path)?.fileName ?? baseName(path);

  /** Run a save of edits, with `saving` true while any is on its way. */
  const busy = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (savingCount++ === 0) set({ saving: true });
    try {
      return await fn();
    } finally {
      if (--savingCount === 0) set({ saving: false });
    }
  };

  /** Put the server's new reading of a photo in the list (kept over a reload that was already on its way). */
  const applyItem = (path: string, updated: GalleryItem) => {
    set((s) => ({ items: s.items.map((i) => (i.path === path ? updated : i)) }));
    saveSeq++;
    if (reloading > 0) saved.push({ seq: saveSeq, item: updated });
  };

  /** Save one photo's unsaved edit, marking it as being saved meanwhile (a second save of it is refused: false). */
  const saveOne = async (path: string, quiet: boolean): Promise<boolean> => {
    if (get().savingPaths.includes(path)) return false;
    set((x) => ({ savingPaths: [...x.savingPaths, path] }));
    try {
      return await saveOneNow(path, quiet);
    } finally {
      set((x) => ({ savingPaths: x.savingPaths.filter((p) => p !== path) }));
    }
  };

  /** Save one photo's unsaved edit (see saveEdit). Quiet: no error toast (Save all says it once). */
  const saveOneNow = async (path: string, quiet: boolean): Promise<boolean> => {
    const s = get();
    const edit = s.pendingEdits[path];
    if (!edit) return true;
    const fail = (text: string) => {
      if (!quiet) get().toast('error', text);
      return false;
    };
    if (s.editTarget === 'info') {
      const ok = await get().saveInfo(path, { edit: isIdentityEdit(edit) ? null : edit }, { quiet });
      // Changed again while the save was on its way: that newer edit is still unsaved.
      if (ok && get().pendingEdits[path] === edit) set((x) => ({ pendingEdits: without(x.pendingEdits, path) }));
      return ok;
    }
    if (isHeic(path)) return fail(HEIC_SAVE_NOTE);
    // No edit, in photo-file mode: the file is as it should be already. An edit saved in its info file
    // (from info-file mode) is what "no edit" takes away: only photoinfo.json is written.
    if (isIdentityEdit(edit)) {
      const item = s.items.find((i) => i.path === path);
      const ok = item && parseSaved(item.info.edit) !== null ? await get().saveInfo(path, { edit: null }, { quiet }) : true;
      if (ok && get().pendingEdits[path] === edit) set((x) => ({ pendingEdits: without(x.pendingEdits, path) }));
      return ok;
    }
    const saveToFile = host?.saveEditToFile;
    if (!saveToFile) return fail('Saving into the photo file needs the desktop app');
    const gen = generation;
    let r: Awaited<ReturnType<typeof saveToFile>>;
    try {
      r = await saveToFile(path, edit);
    } catch (e) {
      return fail(`Couldn't save the photo: ${message(e)}`);
    }
    if (!r.ok && !r.saved) return fail(r.error ?? "Couldn't save the photo.");
    if (gen !== generation) return true;
    // The file now carries the edit: an unsaved edit left on it (even one changed meanwhile) would be applied twice,
    // and so would an undo of Done putting an older unsaved edit back over it. Its crop steps are forgotten.
    set((x) => ({
      undoStack: x.undoStack.flatMap((st) => {
        if (!st.edits?.some((e) => e.path === path)) return [st];
        const edits = st.edits.filter((e) => e.path !== path);
        return edits.length || st.info.length ? [{ ...st, edits }] : [];
      }),
    }));
    const now = get().pendingEdits[path];
    if (now && now !== edit && !sameEdit(now, edit)) get().toast('error', `A later change to ${nameOf(path)} was not saved`);
    set((x) => ({ pendingEdits: without(x.pendingEdits, path) }));
    const updated = r.ok ? asItem(r.item) : null;
    if (updated) applyItem(path, updated);
    else await get().refreshInfo();
    // Replaced, but a later step failed (reading it again, say): said even in Save all, as the photo was saved.
    if (!r.ok) get().toast('error', r.error ?? 'The photo was saved, but the gallery could not read it again.');
    return true;
  };

  /** A photo's info as it will be once the saves on their way land (undefined: not in the list). */
  const infoNow = (path: string): Record<string, unknown> | undefined => {
    const item = get().items.find((i) => i.path === path);
    return item ? { ...item.info, ...inFlight.get(path) } : undefined;
  };

  /**
   * Show the photo's score nudges as `n` at once and save them; the newest value is what the next nudge
   * counts from until the server has it. A save that fails reloads the folder's info (the toast says why).
   */
  const sendAdjust = (path: string, n: number) => {
    const p = pendingAdjust.get(path);
    pendingAdjust.set(path, { value: n, waiting: (p?.waiting ?? 0) + 1 });
    set((x) => ({ items: x.items.map((i) => (i.path === path ? { ...i, info: withAdjust(i.info, n) } : i)) }));
    void get()
      .saveInfo(path, { scoreAdjust: n === 0 ? null : n }, { undo: false })
      .then((ok) => {
        const q = pendingAdjust.get(path);
        if (q && --q.waiting <= 0) pendingAdjust.delete(path);
        if (!ok) void get().refreshInfo();
      });
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
    ...noEdits,
    editTarget: 'info',
    saving: false,
    savingPaths: [],
    settingsOpen: false,
    tagging: null,
    meaning: null,

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
      set((s) => ({ filter: withoutRelDir(s.filter), job: null, root: folder, items: [], openStacks: [], ...noSelection, ...noEdits, progress: { total: 0, processed: 0, startedAt: Date.now() } }));
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
      void watchTagging(gen, job);
      await pollJob(gen, job);
    },

    async saveInfo(path, patch, opts) {
      const job = get().job;
      const gen = generation;
      // What Ctrl+Z puts back: the fields as they are now, counting saves still on their way (nothing when
      // the save changes nothing). Recorded at once, so a Ctrl+Z pressed before the reply takes this back.
      const now = infoNow(path);
      const before = opts?.undo === false || !now ? null : fieldsBefore(now, patch);
      const changes = !!before && Object.keys(patch).some((k) => !sameValue(before[k], patch[k]));
      const step: UndoStep | null = changes && before && job ? { label: typeof opts?.undo === 'string' ? opts.undo : undoLabel(patch), info: [{ path, before }] } : null;
      if (step) set((s) => ({ undoStack: pushUndo(s.undoStack, step) }));
      inFlight.set(path, { ...inFlight.get(path), ...patch });
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
          if (!opts?.quiet) get().toast('error', message(e));
          return false;
        }
      };
      const run = q.tail.then(send);
      q.tail = run;
      const ok = await run;
      // Not saved: nothing to undo.
      if (!ok && step) set((s) => ({ undoStack: s.undoStack.filter((x) => x !== step) }));
      if (--q.waiting > 0) return ok;
      if (saveQueues.get(path) === q) saveQueues.delete(path);
      inFlight.delete(path);
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

    // Another photo selected while one is being edited (a click on a tile or a marker, the photo menu, the
    // photo deleted or filtered out) ends edit mode as Done does: what was done is kept as an unsaved edit,
    // and the preview moves on to the new photo.
    select(path) {
      set((s) => ({ selected: path, selection: path === null ? [] : [path], anchor: path, ...(s.editing === path ? {} : withEditUndo(s, endEditAsDone(s))) }));
    },

    clickSelect(path, mods) {
      const s = get();
      const next = clickSelect(selectVisible(s).map((i) => i.path), s, path, mods);
      set({ ...next, ...(next.selected === s.editing ? {} : withEditUndo(s, endEditAsDone(s))) });
    },

    openViewer(path) {
      // Not over edit mode (a double-click on the tile being edited): Done or Cancel comes first.
      if (get().editing !== null) return;
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
      const text = get().filter.text ?? '';
      set((s) => {
        const filter: GalleryFilter = { ...s.filter, ...patch };
        for (const k of Object.keys(filter) as (keyof GalleryFilter)[]) if (filter[k] === undefined) delete filter[k];
        return { filter };
      });
      if (text !== (get().filter.text ?? '')) searchByMeaning();
      settleSelection(before);
    },

    clearFilter() {
      const before = snapshot();
      set({ filter: {} });
      searchByMeaning();
      settleSelection(before);
    },

    toggleTagFilter(f) {
      const tags = get().filter.tags ?? [];
      const has = tags.some((t) => t.kind === f.kind && t.value === f.value);
      const next = has ? tags.filter((t) => !(t.kind === f.kind && t.value === f.value)) : [...tags, f];
      get().setFilter({ tags: next.length ? next : undefined });
    },

    async setTaggingPaused(paused) {
      try {
        const { settings } = await galleryApi.models();
        await galleryApi.setTaggingSettings({ ...settings, paused });
        const t = get().tagging;
        if (t) set({ tagging: { ...t, paused, running: t.running && !paused } });
      } catch (e) {
        get().toast('error', message(e));
      }
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
      const targets = flagTargets(s.selection, s.selected, (p) => infoNow(p)?.[field] === true);
      if (!targets) return;
      const before = snapshot();
      const patch = { [field]: field === 'star' ? targets.value : targets.value ? true : null };
      // One undo step for every photo changed (each as it was), recorded at once (see saveInfo).
      const was = targets.paths.map((p) => ({ path: p, before: fieldsBefore(infoNow(p) ?? {}, patch) })).filter((w) => !sameValue(w.before[field], patch[field]));
      const step: UndoStep = { label: field === 'star' ? 'favourite' : 'hide', info: was };
      if (was.length) set((x) => ({ undoStack: pushUndo(x.undoStack, step) }));
      const oks = await Promise.all(targets.paths.map((p) => get().saveInfo(p, patch, { undo: false })));
      // A photo whose save failed is left out of the step (the whole step, when none was saved).
      const failed = new Set(targets.paths.filter((_, n) => !oks[n]));
      if (failed.size && was.length) {
        const info = was.filter((w) => !failed.has(w.path));
        set((x) => ({ undoStack: x.undoStack.flatMap((st) => (st !== step ? [st] : info.length ? [{ ...st, info }] : [])) }));
      }
      settleSelection(before);
    },

    removeItems(paths) {
      const before = snapshot();
      const gone = new Set(paths);
      // A deleted photo's unsaved edit goes with it.
      set((s) => ({
        items: s.items.filter((i) => !gone.has(i.path)),
        pendingEdits: paths.some((p) => p in s.pendingEdits) ? Object.fromEntries(Object.entries(s.pendingEdits).filter(([p]) => !gone.has(p))) : s.pendingEdits,
      }));
      settleSelection(before);
    },

    close() {
      cancelScan();
      // Tagging this folder stops too. A failed call is harmless: the next folder opened replaces it.
      const { job } = get();
      if (job) void galleryApi.closeTagging(job).catch(() => {});
      stopTimers();
      set({ job: null, root: null, items: [], openStacks: [], progress: null, ...noSelection, ...noEdits, tidyOpen: false, tagging: null, meaning: null });
    },

    async requestOpen(folder, recursive) {
      set((s) => endEditAsDone(s));
      if (Object.keys(get().pendingEdits).length) {
        set({ leaving: { folder, recursive } });
        return;
      }
      await get().open(folder, recursive);
    },

    requestClose() {
      set((s) => endEditAsDone(s));
      if (Object.keys(get().pendingEdits).length) set({ leaving: 'close' });
      else get().close();
    },

    async confirmLeave() {
      const leaving = get().leaving;
      set({ leaving: null });
      if (leaving === 'close') get().close();
      else if (leaving) await get().open(leaving.folder, leaving.recursive);
    },

    cancelLeave() {
      set({ leaving: null });
    },

    setTidyOpen(tidyOpen) {
      set({ tidyOpen });
    },

    setSettingsOpen(settingsOpen) {
      set({ settingsOpen });
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

    startEdit(path) {
      // Not while its save is on its way: an edit made now would be lost when the save lands.
      if (get().savingPaths.includes(path)) return;
      // Editing another photo: that one is Done first.
      set((s) => (s.editing === path ? {} : { ...withEditUndo(s, endEditAsDone(s)), editing: path }));
    },

    finishEdit(edit) {
      const s = get();
      const path = s.editing;
      if (path === null) return;
      draft = null;
      set(withEditUndo(s, { editing: null, editDirty: false, pendingEdits: afterDone(s, path, edit) }));
    },

    cancelEdit() {
      draft = null;
      set({ editing: null, editDirty: false });
    },

    discardEdit(path) {
      if (path in get().pendingEdits) set((s) => ({ pendingEdits: without(s.pendingEdits, path) }));
    },

    setEditDraft(edit) {
      const s = get();
      const path = s.editing;
      if (path === null) return;
      draft = { path, edit };
      // Changed from where it started (the unsaved edit, else the saved one)?
      const item = s.items.find((i) => i.path === path);
      const editDirty = !!item && !sameEdit(edit, shownEdit(s, item));
      if (editDirty !== s.editDirty) set({ editDirty });
    },

    async loadEditTarget() {
      const target = await loadEditTarget(host);
      set({ editTarget: canSaveToFile() ? target : 'info' });
    },

    async setEditTarget(target) {
      const editTarget = target === 'file' && canSaveToFile() ? 'file' : 'info';
      set({ editTarget });
      try {
        await saveEditTarget(host, editTarget);
      } catch (e) {
        get().toast('error', `Couldn't keep the setting: ${message(e)}`);
      }
    },

    saveEdit(path) {
      return busy(() => saveOne(path, false));
    },

    async saveEditAs(path) {
      const saveAs = host?.saveEditAs;
      if (!saveAs) {
        get().toast('error', 'Save as needs the desktop app');
        return false;
      }
      const s = get();
      const item = s.items.find((i) => i.path === path);
      const edit = item ? shownEdit(s, item) : null;
      if (!item || !edit) {
        get().toast('error', `${nameOf(path)} has no edit to save as a copy`);
        return false;
      }
      const gen = generation;
      return busy(async () => {
        let r: Awaited<ReturnType<typeof saveAs>>;
        try {
          r = await saveAs(path, edit, item.info);
        } catch (e) {
          get().toast('error', `Couldn't save the copy: ${message(e)}`);
          return false;
        }
        if (r.cancelled) return false;
        // A copy inside the open folder joins the grid (the original, and its unsaved edit, stay as they are).
        const copy = asItem(r.item);
        if (copy && gen === generation) set((x) => ({ items: x.items.some((i) => i.path === copy.path) ? x.items.map((i) => (i.path === copy.path ? copy : i)) : [...x.items, copy] }));
        if (r.ok) {
          get().toast('success', `Saved a copy as ${baseName(r.savedPath ?? copy?.path ?? '')}`);
          return true;
        }
        // Written, but a later step failed (its info, reading it): show the folder as it is now.
        if (r.saved && gen === generation) await get().refreshInfo();
        get().toast('error', r.error ?? "Couldn't save the copy.");
        return false;
      });
    },

    async saveAllEdits() {
      const s = get();
      const paths = Object.keys(s.pendingEdits);
      if (!paths.length) return;
      const gen = generation;
      const skipped = s.editTarget === 'file' ? paths.filter(isHeic) : [];
      // A photo whose save is on its way already is left to that save.
      const todo = paths.filter((p) => !skipped.includes(p) && !s.savingPaths.includes(p));
      // Names are read now: a folder changed meanwhile takes its list with it.
      const names = new Map(paths.map((p) => [p, nameOf(p)]));
      const named = (ps: string[]) => someNames(ps.map((p) => names.get(p) ?? p));
      if (!todo.length && !skipped.length) return;
      let ok = 0;
      const failed: string[] = [];
      await busy(async () => {
        for (const path of todo) {
          // Another folder opened: what was saved so far is still said.
          if (gen !== generation) return;
          if (await saveOne(path, true)) ok++;
          else failed.push(path);
        }
      });
      let text = failed.length ? `Saved ${ok}, ${failed.length} failed: ${named(failed)}` : `Saved ${plural(ok, 'photo')}`;
      if (skipped.length) text += `. Skipped ${named(skipped)}: ${HEIC_SAVE_NOTE}`;
      get().toast(failed.length ? 'error' : skipped.length ? 'info' : 'success', text);
    },

    revertEdit(path) {
      return busy(() => get().saveInfo(path, { edit: null }, { undo: 'revert to original' }));
    },

    nudgeScore(delta) {
      const s = get();
      if (!s.job) return;
      const byPath = new Map(s.items.map((i) => [i.path, i]));
      const paths = (s.selection.length > 1 ? s.selection : s.selected !== null ? [s.selected] : []).filter((p) => byPath.has(p));
      if (!paths.length) return;
      const changes = paths.map((path) => {
        const was = pendingAdjust.get(path)?.value ?? scoreAdjustOf(byPath.get(path)!.info);
        return { path, was, now: was + delta };
      });
      const id = ++scoreToastId;
      const shown = s.selected !== null && paths.includes(s.selected) ? s.selected : paths[0];
      set((x) => ({
        undoStack: pushUndo(x.undoStack, { label: 'score', info: changes.map((c) => ({ path: c.path, before: { scoreAdjust: c.was || null } })) }),
        scoreToast: { id, delta, path: shown, count: paths.length },
      }));
      for (const c of changes) sendAdjust(c.path, c.now);
      setTimeout(() => {
        if (get().scoreToast?.id === id) set({ scoreToast: null });
      }, SCORE_TOAST_MS);
    },

    async undo() {
      const s = get();
      if (s.editing !== null) return;
      const step = s.undoStack.at(-1);
      if (!step) {
        get().toast('info', 'Nothing to undo');
        return;
      }
      set({ undoStack: s.undoStack.slice(0, -1) });
      const present = new Set(s.items.map((i) => i.path));
      if (![...step.info.map((c) => c.path), ...(step.edits ?? []).map((e) => e.path)].some((p) => present.has(p))) {
        get().toast('info', `Couldn't undo ${step.label}: the photo is no longer in the folder`);
        return;
      }
      if (step.edits?.length) {
        set((x) => {
          const pendingEdits = { ...x.pendingEdits };
          for (const e of step.edits!) {
            if (!present.has(e.path)) continue;
            if (e.before) pendingEdits[e.path] = e.before;
            else delete pendingEdits[e.path];
          }
          return { pendingEdits };
        });
      }
      const before = snapshot();
      const oks = await Promise.all(
        step.info
          .filter((c) => present.has(c.path))
          .map(({ path, before: fields }) => {
            const { scoreAdjust, ...rest } = fields;
            // Nudges go the way Up and Down send them (shown at once); any other field is saved as it was.
            if ('scoreAdjust' in fields) sendAdjust(path, typeof scoreAdjust === 'number' ? scoreAdjust : 0);
            return Object.keys(rest).length ? get().saveInfo(path, rest, { undo: false }) : Promise.resolve(true);
          }),
      );
      // A photo brought back (unhidden) is shown again where it was; one photo undone is selected.
      settleSelection(before);
      const paths = [...step.info.map((c) => c.path), ...(step.edits ?? []).map((e) => e.path)].filter((p) => present.has(p));
      if (new Set(paths).size === 1 && selectablePaths(get()).includes(paths[0]) && get().selected !== paths[0]) get().select(paths[0]);
      const ok = oks.every(Boolean);
      get().toast(ok ? 'info' : 'error', ok ? `Undid: ${step.label}` : `Couldn't undo all of: ${step.label}`);
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
const needsFacts = (sort: GallerySortKey, f: GalleryFilter, stacked?: boolean) => !!stacked || sort === 'interesting' || sort === 'colour' || sort === 'score' || !!f.lowQuality || !!f.nearDuplicates;
const NO_FACTS = new Map<string, GalleryFacts>();
const NO_STACKS = new Map<string, StackInfo>();
let factsMemo: { items: GalleryItem[]; facts: Map<string, GalleryFacts>; at: number } | null = null;
let visibleMemo: {
  items: GalleryItem[]; sort: GallerySortKey; filter: GalleryFilter; stacked: boolean; openStacks: string[] | undefined; meaning: GalleryState['meaning'] | undefined;
  filtered: GalleryItem[]; visible: GalleryItem[]; stackOf: Map<string, StackInfo>; facts: Map<string, GalleryFacts>; stale: boolean;
  /** Index in `visible` where the matches by meaning begin (null: none shown). */
  meaningStart: number | null;
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

type VisibleInput = Pick<GalleryState, 'items' | 'sort' | 'filter'> & { progress?: GalleryState['progress']; stacked?: boolean; openStacks?: string[]; meaning?: GalleryState['meaning'] };

/** The folder's facts (bursts, quality), worked out again only when what they read changed; mid-scan at most every FACTS_SCAN_THROTTLE_MS. */
function currentFacts(s: Pick<VisibleInput, 'items' | 'progress'>): Map<string, GalleryFacts> {
  const now = Date.now();
  // Mid-scan the list grows every half second: keep the last facts (new photos have none yet) for a while.
  if (factsMemo && factsMemo.items !== s.items && sameFactsInput(factsMemo.items, s.items)) factsMemo = { ...factsMemo, items: s.items };
  const fresh = factsMemo?.items === s.items || (!!s.progress && !!factsMemo && now >= factsMemo.at && now - factsMemo.at < FACTS_SCAN_THROTTLE_MS);
  if (!fresh) factsMemo = { items: s.items, facts: galleryFacts(s.items), at: now };
  return factsMemo!.facts;
}

let scoresMemo: { items: GalleryItem[]; facts: Map<string, GalleryFacts>; scores: Map<string, PhotoScore> } | null = null;

/**
 * Every photo's score, by path (photoScores over the whole folder, not just what is shown). Worked out again
 * when a photo changes (a star, a hide, a nudge): cheap next to the facts, which are kept when they can be.
 */
export function selectScores(s: Pick<VisibleInput, 'items' | 'progress'>): Map<string, PhotoScore> {
  const facts = currentFacts(s);
  if (scoresMemo && scoresMemo.items === s.items && scoresMemo.facts === facts) return scoresMemo.scores;
  scoresMemo = { items: s.items, facts, scores: photoScores(s.items, facts) };
  return scoresMemo.scores;
}

export function selectVisible(s: VisibleInput): GalleryItem[] {
  const stacked = !!s.stacked;
  const m = visibleMemo;
  if (m && m.items === s.items && m.sort === s.sort && m.filter === s.filter && m.stacked === stacked && m.openStacks === s.openStacks && m.meaning === s.meaning && !(m.stale && !s.progress)) return m.visible;
  const withFacts = needsFacts(s.sort, s.filter, stacked);
  const facts = withFacts ? currentFacts(s) : NO_FACTS;
  const sorted = sortItems(filterItems(s.items, s.filter, facts), s.sort, facts, s.sort === 'score' ? selectScores(s) : undefined);
  const folded = stacked ? stackItems(sorted, facts, new Set(s.openStacks ?? [])) : null;
  // Then the photos found by meaning for this search text that the words did not find (passing the other filters), unstacked.
  const extra = meaningExtra(s, sorted, facts);
  const words = folded ? folded.items : sorted;
  const visible = extra.length ? [...words, ...extra] : words;
  const filtered = extra.length ? [...sorted, ...extra] : sorted;
  // Built from stale facts: remembered (the selector must return the same list for the same state), but redone once the scan ends.
  const stale = withFacts && factsMemo?.items !== s.items;
  visibleMemo = {
    items: s.items, sort: s.sort, filter: s.filter, stacked, openStacks: s.openStacks, meaning: s.meaning,
    filtered, visible, stackOf: folded ? folded.stackOf : NO_STACKS, facts, stale, meaningStart: extra.length ? words.length : null,
  };
  return visible;
}

/** The photos found by meaning for the current search text, not among the word matches, that pass the other filters. */
function meaningExtra(s: VisibleInput, words: GalleryItem[], facts: Map<string, GalleryFacts>): GalleryItem[] {
  const q = s.filter.text?.trim();
  if (!s.meaning || !q || s.meaning.q !== q || !s.meaning.paths.length) return [];
  const have = new Set(words.map((i) => i.path));
  const byPath = new Map(s.items.map((i) => [i.path, i]));
  const found = s.meaning.paths.filter((p) => !have.has(p)).map((p) => byPath.get(p)).filter((i): i is GalleryItem => !!i);
  return filterItems(found, { ...s.filter, text: undefined }, facts);
}

/** Where the matches by meaning begin in the visible list (null: none shown), for the grid's note row. */
export function selectMeaningStart(s: VisibleInput): number | null {
  selectVisible(s);
  return visibleMemo!.meaningStart;
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

/**
 * Tell photo tagging which photos to look at first: the selected one, then the first 200 the grid shows.
 * Sent 0.5 s after the selection or the grid's list last changed, and only when that order changed.
 */
useGallery.subscribe((s, prev) => {
  if (!s.job) return;
  if (s.job === prev.job && s.selected === prev.selected && s.items === prev.items && s.filter === prev.filter && s.sort === prev.sort && s.stacked === prev.stacked && s.openStacks === prev.openStacks) return;
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    focusTimer = null;
    const now = useGallery.getState();
    if (!now.job) return;
    const shown = selectVisible(now).slice(0, FOCUS_COUNT).map((i) => i.path);
    const paths = now.selected === null ? shown : [now.selected, ...shown.filter((p) => p !== now.selected)];
    const key = [now.job, ...paths].join('\n');
    if (!paths.length || key === lastFocus) return;
    lastFocus = key;
    galleryApi.taggingFocus(now.job, paths).catch(() => {
      // Only an order of work: nothing to tell the person.
    });
  }, FOCUS_DEBOUNCE_MS);
});

/** The photos to show, in order: the grid and the viewer step through this one list. */
export const useVisibleItems = (): GalleryItem[] => useGallery((s) => selectVisible(s));

export const useStackInfo = (): Map<string, StackInfo> => useGallery((s) => selectStackInfo(s));

export const useFilteredItems = (): GalleryItem[] => useGallery((s) => selectFiltered(s));

/**
 * Open each folder the desktop app hands the page (`--gallery <folder>`, a second launch, File >
 * Open folder), with the current "Include subfolders" choice, and show a drag that could not start
 * as an error. Returns a function that stops listening.
 */
export function connectDesktop(d: Partial<DesktopApi> | undefined): () => void {
  host = d;
  // A folder from outside asks first, as Open folder does, while there are unsaved edits.
  const stopFolders = d?.onOpenFolder?.((folder) => void useGallery.getState().requestOpen(folder, useGallery.getState().recursive));
  const stopDrags = d?.onDragFailed?.((message) => useGallery.getState().toast('error', message));
  // The desktop app asks before the window closes while this count is above 0.
  const report = () => d?.setUnsavedEdits?.(unsavedCount(useGallery.getState()));
  report();
  const stopCount = d?.setUnsavedEdits ? useGallery.subscribe((s, prev) => void (unsavedCount(s) !== unsavedCount(prev) && report())) : undefined;
  const win = typeof window === 'undefined' ? undefined : window;
  win?.addEventListener('beforeunload', guardUnload);
  return () => {
    stopFolders?.();
    stopDrags?.();
    stopCount?.();
    win?.removeEventListener('beforeunload', guardUnload);
    if (host === d) host = undefined;
  };
}

/**
 * The page's `beforeunload`: held back while there are unsaved edits. A browser then asks; the desktop
 * app (which sees the page held back) asks "Close without saving?" in its own dialog.
 */
export function guardUnload(e: { preventDefault(): void; returnValue?: unknown }) {
  if (unsavedCount(useGallery.getState()) === 0) return;
  e.preventDefault();
  // Some browsers ask only when this is set.
  e.returnValue = '';
}
