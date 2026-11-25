// Running from source: each program keeps its data in its own folder under the project's ./data,
//   ./data/photobook-editor   the editor's books, exports and database
//   ./data/photo-tool         Photo Tool's catalogue
//   ./data/photoinfo-shared   stars and notes for read-only photo folders, shared by both
// and the old one-folder layout (the editor's files at the top of ./data, ./data/gallery for Photo
// Tool, ./data/photoinfo for the shared info) is carried over once. Folders are only ever renamed
// within ./data: nothing is copied, merged or deleted. Unit-tested in shared/tests/dev-data.test.ts.
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CarryOverError, type CarryOverStep } from '../electron/dataFolders';

export function devDataLayout(root: string): { editor: string; photoTool: string; photoinfo: string } {
  const data = join(root, 'data');
  return { editor: join(data, 'photobook-editor'), photoTool: join(data, 'photo-tool'), photoinfo: join(data, 'photoinfo-shared') };
}

/** The editor's entries are gathered here, and the folder renamed to photobook-editor only once all are in. */
const EDITOR_STAGING = 'photobook-editor.moving';

/** Names at the top of ./data that belong to the new layout, and are never swept into the editor's folder. */
const NEW_NAMES = new Set(['photobook-editor', 'photo-tool', 'photoinfo-shared', 'photobook-editor-browser', 'photo-tool-browser', EDITOR_STAGING]);

/** The variables that choose the data folders by hand. Any one set: no carry-over (see Ruling B). */
const DATA_ENV = ['PHOTOBOOK_DATA_DIR', 'PHOTOBOOK_PROFILE_DIR', 'PHOTO_TOOL_DATA_DIR', 'PHOTO_TOOL_PROFILE_DIR', 'PHOTOINFO_FALLBACK_DIR'];

/** True when any data or profile folder was chosen by hand: the dev carry-over then does nothing. */
export function devCarryOverSkipped(env: Record<string, string | undefined>): boolean {
  return DATA_ENV.some((v) => !!env[v]);
}

type Rename = (a: string, b: string) => void;

/**
 * Move the old one-folder ./data layout to the per-program one:
 *   ./data/gallery   → ./data/photo-tool
 *   ./data/photoinfo → ./data/photoinfo-shared
 *   every other entry at the top of ./data (not the new layout's names, not dotfiles)
 *                    → ./data/photobook-editor/<entry>
 * Done once: when ./data/photobook-editor exists, nothing happens. The editor's entries go into a
 * staging folder first, renamed to photobook-editor last, so a move that stops half-way (a rename
 * fails: CarryOverError naming the entry) leaves photobook-editor missing and the next call finishes
 * the rest. A target that exists already is never merged into: that throws too.
 */
export function carryOverDevData(root: string, rename: Rename = renameSync): { moved: string[] } {
  const data = join(root, 'data');
  const layout = devDataLayout(root);
  if (existsSync(layout.editor) || !existsSync(data)) return { moved: [] };
  const moved: string[] = [];
  const move = (from: string, to: string, step: CarryOverStep) => {
    if (existsSync(to)) throw new CarryOverError(from, to, new Error(`${to} is there already; nothing was merged`), step);
    try {
      rename(from, to);
    } catch (e) {
      throw new CarryOverError(from, to, e, step);
    }
  };

  for (const [name, to, step] of [['gallery', layout.photoTool, 'data'], ['photoinfo', layout.photoinfo, 'photoinfo']] as const) {
    if (!existsSync(join(data, name))) continue;
    move(join(data, name), to, step);
    moved.push(name);
  }

  const staging = join(data, EDITOR_STAGING);
  const editorEntries = readdirSync(data).filter((n) => !NEW_NAMES.has(n) && !n.startsWith('.') && n !== 'gallery' && n !== 'photoinfo').sort();
  if (editorEntries.length) mkdirSync(staging, { recursive: true });
  for (const name of editorEntries) {
    move(join(data, name), join(staging, name), 'data');
    moved.push(name);
  }
  if (existsSync(staging)) move(staging, layout.editor, 'data');
  return { moved };
}

/**
 * What a dev server or scripts/carry-over-dev-data.ts does before it opens ./data: carry the old
 * layout over and say what moved. A move that fails is reported and the process quits, rather than
 * starting on an empty folder; what moved stays moved, and the next start finishes the rest.
 */
export function carryOverDevDataOrQuit(root: string): { moved: string[] } {
  try {
    const result = carryOverDevData(root);
    if (result.moved.length) console.log(`Split ${join(root, 'data')} per program; moved: ${result.moved.join(', ')}`);
    return result;
  } catch (e) {
    if (!(e instanceof CarryOverError)) throw e;
    console.error(`${e.message}\n\nThe old ./data layout could not be split per program, so nothing was started. Nothing was deleted: close anything using ${e.from} and start again, and the move picks up where it stopped.`);
    process.exit(1);
  }
}
