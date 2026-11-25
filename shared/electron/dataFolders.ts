// Moving data to the programs' new names, once: Photobook Studio → Photobook Editor and Photobook
// Gallery → Photo Tool (each with " Dev" when run from source), and the editor's photo info for
// read-only folders (<editor data>/photoinfo) to the folder both programs share. A folder is only ever
// renamed, and only when the new one does not exist yet and no program is running from it: nothing is
// copied, merged or deleted. Unit-tested in shared/tests/data-folders.test.ts.
import { closeSync, existsSync, mkdirSync, openSync, readlinkSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataLayout, photoInfoFallbackDir, programFolder, type DataLayout, type ProgramNames } from './config';

/**
 * Which move failed: the program's own folder, the shared photo info, or (nothing tried) the
 * program's own folder because its new name is there already without data while the old one has some.
 */
export type CarryOverStep = 'data' | 'photoinfo' | 'new-folder-without-data';

/** A folder could not be moved (most often: a program is still running from it). */
export class CarryOverError extends Error {
  constructor(
    public from: string,
    public to: string,
    cause: unknown,
    public step: CarryOverStep = 'data',
  ) {
    super(`Could not move ${from} to ${to}: ${String((cause as Error)?.message ?? cause)}`, { cause });
    this.name = 'CarryOverError';
  }
}

export type CarryOverResult = 'moved' | 'nothing-to-move' | 'already-there';
type Rename = (a: string, b: string) => void;

/**
 * Rename `from` to `to` when `to` does not exist yet. `to` there already: both are left as they are
 * ('already-there'). `from` missing: nothing is made ('nothing-to-move'). A rename that fails throws a
 * CarryOverError and leaves `from` as it was.
 */
export function carryOver(from: string, to: string, rename: Rename = renameSync): CarryOverResult {
  if (existsSync(to)) return 'already-there';
  if (!existsSync(from)) return 'nothing-to-move';
  try {
    mkdirSync(dirname(to), { recursive: true });
    rename(from, to);
  } catch (e) {
    throw new CarryOverError(from, to, e);
  }
  return 'moved';
}

/** Is a process with this id running? EPERM means it is, but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Windows: is Chromium's `lockfile` held open by a running program? Opening it for reading and writing
 * (no truncation, nothing written) fails while the program that made it runs; a stale one opens.
 */
function windowsLockHeld(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    closeSync(openSync(file, 'r+'));
    return false;
  } catch (e) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException)?.code ?? '');
  }
}

export interface RunningSeams {
  platform?: NodeJS.Platform;
  /** Reads <root>/browser/SingletonLock (Linux, macOS): a symlink to "<host>-<pid>". */
  readLink?: (path: string) => string;
  isAlive?: (pid: number) => boolean;
  /** Windows: is <root>/browser/lockfile held by a running program? */
  lockHeld?: (path: string) => boolean;
}

/**
 * Is a program running from the program folder `root` (its Chromium profile is <root>/browser)?
 * Linux and macOS: Chromium's SingletonLock names the running process's id; a lock left by a process
 * that has ended does not count. Windows: Chromium's lockfile is held open while the program runs
 * (and a rename of a folder in use fails anyway).
 */
export function programRunning(root: string, o: RunningSeams = {}): boolean {
  const platform = o.platform ?? process.platform;
  const profile = join(root, 'browser');
  if (platform === 'win32') return (o.lockHeld ?? windowsLockHeld)(join(profile, 'lockfile'));
  let target: string;
  try {
    target = (o.readLink ?? readlinkSync)(join(profile, 'SingletonLock'));
  } catch {
    return false; // no lock: not running
  }
  const pid = /-(\d+)$/.exec(target)?.[1];
  return !!pid && (o.isAlive ?? pidAlive)(Number(pid));
}

/** The editor's photo info lives in its data folder under either of its names. */
const EDITOR_NAMES = ['Photobook Studio', 'Photobook Editor'];

/**
 * Everything a program moves before it starts:
 *   1) its own folder, <appData>/<old>[ Dev] → <appData>/<new>[ Dev];
 *   2) the editor's photo info, from whichever of <appData>/Photobook Studio[ Dev]/data/photoinfo and
 *      <appData>/Photobook Editor[ Dev]/data/photoinfo exists first, to the shared fallback.
 * Either program may start first; the end is the same. A folder a program is running from is never
 * moved: that step throws a CarryOverError (its `step` says which), as does a rename that fails.
 * Step 1 is done by then, so the next start retries only what is left. Step 1 also throws (step
 * 'new-folder-without-data') when the new folder is there without a data folder while the old one has
 * one: that new folder is a leftover stub, not the program in use, and is never merged into.
 *
 * Never in a test run, and never where the folders were chosen by hand: step 1 is 'skipped' when
 * ${envPrefix}_DATA_DIR or ${envPrefix}_PROFILE_DIR is set or a self-test runs, and step 2 when
 * PHOTOINFO_FALLBACK_DIR is set or a self-test runs.
 */
export function carryOverAll(o: {
  appData: string;
  packaged: boolean;
  oldProductName: string;
  productName: string;
  /** The program's environment prefix and environment: see the skips above. */
  envPrefix: string;
  env: Record<string, string | undefined>;
  selfTest?: boolean;
  rename?: Rename;
  running?: (root: string) => boolean;
}): { data: CarryOverResult | 'skipped'; photoinfo: CarryOverResult | 'skipped' } {
  if (o.oldProductName === o.productName) throw new Error(`carryOverAll: the old name and the new name are both "${o.productName}".`);
  const folder = (name: string) => programFolder(o.appData, name, o.packaged);
  const running = o.running ?? ((root: string) => programRunning(root));
  const busy = (from: string, to: string, root: string, step: CarryOverStep) => new CarryOverError(from, to, new Error(`a program is still running from ${root}`), step);

  let data: CarryOverResult | 'skipped' = 'skipped';
  if (!o.selfTest && !o.env[`${o.envPrefix}_DATA_DIR`] && !o.env[`${o.envPrefix}_PROFILE_DIR`]) {
    const from = folder(o.oldProductName);
    const to = folder(o.productName);
    // A new folder with no data in it (made by an earlier start that put only its browser profile
    // there) is not the program in use: reporting 'already-there' would strand the old data silently.
    if (existsSync(to) && !existsSync(join(to, 'data')) && existsSync(join(from, 'data'))) {
      throw new CarryOverError(from, to, new Error(`${to} is there already but holds no data, while ${from} does; nothing was moved`), 'new-folder-without-data');
    }
    if (!existsSync(to) && existsSync(from) && running(from)) throw busy(from, to, from, 'data');
    data = carryOver(from, to, o.rename);
  }

  let photoinfo: CarryOverResult | 'skipped' = 'skipped';
  if (!o.selfTest && !o.env.PHOTOINFO_FALLBACK_DIR) {
    const to = photoInfoFallbackDir({ appData: o.appData, packaged: o.packaged, env: o.env });
    const root = EDITOR_NAMES.map(folder).find((r) => existsSync(join(r, 'data', 'photoinfo')));
    if (!root) photoinfo = 'nothing-to-move';
    else {
      const from = join(root, 'data', 'photoinfo');
      if (!existsSync(to) && running(root)) throw busy(from, to, root, 'photoinfo');
      try {
        photoinfo = carryOver(from, to, o.rename);
      } catch (e) {
        throw e instanceof CarryOverError ? new CarryOverError(e.from, e.to, e.cause, 'photoinfo') : e;
      }
    }
  }
  return { data, photoinfo };
}

/** The variable that lets a self-test carry folders over; only honoured on a GitHub Actions runner. */
export const CI_SELF_TEST_CARRY_OVER = 'PHOTO_TOOLS_CI_SELF_TEST_CARRY_OVER';

/**
 * Does a self-test carry the old folders over, as an ordinary start does? Only in CI
 * (.github/workflows/desktop.yml), on a throwaway runner, where it proves the move in the packaged
 * program: both CI_SELF_TEST_CARRY_OVER=1 and GitHub Actions' own GITHUB_ACTIONS=true are needed.
 * Anywhere else a self-test never moves a folder (Ruling B).
 */
export function selfTestCarriesOver(env: Record<string, string | undefined>): boolean {
  return env[CI_SELF_TEST_CARRY_OVER] === '1' && env.GITHUB_ACTIONS === 'true';
}

/**
 * The start-up order runDesktopApp follows, so it can be tested: move the old folders first, and only
 * then hand Chromium its profile folder (`setUserData`). On a CarryOverError, `setUserData` is never
 * called with a real folder.
 */
export function prepareProgramFolders(o: {
  names: ProgramNames;
  appData: string;
  packaged: boolean;
  env: Record<string, string | undefined>;
  selfTestOut?: string;
  setUserData: (dir: string) => void;
  carry?: typeof carryOverAll;
}): { layout: DataLayout; photoInfoFallbackDir: string; carried: ReturnType<typeof carryOverAll> } {
  const base = { appData: o.appData, packaged: o.packaged, env: o.env };
  const carried = (o.carry ?? carryOverAll)({ ...base, oldProductName: o.names.oldProductName, productName: o.names.productName, envPrefix: o.names.envPrefix, selfTest: !!o.selfTestOut && !selfTestCarriesOver(o.env) });
  const layout = dataLayout({ ...base, productName: o.names.productName, envPrefix: o.names.envPrefix, selfTestOut: o.selfTestOut });
  o.setUserData(layout.profileDir);
  return { layout, photoInfoFallbackDir: photoInfoFallbackDir({ ...base, selfTestOut: o.selfTestOut }), carried };
}

/** The words of the "can't start yet" message, for the step that failed. Must be true as written. */
export function carryOverRefusal(names: ProgramNames, e: Pick<CarryOverError, 'from' | 'to' | 'step'>): { title: string; message: string } {
  const NAME = names.productName;
  const old = names.oldProductName;
  const paths = `\n\n${e.from}\n→ ${e.to}`;
  if (e.step === 'new-folder-without-data') {
    return {
      title: `${NAME} can't start yet`,
      message: `${NAME} is the new name of ${old}. The first time it starts, it moves ${old}'s data folder to its new name, but a folder with the new name is there already, and it holds no data (only browser settings), while ${old}'s folder does.\n\nTo carry ${old}'s data over, close ${NAME} and ${old}, delete or rename the new folder, then start ${NAME} again. Nothing was changed.\n\nOld folder, with the data:\n${e.from}\n\nNew folder, without data:\n${e.to}`,
    };
  }
  if (e.step === 'data') {
    return {
      title: `${NAME} can't start yet`,
      message: `${NAME} is the new name of ${old}. The first time it starts, it moves ${old}'s data folder to its new name, and it could not: ${old} may still be running.\n\nClose ${old}, then start ${NAME} again. Nothing was changed.${paths}`,
    };
  }
  return {
    title: `${NAME} can't start yet`,
    message: `${NAME}'s own data folder is in place, but the stars and notes kept for read-only photo folders could not be moved to the folder ${NAME} shares with the editor: Photobook Studio or Photobook Editor may still be running.\n\nClose Photobook Studio and Photobook Editor, then start ${NAME} again. The stars and notes were not changed.${paths}`,
  };
}
