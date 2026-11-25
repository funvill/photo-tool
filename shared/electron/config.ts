// Start-up decisions that need no Electron, the same for both desktop programs: command-line flags,
// where data lives, the window's remembered place, and how a failed start is put into words.
// Unit-tested in shared/tests/desktop-config.test.ts.
import { join, posix, resolve, win32 } from 'node:path';

// ---- the program

/** What tells the two programs apart here: their names, and the prefix of their environment variables. */
export interface ProgramNames {
  /** "Photobook Editor" or "Photo Tool": the window title, the data folder and the single-instance lock. */
  productName: string;
  /** Each program reads ${envPrefix}_DATA_DIR, _PROFILE_DIR, _PORT, _RESOURCE_ROOT and _DESKTOP_DEV_URL. */
  envPrefix: 'PHOTOBOOK' | 'PHOTO_TOOL';
  /** The name it had before, whose data folder is moved to the new name once (see dataFolders.ts). */
  oldProductName: string;
}

/** Photo Tool's wording (photos, maps) rather than the editor's (books): the program name says which. */
const isPhotoTool = (productName: string) => /^Photo Tool\b/.test(productName);

// ---- command line

export interface SelfTestArgs {
  /** Folder of photos to import (the editor) or to open (Photo Tool, which opens a copy of it). */
  photos: string;
  /** Where result.json, the screenshots, the browser profile and the test's own data folder go. */
  out: string;
}

/**
 * The self-test runs only when asked for by flag, with both folders given:
 *   --self-test <photo folder> --self-test-out <folder>
 */
export function parseSelfTest(argv: readonly string[]): SelfTestArgs | null {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && !v.startsWith('--') ? v : undefined;
  };
  const photos = value('--self-test');
  const out = value('--self-test-out');
  return photos && out ? { photos: resolve(photos), out: resolve(out) } : null;
}

/**
 * The folder given on the command line, or null: the first argument that is not a flag. The program
 * itself is argv[0] when packaged; run as `electron <app folder>` (defaultApp) the app folder is argv[1].
 * The self-test's flags and their folders are never it.
 */
export function launchFolder(argv: readonly string[], defaultApp: boolean): string | null {
  const args = argv.slice(defaultApp ? 2 : 1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--self-test' || a === '--self-test-out') {
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    return a;
  }
  return null;
}

/**
 * Why Photo Tool's self-test must not run with these folders, or null when it may. It deletes and
 * re-copies `<out>/photos`, so the photos given and the output folder must be apart: neither the same
 * folder nor one inside the other (letter case ignored on Windows), or the photos could be deleted, or
 * the copy made into itself.
 */
export function selfTestOverlap(photos: string, out: string, platform: NodeJS.Platform = process.platform): string | null {
  const p = platform === 'win32' ? win32 : posix;
  const norm = (dir: string) => {
    const full = p.resolve(dir);
    const trimmed = full.length > p.parse(full).root.length ? full.replace(/[\\/]+$/, '') : full;
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  const a = norm(photos);
  const b = norm(out);
  const inside = (child: string, parent: string) => child.startsWith(parent.endsWith(p.sep) ? parent : parent + p.sep);
  if (a === b) return `The photos folder and --self-test-out are the same folder (${photos}). Give an output folder outside the photos.`;
  if (inside(b, a)) return `--self-test-out (${out}) is inside the photos folder (${photos}). Give an output folder outside the photos.`;
  if (inside(a, b)) return `The photos folder (${photos}) is inside --self-test-out (${out}). Give an output folder that does not hold the photos.`;
  return null;
}

// ---- folders

/** A program's folder under appData: "<name>" when installed, "<name> Dev" run from source. */
export const programFolder = (appData: string, name: string, packaged: boolean) => join(appData, packaged ? name : `${name} Dev`);

export interface DataLayout {
  /** The program's own folder under appData (what moves when it is renamed). */
  root: string;
  /** The app's books, thumbnails, exports and logs. */
  dataDir: string;
  /** Chromium's own files (cache, cookies, window state). Never inside dataDir. */
  profileDir: string;
}

/**
 * Per-user folders:
 *   <appData>/<name>/data      the app's data (${envPrefix}_DATA_DIR overrides it)
 *   <appData>/<name>/browser   Chromium's profile (${envPrefix}_PROFILE_DIR overrides it)
 * A copy run from source uses "<name> Dev", so development never touches an installed app's data.
 * A self-test keeps both inside its output folder (<out>/data and <out>/profile) unless they are
 * given explicitly: it must never write into a real user's data, and can run beside the installed app.
 * Only one of the two given (outside a self-test): the other goes beside it, as <given>-browser or
 * <given>-data, never under <appData>/<name>. A folder made there would count as the carry-over
 * having happened (dataFolders.ts), and the old name's data would never move.
 */
export function dataLayout(o: { appData: string; productName: string; packaged: boolean; env: Record<string, string | undefined>; envPrefix: string; selfTestOut?: string }): DataLayout {
  const root = programFolder(o.appData, o.productName, o.packaged);
  const given = (v: string | undefined) => (v ? resolve(v) : null);
  const data = given(o.env[`${o.envPrefix}_DATA_DIR`]);
  const profile = given(o.env[`${o.envPrefix}_PROFILE_DIR`]);
  return {
    root,
    dataDir: data ?? (o.selfTestOut ? join(o.selfTestOut, 'data') : profile ? `${profile}-data` : join(root, 'data')),
    profileDir: profile ?? (o.selfTestOut ? join(o.selfTestOut, 'profile') : data ? `${data}-browser` : join(root, 'browser')),
  };
}

/** The folder both programs share, beside their own: "Photo Tools Shared" (with " Dev" from source). */
export const SHARED_FOLDER_NAME = 'Photo Tools Shared';

/**
 * Where both programs keep photo info for folders they cannot write to, so a star set in one shows in
 * the other: <appData>/Photo Tools Shared[ Dev]/photoinfo. PHOTOINFO_FALLBACK_DIR moves it; a self-test
 * keeps it in its output folder (<out>/photoinfo-shared), away from a real user's.
 */
export function photoInfoFallbackDir(o: { appData: string; packaged: boolean; env: Record<string, string | undefined>; selfTestOut?: string }): string {
  if (o.env.PHOTOINFO_FALLBACK_DIR) return resolve(o.env.PHOTOINFO_FALLBACK_DIR);
  if (o.selfTestOut) return join(o.selfTestOut, 'photoinfo-shared');
  return join(programFolder(o.appData, SHARED_FOLDER_NAME, o.packaged), 'photoinfo');
}

/**
 * The photo-tagging worker beside the server bundle in `bundleDir`. In the installed app that is inside app.asar,
 * and the worker thread runs from its unpacked copy (see asarUnpack in electron-builder.config.cjs).
 */
export function taggingWorkerPath(bundleDir: string): string {
  const sep = bundleDir.includes('\\') ? '\\' : '/';
  return `${bundleDir.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')}${sep}tagging-worker.cjs`;
}

// ---- window place

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WindowState {
  bounds?: Bounds;
  maximized?: boolean;
}

export const DEFAULT_WINDOW = { width: 1440, height: 900 };
export const MIN_WINDOW = { width: 960, height: 600 };

/**
 * Where to open the window: the remembered place when it still lands on a screen (a monitor may
 * have been unplugged), otherwise the default size, centred by the system (no x/y).
 */
export function restoreWindow(saved: unknown, displays: readonly Bounds[]): { bounds: Partial<Bounds> & { width: number; height: number }; maximized: boolean } {
  const fallback = { bounds: { ...DEFAULT_WINDOW }, maximized: false };
  if (!saved || typeof saved !== 'object') return fallback;
  const s = saved as WindowState;
  const b = s.bounds;
  const maximized = s.maximized === true;
  if (!b || ![b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))) return { ...fallback, maximized };
  const width = Math.max(MIN_WINDOW.width, Math.round(b.width));
  const height = Math.max(MIN_WINDOW.height, Math.round(b.height));
  // Enough of the title bar must be on some screen to grab it.
  const visible = displays.some((d) => b.x + width > d.x + 100 && b.x < d.x + d.width - 100 && b.y >= d.y - 10 && b.y < d.y + d.height - 50);
  return visible ? { bounds: { x: Math.round(b.x), y: Math.round(b.y), width, height }, maximized } : { bounds: { width, height }, maximized };
}

// ---- failures, in plain words

export interface Failure {
  title: string;
  /** One or two sentences for someone who is not technical. */
  message: string;
  /** What to try. */
  advice: string;
}

/**
 * Put a start-up or run-time failure into words. `detail` is the technical text (kept for copying).
 * Photo Tool (by its name) has no books to save.
 */
export function describeFailure(detail: string, ctx: { productName: string; dataDir: string; phase: 'start' | 'run' | 'page' }): Failure {
  const name = ctx.productName;
  const photoTool = isPhotoTool(name);
  if (ctx.phase === 'run') {
    return {
      title: `${name} stopped working`,
      message: photoTool
        ? `The part of ${name} that reads your photos stopped unexpectedly. Stars and notes up to your last change are saved.`
        : `The part of ${name} that saves your book stopped unexpectedly. Changes up to your last edit are saved.`,
      advice: `Restart ${name}. If this keeps happening, send the details below to the person who gave you the app.`,
    };
  }
  if (ctx.phase === 'page') {
    return {
      title: `${name} could not show the ${photoTool ? 'gallery' : 'editor'}`,
      message: `${name} started, but its window could not load.`,
      advice: `Restart ${name}. If this keeps happening, reinstall it.`,
    };
  }
  const title = `${name} could not start`;
  if (/App files are missing|MODULE_NOT_FOUND|Cannot find module/i.test(detail)) {
    return { title, message: `Some of ${name}'s own files are missing or damaged.`, advice: `Reinstall ${name}.` };
  }
  if (/EACCES|EPERM|EROFS|ENOSPC|ENOTDIR|ENOENT|read-?only|unable to open database|SQLITE_(CANTOPEN|READONLY|FULL|IOERR)/i.test(detail)) {
    return {
      title,
      message: `${name} could not save to its data folder:\n${ctx.dataDir}`,
      advice: 'Check that the disk is not full and that you are allowed to save files in that folder, then start the app again.',
    };
  }
  if (/SQLITE_BUSY|database is locked/i.test(detail)) {
    return { title, message: `Another program is using ${name}'s library.`, advice: `Close other copies of ${name}, then start it again.` };
  }
  if (/sharp|ERR_DLOPEN_FAILED|\.node\b|libvips/i.test(detail)) {
    return { title, message: `A part of ${name} that reads photos could not be loaded.`, advice: `Reinstall ${name}. If that does not help, send the details below to the person who gave you the app.` };
  }
  return { title, message: `${name} ran into a problem while starting.`, advice: `Start it again. If this keeps happening, reinstall ${name} or send the details below to the person who gave you the app.` };
}

// ---- Help > About

/** The two files of licences in the app's resource folder (scripts/collect-resources.ts puts them there). */
export const LICENCE_FILE = 'LICENSE.txt';
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';
export const NOTICES_BUTTON = 'Third-party notices';

export interface About {
  title: string;
  message: string;
  detail: string;
  /** 'OK' first; NOTICES_BUTTON when there is a notices file to open. */
  buttons: string[];
}

/**
 * The words of the About box. Plain text with no addresses in it: the app opens no links and has
 * to make sense offline. `licence` is the text of the app's own licence file (its first line names
 * the licence, a later one the copyright holder); `repository` is where the project the app is
 * built from lives, as product.json has it ("github:owner/name"). Photo Tool (by its name) says
 * when it uses the network and keeps no books.
 */
export function describeAbout(o: { productName: string; version: string; description: string; dataDir: string; licence: string | null; repository?: string; hasNotices: boolean }): About {
  const photoTool = isPhotoTool(o.productName);
  const lines = (o.licence ?? '').split(/\r?\n/).map((l) => l.trim());
  const licenceName = lines.find(Boolean)?.replace(/\blicense\b/i, 'licence');
  const copyright = lines.find((l) => /^copyright\b/i.test(l));
  const github = /^github:(.+)$/.exec(o.repository ?? '');
  const upstream = github ? `${github[1]} on GitHub` : o.repository?.replace(/^[a-z+]+:\/\//i, '');
  const credit = [
    upstream ? `Built from the open-source project ${upstream}${licenceName ? `, under the ${licenceName}` : ''}.` : licenceName ? `Free software under the ${licenceName}.` : '',
    copyright ?? '',
    o.hasNotices ? `It includes fonts and software from other projects, each under its own licence: see "${NOTICES_BUTTON}".` : '',
  ].filter(Boolean);
  return {
    title: `About ${o.productName}`,
    message: `${o.productName} ${o.version}`,
    detail: [o.description, photoTool ? `Everything stays on this computer. ${o.productName} uses the network only for OpenStreetMap map tiles, and only after you choose Load maps on the Map tab, and to download photo-tagging models from Hugging Face when you ask for one in Settings.` : `Everything stays on this computer. ${o.productName} never uses the network.`, photoTool ? `Its thumbnails and recent folders are kept in:\n${o.dataDir}` : `Your books are kept in:\n${o.dataDir}`, credit.join('\n')].filter(Boolean).join('\n\n'),
    buttons: o.hasNotices ? ['OK', NOTICES_BUTTON] : ['OK'],
  };
}
