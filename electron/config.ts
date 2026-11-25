// Start-up decisions that need no Electron: command-line flags, where data lives, the window's
// remembered place, and how a failed start is put into words. Unit-tested in tests/electron-shell.test.ts.
import { join, posix, resolve, win32 } from 'node:path';

// ---- command line

export interface SelfTestArgs {
  /** Folder of photos to import (the editor) or to open (the gallery, which opens a copy of it). */
  photos: string;
  /** Where result.json, the screenshots, the browser profile and the test's own data folder go. */
  out: string;
  /** Which program is tested: the editor, or with `--gallery` the gallery. */
  mode: AppMode;
}

/**
 * The self-test runs only when asked for by flag, with both folders given:
 *   --self-test <photo folder> --self-test-out <folder> [--gallery]
 */
export function parseSelfTest(argv: readonly string[]): SelfTestArgs | null {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && !v.startsWith('--') ? v : undefined;
  };
  const photos = value('--self-test');
  const out = value('--self-test-out');
  return photos && out ? { photos: resolve(photos), out: resolve(out), mode: parseMode(argv).mode } : null;
}

/**
 * Why the gallery's self-test must not run with these folders, or null when it may. It deletes and
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

/** The same build runs two programs: the editor, and with `--gallery` the photo gallery. */
export type AppMode = 'editor' | 'gallery';

/** The gallery's own name: its own data, Chromium profile and single-instance lock. */
export const GALLERY_PRODUCT_NAME = 'Photobook Gallery';

/**
 * The gallery's Windows AppUserModelID, so the taskbar keeps its windows apart from the editor's.
 * electron/installer.nsh gives the Gallery shortcuts the same one (tests/electron-shell.test.ts checks).
 */
export const GALLERY_APP_ID = 'app.photobookstudio.gallery';

/** `--gallery [folder]` starts the gallery (opening that folder); anything else, the editor. */
export function parseMode(argv: readonly string[]): { mode: AppMode; folder: string | null } {
  const i = argv.indexOf('--gallery');
  if (i < 0) return { mode: 'editor', folder: null };
  const v = argv[i + 1];
  return { mode: 'gallery', folder: v && !v.startsWith('--') ? v : null };
}

/**
 * How the editor starts the gallery: this same program with `--gallery`. From source that is
 * electron with the app folder. Run as an AppImage, execPath is the binary inside the editor's own
 * FUSE mount, which goes away when the editor quits, so the AppImage file itself ($APPIMAGE) is run.
 */
export function galleryLaunchCommand(o: { execPath: string; packaged: boolean; appPath: string; env: Record<string, string | undefined> }): { command: string; args: string[] } {
  if (o.env.APPIMAGE) return { command: o.env.APPIMAGE, args: ['--gallery'] };
  return { command: o.execPath, args: [...(o.packaged ? [] : [o.appPath]), '--gallery'] };
}

// ---- folders

export interface DataLayout {
  /** The app's books, thumbnails, exports and logs. */
  dataDir: string;
  /** Chromium's own files (cache, cookies, window state). Never inside dataDir. */
  profileDir: string;
}

/**
 * Per-user folders:
 *   <appData>/<name>/data      the app's data (PHOTOBOOK_DATA_DIR overrides it)
 *   <appData>/<name>/browser   Chromium's profile (PHOTOBOOK_PROFILE_DIR overrides it)
 * A copy run from source uses "<name> Dev", so development never touches an installed app's data.
 * A self-test keeps both inside its output folder (<out>/data and <out>/profile) unless they are
 * given explicitly: it must never write into a real user's books, and can run beside the installed app.
 */
export function dataLayout(o: { appData: string; productName: string; packaged: boolean; env: Record<string, string | undefined>; selfTestOut?: string }): DataLayout {
  const root = join(o.appData, o.packaged ? o.productName : `${o.productName} Dev`);
  const given = (v: string | undefined) => (v ? resolve(v) : null);
  return {
    dataDir: given(o.env.PHOTOBOOK_DATA_DIR) ?? (o.selfTestOut ? join(o.selfTestOut, 'data') : join(root, 'data')),
    profileDir: given(o.env.PHOTOBOOK_PROFILE_DIR) ?? (o.selfTestOut ? join(o.selfTestOut, 'profile') : join(root, 'browser')),
  };
}

/**
 * The environment the gallery's dataLayout reads. PHOTOBOOK_DATA_DIR and PHOTOBOOK_PROFILE_DIR
 * belong to the editor: shared, the gallery would write into the editor's data folder, and the
 * shared Chromium profile would make the two one single instance. The gallery's own are
 * PHOTOBOOK_GALLERY_DATA_DIR and PHOTOBOOK_GALLERY_PROFILE_DIR.
 */
export function galleryEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { PHOTOBOOK_DATA_DIR: env.PHOTOBOOK_GALLERY_DATA_DIR, PHOTOBOOK_PROFILE_DIR: env.PHOTOBOOK_GALLERY_PROFILE_DIR };
}

/** Where the gallery keeps photo info for read-only folders: the editor's, so a star reaches the editor. */
export function photoInfoFallbackDir(editorDataDir: string): string {
  return join(editorDataDir, 'photoinfo');
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
 * `mode` is the program that failed (the editor unless given): the gallery has no books to save.
 */
export function describeFailure(detail: string, ctx: { productName: string; dataDir: string; phase: 'start' | 'run' | 'page'; mode?: AppMode }): Failure {
  const name = ctx.productName;
  const gallery = ctx.mode === 'gallery';
  if (ctx.phase === 'run') {
    return {
      title: `${name} stopped working`,
      message: gallery
        ? `The part of ${name} that reads your photos stopped unexpectedly. Stars and notes up to your last change are saved.`
        : `The part of ${name} that saves your book stopped unexpectedly. Changes up to your last edit are saved.`,
      advice: `Restart ${name}. If this keeps happening, send the details below to the person who gave you the app.`,
    };
  }
  if (ctx.phase === 'page') {
    return {
      title: `${name} could not show the ${gallery ? 'gallery' : 'editor'}`,
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
 * built from lives, as product.json has it ("github:owner/name").
 */
export function describeAbout(o: { productName: string; version: string; description: string; dataDir: string; licence: string | null; repository?: string; hasNotices: boolean; mode?: AppMode }): About {
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
    detail: [o.description, o.mode === 'gallery' ? `Everything stays on this computer. ${o.productName} uses the network only for OpenStreetMap map tiles, and only after you choose Load maps on the Map tab, and to download photo-tagging models from Hugging Face when you ask for one in Settings.` : `Everything stays on this computer. ${o.productName} never uses the network.`, o.mode === 'gallery' ? `Its thumbnails and recent folders are kept in:\n${o.dataDir}` : `Your books are kept in:\n${o.dataDir}`, credit.join('\n')].filter(Boolean).join('\n\n'),
    buttons: o.hasNotices ? ['OK', NOTICES_BUTTON] : ['OK'],
  };
}
