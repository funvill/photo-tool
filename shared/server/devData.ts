// Running from source: each program keeps its data in its own folder under the project's ./data,
//   ./data/photobook-editor   the editor's books, exports and database
//   ./data/photo-tool         Photo Tool's catalogue
//   ./data/photoinfo-shared   stars and notes for read-only photo folders, shared by both
// and the old one-folder layout (the editor's files at the top of ./data, ./data/gallery for Photo
// Tool, ./data/photoinfo for the shared info) is carried over once. Folders are only ever renamed
// within ./data: nothing is copied, merged or deleted. Old data that cannot be moved because its new
// folder exists already is never left silently: it is named, with what to do. Unit-tested in
// shared/tests/dev-data.test.ts.
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CarryOverError, type CarryOverStep } from '../electron/dataFolders';

export function devDataLayout(root: string): { editor: string; photoTool: string; photoinfo: string } {
  const data = join(root, 'data');
  return { editor: join(data, 'photobook-editor'), photoTool: join(data, 'photo-tool'), photoinfo: join(data, 'photoinfo-shared') };
}

/** The three parts of the carry-over: the editor's entries, Photo Tool's gallery, the shared photo info. */
export type DevDataPart = 'editor' | 'photoTool' | 'photoinfo';
export const DEV_DATA_PARTS: readonly DevDataPart[] = ['editor', 'photoTool', 'photoinfo'];

/** The variables that choose each part's folder by hand. Any one set: that part is not carried over (Ruling B). */
const PART_ENV: Record<DevDataPart, string[]> = {
  editor: ['PHOTOBOOK_DATA_DIR', 'PHOTOBOOK_PROFILE_DIR'],
  photoTool: ['PHOTO_TOOL_DATA_DIR', 'PHOTO_TOOL_PROFILE_DIR'],
  photoinfo: ['PHOTOINFO_FALLBACK_DIR'],
};

/** Of `parts`, those whose folders were not chosen by hand in `env`, in order. */
export function devCarryOverParts(env: Record<string, string | undefined>, parts: readonly DevDataPart[] = DEV_DATA_PARTS): DevDataPart[] {
  return DEV_DATA_PARTS.filter((p) => parts.includes(p) && !PART_ENV[p].some((v) => !!env[v]));
}

/** The editor's entries are gathered here, and the folder renamed to photobook-editor only once all are in. */
const EDITOR_STAGING = 'photobook-editor.moving';

/** Names at the top of ./data that belong to the new layout (or another part), never swept into the editor's folder. */
const NOT_EDITOR = new Set(['photobook-editor', 'photo-tool', 'photoinfo-shared', 'photobook-editor-browser', 'photo-tool-browser', EDITOR_STAGING, 'gallery', 'photoinfo']);

type Rename = (a: string, b: string) => void;

/**
 * Move the old one-folder ./data layout to the per-program one, for the `parts` asked for:
 *   photoTool: ./data/gallery   → ./data/photo-tool
 *   photoinfo: ./data/photoinfo → ./data/photoinfo-shared
 *   editor:    every other entry at the top of ./data (not the new layout's names, not dotfiles)
 *                               → ./data/photobook-editor/<entry>
 * Each part runs once: when its new folder exists, nothing of it is moved, and whatever old data of
 * it is still there is returned in `leftovers` (never merged in). The editor's entries go into a
 * staging folder first, renamed to photobook-editor last, so a move that stops half-way (a rename
 * fails: CarryOverError naming the entry) leaves photobook-editor missing and the next call finishes
 * the rest. A rename never replaces anything: a target that exists throws.
 */
export function carryOverDevData(root: string, rename: Rename = renameSync, parts: readonly DevDataPart[] = DEV_DATA_PARTS): { moved: string[]; leftovers: string[] } {
  const data = join(root, 'data');
  const layout = devDataLayout(root);
  const moved: string[] = [];
  const leftovers: string[] = [];
  if (!parts.length || !existsSync(data)) return { moved, leftovers };
  const move = (from: string, to: string, step: CarryOverStep) => {
    // Checked just before: a rename never replaces what is there (advisory, as nothing else writes these names).
    if (existsSync(to)) throw new CarryOverError(from, to, new Error(`${to} is there already; nothing was merged`), step);
    try {
      rename(from, to);
    } catch (e) {
      throw new CarryOverError(from, to, e, step);
    }
  };

  for (const [part, name, to, step] of [['photoTool', 'gallery', layout.photoTool, 'data'], ['photoinfo', 'photoinfo', layout.photoinfo, 'photoinfo']] as const) {
    const from = join(data, name);
    if (!parts.includes(part) || !existsSync(from)) continue;
    if (existsSync(to)) leftovers.push(from);
    else {
      move(from, to, step);
      moved.push(name);
    }
  }

  if (parts.includes('editor')) {
    const staging = join(data, EDITOR_STAGING);
    const entries = readdirSync(data).filter((n) => !NOT_EDITOR.has(n) && !n.startsWith('.')).sort();
    if (existsSync(layout.editor)) {
      leftovers.push(...(existsSync(staging) ? [staging] : []), ...entries.map((n) => join(data, n)));
    } else {
      if (entries.length) mkdirSync(staging, { recursive: true });
      for (const name of entries) {
        move(join(data, name), join(staging, name), 'data');
        moved.push(name);
      }
      if (existsSync(staging)) move(staging, layout.editor, 'data');
    }
  }
  return { moved, leftovers: leftovers.sort() };
}

/** Where a leftover belongs in the new layout. */
function newHomeOf(root: string, leftover: string): string {
  const layout = devDataLayout(root);
  const data = join(root, 'data');
  if (leftover === join(data, 'gallery')) return layout.photoTool;
  if (leftover === join(data, 'photoinfo')) return layout.photoinfo;
  return layout.editor;
}

/**
 * What a dev server or script does before it opens ./data: carry the old layout over (the `parts`
 * whose folders were not chosen by hand), say what moved, and warn about anything left in the old
 * layout. A move that fails is reported and the process quits, rather than starting on an empty
 * folder; what moved stays moved, and the next start finishes the rest.
 */
export function carryOverDevDataOrQuit(root: string, parts: readonly DevDataPart[] = DEV_DATA_PARTS): { moved: string[]; leftovers: string[] } {
  try {
    const result = carryOverDevData(root, undefined, parts);
    if (result.moved.length) console.log(`Split ${join(root, 'data')} per program; moved: ${result.moved.join(', ')}`);
    if (result.leftovers.length) {
      const lines = result.leftovers.map((l) => `  ${l}\n    belongs in ${newHomeOf(root, l)}`);
      console.warn(
        `Warning: old data is still at the top of ${join(root, 'data')}, and its new folder exists already, so it was not moved (nothing is ever merged automatically):\n${lines.join('\n')}\n` +
          `Stop the programs, then move what you need from each into its new folder by hand.`,
      );
    }
    return result;
  } catch (e) {
    if (!(e instanceof CarryOverError)) throw e;
    console.error(`${e.message}\n\nThe old ./data layout could not be split per program, so nothing was started. Nothing was deleted: close anything using ${e.from} and start again, and the move picks up where it stopped.`);
    process.exit(1);
  }
}
